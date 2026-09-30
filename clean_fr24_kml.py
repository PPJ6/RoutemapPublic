#!/usr/bin/env python3
"""Create minimal, standards-compliant KML files from Flightradar24 KML exports.

The output contains only:
  * the flight name
  * the flight date, when one can be found
  * the route coordinates: longitude, latitude, and altitude

Flightradar24 exports altitude in the KML coordinate tuples in meters, which is
also the unit required by KML. The values are therefore preserved, not
converted from the human-readable feet values in the HTML descriptions.

Examples:
    python clean_fr24_kml.py flight.kml
    python clean_fr24_kml.py *.kml --output-dir cleaned
    python clean_fr24_kml.py downloads/ --recursive --output-dir cleaned
    python clean_fr24_kml.py flight.kml --in-place
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable, Iterator, Optional, Sequence, Tuple
from xml.etree import ElementTree as ET

KML_NS = "http://www.opengis.net/kml/2.2"
DATE_RE = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")

ET.register_namespace("", KML_NS)


@dataclass(frozen=True)
class CleanResult:
    input_path: Path
    output_path: Path
    flight_name: str
    flight_date: Optional[str]
    coordinate_count: int


def qname(local_name: str) -> str:
    """Return a tag name in the KML 2.2 namespace."""
    return f"{{{KML_NS}}}{local_name}"


def local_name(tag: object) -> str:
    """Return the namespace-free portion of an ElementTree tag."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def elements_named(root: ET.Element, name: str) -> Iterator[ET.Element]:
    for element in root.iter():
        if local_name(element.tag) == name:
            yield element


def direct_child_text(parent: ET.Element, child_name: str) -> Optional[str]:
    for child in parent:
        if local_name(child.tag) == child_name and child.text:
            value = child.text.strip()
            if value:
                return value
    return None


def extract_flight_name(root: ET.Element, input_path: Path) -> str:
    """Prefer Document/name, then a non-date Placemark/name, then the filename."""
    for document in elements_named(root, "Document"):
        value = direct_child_text(document, "name")
        if value:
            return value

    for placemark in elements_named(root, "Placemark"):
        value = direct_child_text(placemark, "name")
        if value and not DATE_RE.search(value):
            return value

    return input_path.stem


def valid_iso_date(value: str) -> Optional[date]:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def extract_flight_date(root: ET.Element) -> Optional[str]:
    """Return the earliest standard KML timestamp date, with a text fallback."""
    timestamp_dates = []
    for when in elements_named(root, "when"):
        for match in DATE_RE.finditer(when.text or ""):
            parsed = valid_iso_date(match.group(1))
            if parsed is not None:
                timestamp_dates.append(parsed)

    if timestamp_dates:
        return min(timestamp_dates).isoformat()

    # Some exports put the date only in a name or an HTML description.
    fallback_dates = []
    for text in root.itertext():
        for match in DATE_RE.finditer(text):
            parsed = valid_iso_date(match.group(1))
            if parsed is not None:
                fallback_dates.append(parsed)

    return min(fallback_dates).isoformat() if fallback_dates else None


def normalize_number(raw_value: str) -> str:
    """Validate a coordinate number and render it without needless zeros."""
    value = raw_value.strip()
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid coordinate number: {raw_value!r}") from exc

    if not number.is_finite():
        raise ValueError(f"Non-finite coordinate number: {raw_value!r}")

    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in {"-0", "+0", ""}:
        rendered = "0"
    return rendered


def parse_kml_coordinates(text: str) -> list[Tuple[str, ...]]:
    """Parse whitespace-separated KML lon,lat[,alt] coordinate tuples."""
    parsed: list[Tuple[str, ...]] = []
    for token in text.split():
        fields = [field.strip() for field in token.split(",")]
        while fields and fields[-1] == "":
            fields.pop()

        if len(fields) not in (2, 3):
            raise ValueError(f"Invalid KML coordinate tuple: {token!r}")

        normalized = tuple(normalize_number(field) for field in fields)
        parsed.append(normalized)
    return parsed


def parse_gx_coordinate(text: str) -> Tuple[str, ...]:
    """Parse a gx:coord value (space-separated lon lat alt)."""
    fields = text.split()
    if len(fields) not in (2, 3):
        raise ValueError(f"Invalid gx:coord value: {text!r}")
    return tuple(normalize_number(field) for field in fields)


def find_route_folder(root: ET.Element) -> Optional[ET.Element]:
    for folder in elements_named(root, "Folder"):
        name = direct_child_text(folder, "name")
        if name and name.casefold() == "route":
            return folder
    return None


def coordinates_from_points(scope: ET.Element) -> list[Tuple[str, ...]]:
    coordinates: list[Tuple[str, ...]] = []
    for point in elements_named(scope, "Point"):
        for child in point.iter():
            if local_name(child.tag) == "coordinates" and child.text:
                coordinates.extend(parse_kml_coordinates(child.text))
                break
    return coordinates


def coordinates_from_lines(scope: ET.Element) -> list[Tuple[str, ...]]:
    """Flatten LineStrings, removing only duplicated segment boundary points."""
    coordinates: list[Tuple[str, ...]] = []
    for line in elements_named(scope, "LineString"):
        for child in line.iter():
            if local_name(child.tag) == "coordinates" and child.text:
                for coordinate in parse_kml_coordinates(child.text):
                    if not coordinates or coordinate != coordinates[-1]:
                        coordinates.append(coordinate)
                break
    return coordinates


def coordinates_from_gx_track(scope: ET.Element) -> list[Tuple[str, ...]]:
    coordinates: list[Tuple[str, ...]] = []
    for coord in elements_named(scope, "coord"):
        if coord.text and coord.text.strip():
            coordinates.append(parse_gx_coordinate(coord.text))
    return coordinates


def extract_coordinates(root: ET.Element) -> list[Tuple[str, ...]]:
    """Prefer FR24's Route points and avoid its duplicated Trail geometry."""
    route_folder = find_route_folder(root)

    if route_folder is not None:
        coordinates = coordinates_from_points(route_folder)
        if coordinates:
            return coordinates

        coordinates = coordinates_from_lines(route_folder)
        if coordinates:
            return coordinates

        coordinates = coordinates_from_gx_track(route_folder)
        if coordinates:
            return coordinates

    # Generic KML fallbacks for files that do not use an FR24 Route folder.
    coordinates = coordinates_from_points(root)
    if coordinates:
        return coordinates

    coordinates = coordinates_from_lines(root)
    if coordinates:
        return coordinates

    coordinates = coordinates_from_gx_track(root)
    if coordinates:
        return coordinates

    raise ValueError("No Point, LineString, or gx:Track coordinates were found")


def indent_xml(tree: ET.ElementTree) -> None:
    """Pretty-print on Python 3.9+, with a small fallback for Python 3.8."""
    if hasattr(ET, "indent"):
        ET.indent(tree, space="  ")
        return

    def indent_element(element: ET.Element, level: int = 0) -> None:
        whitespace = "\n" + "  " * level
        child_whitespace = "\n" + "  " * (level + 1)
        if len(element):
            if not element.text or not element.text.strip():
                element.text = child_whitespace
            for child in element:
                indent_element(child, level + 1)
            if not element[-1].tail or not element[-1].tail.strip():
                element[-1].tail = whitespace
        if level and (not element.tail or not element.tail.strip()):
            element.tail = whitespace

    indent_element(tree.getroot())


def build_minimal_kml(
    flight_name: str,
    flight_date: Optional[str],
    coordinates: Sequence[Tuple[str, ...]],
) -> ET.ElementTree:
    root = ET.Element(qname("kml"))
    document = ET.SubElement(root, qname("Document"))
    placemark = ET.SubElement(document, qname("Placemark"))

    ET.SubElement(placemark, qname("name")).text = flight_name

    if flight_date:
        timestamp = ET.SubElement(placemark, qname("TimeStamp"))
        ET.SubElement(timestamp, qname("when")).text = flight_date

    line_string = ET.SubElement(placemark, qname("LineString"))
    # This standard KML field is necessary so clients use the altitude values.
    ET.SubElement(line_string, qname("altitudeMode")).text = "absolute"

    coordinate_element = ET.SubElement(line_string, qname("coordinates"))
    coordinate_element.text = "\n          " + "\n          ".join(
        ",".join(coordinate) for coordinate in coordinates
    ) + "\n        "

    tree = ET.ElementTree(root)
    indent_xml(tree)
    return tree


def atomic_write_xml(tree: ET.ElementTree, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    target_mode = (
        stat.S_IMODE(output_path.stat().st_mode) if output_path.exists() else 0o644
    )
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=str(output_path.parent)
    )
    try:
        with os.fdopen(fd, "wb") as temporary_file:
            tree.write(
                temporary_file,
                encoding="utf-8",
                xml_declaration=True,
                short_empty_elements=True,
            )
        os.chmod(temporary_name, target_mode)
        os.replace(temporary_name, output_path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def clean_file(
    input_path: Path,
    output_path: Path,
    *,
    overwrite: bool,
) -> CleanResult:
    if not input_path.is_file():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    same_file = input_path.resolve() == output_path.resolve()
    if output_path.exists() and not (overwrite or same_file):
        raise FileExistsError(
            f"Output already exists: {output_path} (use --overwrite to replace it)"
        )

    try:
        source_tree = ET.parse(input_path)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid XML/KML in {input_path}: {exc}") from exc

    source_root = source_tree.getroot()
    flight_name = extract_flight_name(source_root, input_path)
    flight_date = extract_flight_date(source_root)
    coordinates = extract_coordinates(source_root)

    output_tree = build_minimal_kml(flight_name, flight_date, coordinates)
    atomic_write_xml(output_tree, output_path)

    return CleanResult(
        input_path=input_path,
        output_path=output_path,
        flight_name=flight_name,
        flight_date=flight_date,
        coordinate_count=len(coordinates),
    )


def collect_input_files(paths: Iterable[Path], recursive: bool) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            pattern = "**/*.kml" if recursive else "*.kml"
            files.extend(sorted(candidate for candidate in path.glob(pattern) if candidate.is_file()))
        else:
            files.append(path)

    # Keep the user's order while avoiding accidental duplicate processing.
    unique_files: list[Path] = []
    seen = set()
    for path in files:
        key = str(path.resolve())
        if key not in seen:
            seen.add(key)
            unique_files.append(path)
    return unique_files


def output_path_for(
    input_path: Path,
    *,
    output_dir: Optional[Path],
    suffix: str,
    in_place: bool,
) -> Path:
    if in_place:
        return input_path
    directory = output_dir if output_dir is not None else input_path.parent
    return directory / f"{input_path.stem}{suffix}.kml"


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Remove Flightradar24 HTML, styles, icons, speed/heading data, and "
            "duplicated trail geometry, leaving a minimal standard KML route."
        )
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        type=Path,
        help="KML files or directories containing KML files",
    )
    parser.add_argument(
        "-d",
        "--output-dir",
        type=Path,
        help="write cleaned files to this directory (default: beside each input)",
    )
    parser.add_argument(
        "--suffix",
        default="-clean",
        help="filename suffix for cleaned files (default: -clean)",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="search input directories recursively",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="replace each input file atomically instead of creating a new file",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="replace an existing cleaned output file",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)

    if args.in_place and args.output_dir is not None:
        parser.error("--in-place cannot be combined with --output-dir")
    if not args.in_place and args.suffix == "":
        parser.error("--suffix may be empty only when --in-place is used")

    input_files = collect_input_files(args.inputs, args.recursive)
    if not input_files:
        parser.error("no KML input files were found")

    failures = 0
    for input_path in input_files:
        output_path = output_path_for(
            input_path,
            output_dir=args.output_dir,
            suffix=args.suffix,
            in_place=args.in_place,
        )
        try:
            result = clean_file(
                input_path,
                output_path,
                overwrite=args.overwrite or args.in_place,
            )
        except (OSError, ValueError) as exc:
            failures += 1
            print(f"ERROR: {input_path}: {exc}", file=sys.stderr)
            continue

        date_text = result.flight_date or "date unavailable"
        print(
            f"Wrote {result.output_path} | {result.flight_name} | "
            f"{date_text} | {result.coordinate_count} coordinates"
        )

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
