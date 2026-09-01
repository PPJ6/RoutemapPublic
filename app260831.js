const width = 1200;
const height = 650;

const svg = d3.select("#map");
const tooltip = d3.select("#tooltip");
const mapWrap = document.getElementById("mapWrap");

const selectors = {
  year: "#yearFilter",
  carrier: "#carrierFilter",
  aircraft: "#aircraftFilter",
  alliance: "#allianceFilter",
  aircraftMake: "#aircraftMakeFilter",
  region: "#regionFilter",
  routeCount: "#routeCount",
  mileageCounter: "#mileageCounter",
  legend: "#carrierLegend"
};

const projection = d3.geoEqualEarth()
  .fitSize([width, height], { type: "Sphere" });

const path = d3.geoPath(projection);

const layers = {
  base: svg.append("g").attr("class", "base-layer"),
  focus: svg.append("g").attr("class", "focus-layer"),
  routes: svg.append("g").attr("class", "route-layer"),
  airports: svg.append("g").attr("class", "airport-layer")
};

const filters = {
  year: "All",
  carrier: "All",
  aircraft: "All",
  alliance: "All",
  aircraftMake: "All",
  region: "All regions"
};

const regionDefinitions = [
  {
    key: "All regions",
    label: "All regions",
    isWorld: true,
    rotate: [0, 0, 0]
  },
  {
    key: "North America",
    label: "North America",
    west: -170,
    east: -50,
    south: 7,
    north: 85,
    rotate: [105, 0, 0]
  },
  {
    key: "Central and South America",
    label: "Central and South America",
    west: -120,
    east: -30,
    south: -60,
    north: 35,
    rotate: [75, 0, 0]
  },
  {
    key: "Oceania",
    label: "Oceania",
    west: 95,
    east: 240,
    south: -55,
    north: 30,
    rotate: [-165, 0, 0]
  },
  {
    key: "Asia",
    label: "Asia",
    west: 25,
    east: 180,
    south: -12,
    north: 82,
    rotate: [-95, 0, 0]
  },
  {
    key: "Europe",
    label: "Europe",
    west: -25,
    east: 45,
    south: 34,
    north: 72,
    rotate: [-15, 0, 0]
  },
  {
    key: "Africa",
    label: "Africa",
    west: -20,
    east: 55,
    south: -38,
    north: 38,
    rotate: [-20, 0, 0]
  }
];

const regionByKey = new Map(
  regionDefinitions.map(region => [region.key, region])
);

let currentRegionKey = "All regions";

let allianceColor = d3.scaleOrdinal(d3.schemeTableau10);
let aircraftMakeDash = new Map();

let lockedRouteKey = null;
let lockedRouteGroup = null;
let lockedTooltipPoint = null;

let historicalRouteGroupsAll = [];
let historicalRouteGroupsByKey = new Map();

svg.on("click", () => {
  clearLockedTooltip();
});

tooltip.on("click", event => {
  event.stopPropagation();

  const closeButton = event.target.closest
    ? event.target.closest("[data-tooltip-close]")
    : null;

  if (closeButton) {
    clearLockedTooltip();
  }
});

Promise.all([
  d3.json("data/world.json"),
  d3.json("data/routes.json")
])
  .then(([world, routes]) => {
    if (!world || !world.features) {
      throw new Error("world.json loaded, but it does not appear to contain GeoJSON features.");
    }

    if (!Array.isArray(routes)) {
      throw new Error("routes.json loaded, but it is not an array of route records.");
    }

    normalizeRoutes(routes);
    validateRoutes(routes);
    setupRouteEncodings(routes);
    buildHistoricalRouteIndex(routes);

    drawBaseMap(world);
    setupFilters(routes);
    updateRoutes(routes);
  })
  .catch(error => {
    console.error("Map failed to load:", error);
    showMapError(error);
  });

function drawBaseMap(world) {
  layers.base.append("path")
    .datum({ type: "Sphere" })
    .attr("class", "ocean")
    .attr("d", path);

  layers.base.selectAll("path.country")
    .data(world.features)
    .join("path")
    .attr("class", "country")
    .attr("d", path);
}

function normalizeRoutes(routes) {
  routes.forEach((route, index) => {
    route._rowIndex = index;

    route.origin_iata = cleanText(
      route.origin_iata ||
      route.origin ||
      route["Origin IATA"]
    );

    route.dest_iata = cleanText(
      route.dest_iata ||
      route.destination ||
      route.dest ||
      route["Destination IATA"]
    );

    route.carrier_code = cleanText(
      route.carrier_code ||
      route.carrier ||
      route["Carrier Code"] ||
      "Unknown"
    );

    route.carrier_name = cleanText(
      route.carrier_name ||
      route.airline ||
      route["Carrier Name"] ||
      route.carrier_code
    );

    route.carrier_alliance = normalizeAlliance(
      route.carrier_alliance ||
      route.airline_alliance ||
      route.alliance ||
      route["Carrier Alliance"] ||
      route["Alliance"] ||
      "Unaffiliated"
    );

    route.aircraft_type = cleanText(
      route.aircraft_type ||
      route.aircraft ||
      route["Aircraft Type"] ||
      "Unknown"
    );

    route.aircraft_make = cleanText(
      route.aircraft_make ||
      route.aircraft_manufacturer ||
      route.make ||
      route["Aircraft Make"] ||
      inferAircraftMake(route.aircraft_type) ||
      "Unknown"
    );

    route.review_url = cleanText(
      route.review_url ||
      route.youtube_url ||
      route.video_url ||
      route["Review URL"] ||
      route["YouTube URL"]
    );

    route.review_title = cleanText(
      route.review_title ||
      route.video_title ||
      route["Review Title"] ||
      "Watch review"
    );

    route.flight_no = cleanText(
      route.flight_no ||
      route.flight_number ||
      route.flight ||
      route["Flight No"] ||
      route["Flight Number"]
    );

    route.year = cleanText(
      route.year ||
      route["Year"] ||
      "Unknown"
    );

    route.origin_lat = toNumber(route.origin_lat);
    route.origin_lon = toNumber(route.origin_lon);
    route.dest_lat = toNumber(route.dest_lat);
    route.dest_lon = toNumber(route.dest_lon);

    route.route_miles = firstValidNumber([
      route.route_miles,
      route.distance_miles,
      route.great_circle_miles,
      route.great_circle_distance_miles,
      route.gc_miles,
      route.distance_mi,
      route.miles,
      route["Route Miles"],
      route["Distance Miles"],
      route["Great Circle Miles"]
    ]);

    if (!Number.isFinite(route.route_miles) && hasValidCoordinates(route)) {
      route.route_miles = calculateGreatCircleMiles(route);
    }
  });
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return NaN;
  }

  const cleaned = String(value).trim().replace(/,/g, "");

  if (!cleaned) {
    return NaN;
  }

  return Number(cleaned);
}

function firstValidNumber(values) {
  for (const value of values) {
    const number = toNumber(value);

    if (Number.isFinite(number)) {
      return number;
    }
  }

  return NaN;
}

function calculateGreatCircleMiles(route) {
  const radiusMiles = 3958.7613;

  const lat1 = toRadians(route.origin_lat);
  const lon1 = toRadians(route.origin_lon);
  const lat2 = toRadians(route.dest_lat);
  const lon2 = toRadians(route.dest_lon);

  const deltaLat = lat2 - lat1;
  const deltaLon = lon2 - lon1;

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return radiusMiles * c;
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function normalizeAlliance(value) {
  const text = cleanText(value);

  if (!text) {
    return "Unaffiliated";
  }

  const lower = text.toLowerCase();

  if (["none", "no alliance", "unaffiliated", "independent", "n/a", "na"].includes(lower)) {
    return "Unaffiliated";
  }

  if (lower.includes("star")) {
    return "Star Alliance";
  }

  if (lower.includes("skyteam")) {
    return "SkyTeam";
  }

  if (lower.includes("oneworld") || lower.includes("one world")) {
    return "oneworld";
  }

  return text;
}

function inferAircraftMake(aircraftType) {
  const type = cleanText(aircraftType).toUpperCase().replace(/\s+/g, "");

  if (!type) {
    return "Unknown";
  }

  if (/^A\d/.test(type) || type.startsWith("A3") || type.startsWith("A2")) {
    return "Airbus";
  }

  if (type.startsWith("B") || /^7\d{2}/.test(type)) {
    return "Boeing";
  }

  if (type.startsWith("E") || type.startsWith("ERJ")) {
    return "Embraer";
  }

  if (type.startsWith("CRJ") || type.startsWith("CL")) {
    return "Bombardier/MHIRJ";
  }

  if (type.startsWith("AT")) {
    return "ATR";
  }

  if (type.startsWith("DH") || type.startsWith("DHC") || type.startsWith("Q4")) {
    return "De Havilland Canada";
  }

  if (type.startsWith("C") && /C9|C10|C11|C919|C909/.test(type)) {
    return "COMAC";
  }

  return "Unknown";
}

function validateRoutes(routes) {
  const invalidRoutes = routes.filter(route => {
    return (
      !route.origin_iata ||
      !route.dest_iata ||
      !Number.isFinite(route.origin_lat) ||
      !Number.isFinite(route.origin_lon) ||
      !Number.isFinite(route.dest_lat) ||
      !Number.isFinite(route.dest_lon)
    );
  });

  if (invalidRoutes.length > 0) {
    console.warn("Some routes have missing or invalid airport data:", invalidRoutes.slice(0, 10));
  }
}

function setupRouteEncodings(routes) {
  const alliances = uniqueValues(routes, allianceKey).sort(sortAllianceValues);

  if (!alliances.includes("Multiple")) {
    alliances.push("Multiple");
  }

  const preferredAllianceColors = new Map([
    ["Star Alliance", "#222222"],
    ["oneworld", "#1f77b4"],
    ["SkyTeam", "#d62728"],
    ["Unaffiliated", "#7f7f7f"],
    ["Multiple", "#9467bd"]
  ]);

  const fallbackColors = d3.schemeTableau10;

  allianceColor = d3.scaleOrdinal()
    .domain(alliances)
    .range(alliances.map((alliance, index) => {
      return preferredAllianceColors.get(alliance) || fallbackColors[index % fallbackColors.length];
    }));

  const makes = uniqueValues(routes, aircraftMakeKey).sort();

  if (!makes.includes("Multiple")) {
    makes.push("Multiple");
  }

  const dashPatterns = [
    "none",
    "8 4",
    "3 3",
    "10 4 2 4",
    "2 5",
    "14 4",
    "6 2 2 2",
    "1 4"
  ];

  aircraftMakeDash = new Map(
    makes.map((make, index) => [make, dashPatterns[index % dashPatterns.length]])
  );

  aircraftMakeDash.set("Multiple", "6 2 2 2");
}

function buildHistoricalRouteIndex(routes) {
  historicalRouteGroupsAll = makeRouteGroups(routes.filter(hasValidCoordinates));
  applyOppositeDirectionMetadata(historicalRouteGroupsAll);

  historicalRouteGroupsByKey = new Map(
    historicalRouteGroupsAll.map(group => [group.key, group])
  );
}

function sortAllianceValues(a, b) {
  const order = ["Star Alliance", "oneworld", "SkyTeam", "Unaffiliated", "Multiple"];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);

  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  }

  return String(a).localeCompare(String(b));
}

function sortYearValues(a, b) {
  const numberA = Number(a);
  const numberB = Number(b);

  if (Number.isFinite(numberA) && Number.isFinite(numberB)) {
    return numberB - numberA;
  }

  if (Number.isFinite(numberA)) {
    return -1;
  }

  if (Number.isFinite(numberB)) {
    return 1;
  }

  return String(a).localeCompare(String(b));
}

function setupFilters(routes) {
  populateSelect(selectors.year, uniqueValues(routes, d => d.year).sort(sortYearValues));
  populateSelect(selectors.carrier, uniqueValues(routes, d => d.carrier_code).sort());
  populateSelect(selectors.aircraft, uniqueValues(routes, d => d.aircraft_type).sort());
  populateSelect(selectors.alliance, uniqueValues(routes, allianceKey).sort(sortAllianceValues));
  populateSelect(selectors.aircraftMake, uniqueValues(routes, aircraftMakeKey).sort());
  populateSelect(selectors.region, regionDefinitions.map(region => region.label), false);
  d3.select(selectors.year).on("change", event => {
    filters.year = event.target.value;
    updateRoutes(routes);
  });

d3.select(selectors.region).on("change", event => {
  filters.region = event.target.value;
  updateRoutes(routes);
});

  d3.select(selectors.carrier).on("change", event => {
    filters.carrier = event.target.value;
    updateRoutes(routes);
  });

  d3.select(selectors.aircraft).on("change", event => {
    filters.aircraft = event.target.value;
    updateRoutes(routes);
  });

  d3.select(selectors.alliance).on("change", event => {
    filters.alliance = event.target.value;
    updateRoutes(routes);
  });

  d3.select(selectors.aircraftMake).on("change", event => {
    filters.aircraftMake = event.target.value;
    updateRoutes(routes);
  });

  d3.select("#resetFilters").on("click", () => {
    filters.year = "All";
    filters.carrier = "All";
    filters.aircraft = "All";
    filters.alliance = "All";
    filters.aircraftMake = "All";
    filters.region = "All regions";
    d3.select(selectors.year).property("value", "All");
    d3.select(selectors.carrier).property("value", "All");
    d3.select(selectors.aircraft).property("value", "All");
    d3.select(selectors.alliance).property("value", "All");
    d3.select(selectors.aircraftMake).property("value", "All");
    d3.select(selectors.region).property("value", "All regions");
    updateRoutes(routes);
  });
}

function populateSelect(selector, values, includeAll = true) {
  const select = d3.select(selector);

  if (select.empty()) {
    console.warn(`Missing select element: ${selector}`);
    return;
  }

  const optionValues = includeAll ? ["All", ...values] : values;

  select.selectAll("option")
    .data(optionValues)
    .join("option")
    .attr("value", d => d)
    .text(d => d);
}

function updateRoutes(routes) {
 updateProjectionForCurrentRegion(true);
  const visibleRoutes = routes.filter(routeMatchesFilters);
  const validVisibleRoutes = visibleRoutes.filter(hasValidCoordinates);
  const allValidRoutes = routes.filter(hasValidCoordinates);

  const routeGroups = makeRouteGroups(validVisibleRoutes);
  applyOppositeDirectionMetadata(routeGroups);

  const allRouteGroups = historicalRouteGroupsAll.length > 0
    ? historicalRouteGroupsAll
    : makeRouteGroups(allValidRoutes);

  refreshLockedTooltip(routeGroups);


const routeSelection = layers.routes.selectAll("g.route-group")
  .data(routeGroups, d => d.key)
  .join(
    enter => {
      const group = enter.append("g")
        .attr("class", "route-group")
        .on("mouseenter", routeMouseEnter)
        .on("mousemove", routeMouseMove)
        .on("mouseleave", routeMouseLeave)
        .on("click", routeMouseClick);

      group.append("path")
        .attr("class", "route-faded");

      group.append("path")
        .attr("class", "route-main");

      group.append("path")
        .attr("class", "route-hit");

      return group;
    },
    update => update,
    exit => exit.remove()
  );

routeSelection
  .attr("transform", d => routeOffsetTransform(d))
  .classed("is-hovered", false)
  .classed("is-selected", d => d.key === lockedRouteKey)
  .classed("has-opposite-direction", d => d.hasOppositeDirection);

routeSelection.each(function(routeGroup) {
  const group = d3.select(this);
  const segments = splitRouteByCurrentRegion(routeGroup);

  const insideFeature = multiLineFeature(segments.inside, routeGroup);
  const outsideFeature = multiLineFeature(segments.outside, routeGroup);
  const fullFeature = makeGreatCircleFeature(routeGroup);

  group.select("path.route-main")
    .datum(routeGroup)
    .transition()
    .duration(650)
    .ease(d3.easeCubicOut)
    .attr("d", insideFeature ? path(insideFeature) : null)
    .style("stroke", allianceColor(routeGroup.carrier_alliance))
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  group.select("path.route-faded")
    .datum(routeGroup)
    .transition()
    .duration(650)
    .ease(d3.easeCubicOut)
    .attr("d", outsideFeature ? path(outsideFeature) : null)
    .style("stroke", allianceColor(routeGroup.carrier_alliance))
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  group.select("path.route-hit")
    .datum(routeGroup)
    .transition()
    .duration(650)
    .ease(d3.easeCubicOut)
    .attr("d", path(fullFeature));
});

routeSelection.each(function(d) {
  if (d.key === lockedRouteKey) {
    applySelectedRouteStyle(d3.select(this), d);
  }
});

  const visibleMiles = sumDisplayedMiles(validVisibleRoutes);

  updateRouteCount(
    routeGroups.length,
    allRouteGroups.length,
    validVisibleRoutes.length,
    allValidRoutes.length
  );

  updateMileageCounter(visibleMiles);
  updateMapLegend(routeGroups);
  updateAirportDots(validVisibleRoutes);
}

function routeMatchesFilters(route) {
  return (
    (filters.year === "All" || String(route.year) === String(filters.year)) &&
    (filters.carrier === "All" || route.carrier_code === filters.carrier) &&
    (filters.aircraft === "All" || route.aircraft_type === filters.aircraft) &&
    (filters.alliance === "All" || allianceKey(route) === filters.alliance) &&
    (filters.aircraftMake === "All" || aircraftMakeKey(route) === filters.aircraftMake) &&
    routeTouchesCurrentRegion(route)
  );
}

function hasValidCoordinates(route) {
  return (
    Number.isFinite(route.origin_lat) &&
    Number.isFinite(route.origin_lon) &&
    Number.isFinite(route.dest_lat) &&
    Number.isFinite(route.dest_lon)
  );
}

function makeRouteGroups(routes) {
  const groups = new Map();

  routes.forEach(route => {
    const key = routeDirectionalKey(route);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        origin_iata: route.origin_iata,
        origin_name: route.origin_name,
        origin_city: route.origin_city,
        origin_state: route.origin_state,
        origin_country: route.origin_country,
        origin_lat: route.origin_lat,
        origin_lon: route.origin_lon,
        dest_iata: route.dest_iata,
        dest_name: route.dest_name,
        dest_city: route.dest_city,
        dest_state: route.dest_state,
        dest_country: route.dest_country,
        dest_lat: route.dest_lat,
        dest_lon: route.dest_lon,
        records: []
      });
    }

    groups.get(key).records.push(route);
  });

  return Array.from(groups.values()).map(group => {
    group.records.sort(sortFlightRecords);
    group.carrier_alliance = summarizeGroupValue(group.records, allianceKey);
    group.aircraft_make = summarizeGroupValue(group.records, aircraftMakeKey);
    group.total_miles = sumDisplayedMiles(group.records);
    return group;
  });
}

function routeDirectionalKey(route) {
  return `${route.origin_iata}|${route.dest_iata}`;
}

function unorderedRoutePairKey(routeGroup) {
  return [routeGroup.origin_iata, routeGroup.dest_iata]
    .sort()
    .join("|");
}

function applyOppositeDirectionMetadata(routeGroups) {
  const groupsByPair = d3.group(routeGroups, unorderedRoutePairKey);

  routeGroups.forEach(group => {
    const pairGroups = groupsByPair.get(unorderedRoutePairKey(group)) || [];

    group.pairGroups = pairGroups
      .slice()
      .sort(sortRouteGroupsForTooltip);

    group.hasOppositeDirection = group.pairGroups.length > 1;

    /*
      Important:
      Use the same offset magnitude for both directional paths.
      Because the path vector reverses for the opposite direction,
      the same offset value shifts the two directions to opposite sides.
    */
    group.directionOffset = group.hasOppositeDirection ? 5 : 0;
  });
}

function routeOffsetTransform(routeGroup) {
  if (!routeGroup.directionOffset) {
    return null;
  }

  const start = projection([routeGroup.origin_lon, routeGroup.origin_lat]);
  const end = projection([routeGroup.dest_lon, routeGroup.dest_lat]);

  if (!start || !end) {
    return null;
  }

  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);

  if (!length) {
    return null;
  }

  const offset = routeGroup.directionOffset;
  const normalX = (-dy / length) * offset;
  const normalY = (dx / length) * offset;

  return `translate(${normalX},${normalY})`;
}

function summarizeGroupValue(records, accessor) {
  const values = uniqueValues(records, accessor).sort();

  if (values.length === 0) {
    return "Unknown";
  }

  if (values.length === 1) {
    return values[0];
  }

  return "Multiple";
}

function sortFlightRecords(a, b) {
  return String(a.year).localeCompare(String(b.year)) ||
    String(a.carrier_code).localeCompare(String(b.carrier_code)) ||
    String(a.flight_no).localeCompare(String(b.flight_no)) ||
    String(a.aircraft_type).localeCompare(String(b.aircraft_type));
}

function sortRouteGroupsForTooltip(a, b) {
  return String(a.origin_iata).localeCompare(String(b.origin_iata)) ||
    String(a.dest_iata).localeCompare(String(b.dest_iata));
}

function makeGreatCircleCoordinates(routeGroup) {
  const start = [routeGroup.origin_lon, routeGroup.origin_lat];
  const end = [routeGroup.dest_lon, routeGroup.dest_lat];
  const interpolate = d3.geoInterpolate(start, end);

  return d3.range(0, 1.0001, 0.01).map(interpolate);
}

function makeGreatCircleFeature(routeGroup) {
  return {
    type: "Feature",
    properties: routeGroup,
    geometry: {
      type: "LineString",
      coordinates: makeGreatCircleCoordinates(routeGroup)
    }
  };
}

function splitRouteByCurrentRegion(routeGroup) {
  const coordinates = makeGreatCircleCoordinates(routeGroup);

  if (isWorldRegion()) {
    return {
      inside: [coordinates],
      outside: []
    };
  }

  const insideSegments = [];
  const outsideSegments = [];

  let currentSegment = [];
  let currentInside = null;

  coordinates.forEach(coord => {
    const isInside = coordinateIsInCurrentRegion(coord[0], coord[1]);

    if (currentInside === null) {
      currentInside = isInside;
      currentSegment = [coord];
      return;
    }

    if (isInside === currentInside) {
      currentSegment.push(coord);
      return;
    }

    if (currentSegment.length > 1) {
      if (currentInside) {
        insideSegments.push(currentSegment);
      } else {
        outsideSegments.push(currentSegment);
      }
    }

    currentSegment = [
      currentSegment[currentSegment.length - 1],
      coord
    ];

    currentInside = isInside;
  });

  if (currentSegment.length > 1) {
    if (currentInside) {
      insideSegments.push(currentSegment);
    } else {
      outsideSegments.push(currentSegment);
    }
  }

  return {
    inside: insideSegments,
    outside: outsideSegments
  };
}

function multiLineFeature(segments, properties = {}) {
  const usableSegments = segments.filter(segment => segment.length > 1);

  if (usableSegments.length === 0) {
    return null;
  }

  return {
    type: "Feature",
    properties,
    geometry: {
      type: "MultiLineString",
      coordinates: usableSegments
    }
  };
}

function routeMouseEnter(event, routeGroup) {
  const group = d3.select(event.currentTarget);

  group
    .raise()
    .classed("is-hovered", true);

  group.select("path.route-main")
    .style("stroke", "#d62728")
    .style("stroke-width", 3.5)
    .style("stroke-opacity", 1);

  group.select("path.route-faded")
    .style("stroke", "#d62728")
    .style("stroke-width", 2.6)
    .style("stroke-opacity", 0.35);

  if (lockedRouteKey === routeGroup.key && lockedTooltipPoint) {
    showTooltipAtPoint(lockedTooltipPoint, lockedRouteGroup || routeGroup, true);
    return;
  }

  showTooltipFromEvent(event, routeGroup, false);
}

function routeMouseMove(event, routeGroup) {
  if (lockedRouteKey === routeGroup.key) {
    return;
  }

  showTooltipFromEvent(event, routeGroup, false);
}

function routeMouseLeave(event, routeGroup) {
  const group = d3.select(event.currentTarget);

  if (lockedRouteKey === routeGroup.key) {
    applySelectedRouteStyle(group, routeGroup);

    if (lockedTooltipPoint) {
      showTooltipAtPoint(lockedTooltipPoint, lockedRouteGroup || routeGroup, true);
    }

    return;
  }

  group
    .classed("is-hovered", false)
    .classed("is-selected", false);

  group.select("path.route-main")
    .style("stroke", allianceColor(routeGroup.carrier_alliance))
    .style("stroke-width", null)
    .style("stroke-opacity", null)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  group.select("path.route-faded")
    .style("stroke", allianceColor(routeGroup.carrier_alliance))
    .style("stroke-width", null)
    .style("stroke-opacity", null)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  if (lockedRouteGroup && lockedTooltipPoint) {
    showTooltipAtPoint(lockedTooltipPoint, lockedRouteGroup, true);
  } else {
    tooltip.attr("hidden", true);
  }
}

function routeMouseClick(event, routeGroup) {
  event.stopPropagation();

  lockedRouteKey = routeGroup.key;
  lockedRouteGroup = routeGroup;
  lockedTooltipPoint = d3.pointer(event, mapWrap);

  layers.routes.selectAll("g.route-group")
    .classed("is-selected", d => d.key === lockedRouteKey)
    .each(function(d) {
      const group = d3.select(this);

      if (d.key === lockedRouteKey) {
        applySelectedRouteStyle(group, d);
      } else {
        restoreRouteGroupStyle(group, d);
      }
    });

  showTooltipAtPoint(lockedTooltipPoint, routeGroup, true);
}

function applySelectedRouteStyle(group, routeGroup) {
  group
    .classed("is-hovered", false)
    .classed("is-selected", true);

  group.select("path.route-main")
    .style("stroke", "#d62728")
    .style("stroke-width", 3.5)
    .style("stroke-opacity", 1)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  group.select("path.route-faded")
    .style("stroke", "#d62728")
    .style("stroke-width", 2.6)
    .style("stroke-opacity", 0.35)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");
}

function clearLockedTooltip() {
  lockedRouteKey = null;
  lockedRouteGroup = null;
  lockedTooltipPoint = null;

  layers.routes.selectAll("g.route-group")
    .classed("is-selected", false)
    .each(function(d) {
      restoreRouteGroupStyle(d3.select(this), d);
    });

  tooltip.attr("hidden", true);
}

function restoreRouteGroupStyle(group, routeGroup) {
  group
    .classed("is-hovered", false)
    .classed("is-selected", false);

  group.select("path.route-main")
    .style("stroke", allianceColor(routeGroup.carrier_alliance))
    .style("stroke-width", null)
    .style("stroke-opacity", null)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  group.select("path.route-faded")
    .style("stroke", allianceColor(routeGroup.carrier_alliance))
    .style("stroke-width", null)
    .style("stroke-opacity", null)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");
}

function refreshLockedTooltip(routeGroups) {
  if (!lockedRouteKey) {
    return;
  }

  const refreshedLockedGroup = routeGroups.find(group => group.key === lockedRouteKey);

  if (!refreshedLockedGroup) {
    clearLockedTooltip();
    return;
  }

  lockedRouteGroup = refreshedLockedGroup;

  if (lockedTooltipPoint) {
    showTooltipAtPoint(lockedTooltipPoint, lockedRouteGroup, true);
  }
}

function showTooltipFromEvent(event, routeGroup, locked) {
  const point = d3.pointer(event, mapWrap);

  if (locked) {
    lockedTooltipPoint = point;
  }

  showTooltipAtPoint(point, routeGroup, locked);
}

function showTooltipAtPoint(point, routeGroup, locked) {
  tooltip
    .attr("hidden", null)
    .classed("is-locked", locked)
    .style("left", `${point[0] + 14}px`)
    .style("top", `${point[1] + 14}px`)
    .html(buildTooltipHtml(routeGroup, locked));
}

function buildTooltipHtml(routeGroup, locked) {
  const tooltipGroups = getTooltipGroups(routeGroup);
  const allRecords = tooltipGroups.flatMap(group => group.records);

  const origin = escapeHtml(routeGroup.origin_iata);
  const dest = escapeHtml(routeGroup.dest_iata);

  const title = tooltipGroups.length > 1
    ? `${origin} ↔ ${dest}`
    : `${origin} → ${dest}`;

  const allianceLabel = uniqueValues(allRecords, allianceKey).length === 1
    ? "Alliance"
    : "Alliances";

  const allianceText = escapeHtml(formatValueList(allRecords, allianceKey));
  const flightCount = allRecords.length;
  const totalMiles = Math.round(sumDisplayedMiles(allRecords)).toLocaleString("en-US");

  const closeButton = locked
    ? `<button class="tooltip-close" type="button" data-tooltip-close aria-label="Close tooltip">×</button>`
    : "";

  const oppositeDirectionNote = tooltipGroups.length > 1
    ? `<div class="tooltip-pair-note">
        Historically flown in both directions. Each direction is listed separately below.
      </div>`
    : "";

  return `
    <div class="tooltip-header">
      <strong>${title}</strong>
      ${closeButton}
    </div>

    <div><strong>${allianceLabel}:</strong> ${allianceText}</div>
    <div><strong>${flightCount === 1 ? "Historical flight segment" : "Historical flight segments"}:</strong> ${flightCount}</div>
    <div><strong>Historical miles:</strong> ${totalMiles} mi</div>

    ${oppositeDirectionNote}

    <div class="tooltip-flight-list">
      ${tooltipGroups.map(group => {
        return formatDirectionGroupForTooltip(group, group.key === routeGroup.key);
      }).join("")}
    </div>
  `;
}

function getTooltipGroups(routeGroup) {
  const historicalRouteGroup = historicalRouteGroupsByKey.get(routeGroup.key) || routeGroup;

  const pairGroups = historicalRouteGroup.pairGroups && historicalRouteGroup.pairGroups.length > 0
    ? historicalRouteGroup.pairGroups
    : [historicalRouteGroup];

  return [
    historicalRouteGroup,
    ...pairGroups.filter(group => group.key !== historicalRouteGroup.key)
  ];
}

function formatDirectionGroupForTooltip(group, isSelectedDirection) {
  const origin = escapeHtml(group.origin_iata);
  const dest = escapeHtml(group.dest_iata);
  const originName = escapeHtml(group.origin_name || group.origin_city || "");
  const destName = escapeHtml(group.dest_name || group.dest_city || "");

  const selectedTag = isSelectedDirection
    ? `<span class="tooltip-direction-tag">selected</span>`
    : `<span class="tooltip-direction-tag">opposite</span>`;

  return `
    <div class="tooltip-direction-group ${isSelectedDirection ? "is-selected" : ""}">
      <div class="tooltip-direction-heading">
        <strong>${origin} → ${dest}</strong>
        ${group.hasOppositeDirection ? selectedTag : ""}
      </div>

      <div class="tooltip-route-name">${originName} to ${destName}</div>

      ${group.records.map(formatFlightForTooltip).join("")}
    </div>
  `;
}

function formatFlightForTooltip(route) {
  const flightLabel = escapeHtml(route.flight_no || `${route.origin_iata} → ${route.dest_iata}`);
  const carrier = escapeHtml(route.carrier_name || route.carrier_code || "Unknown carrier");
  const alliance = escapeHtml(route.carrier_alliance || "Unaffiliated");
  const year = escapeHtml(route.year || "Unknown year");
  const aircraftType = escapeHtml(route.aircraft_type || "Unknown aircraft");
  const routeMiles = Math.round(getRouteMiles(route)).toLocaleString("en-US");
  const reviewLine = formatReviewLine(route);

  return `
    <div class="tooltip-flight">
      <div><strong>${flightLabel}</strong> · ${year}</div>
      <div>${carrier} · ${alliance} · ${aircraftType}</div>
      <div><strong>Miles:</strong> ${routeMiles} mi</div>
      <div>${reviewLine}</div>
    </div>
  `;
}

function formatReviewLine(route) {
  const url = cleanText(route.review_url);
  const title = escapeHtml(route.review_title || "Watch review");

  if (isSafeHttpUrl(url)) {
    return `<strong>Review:</strong> <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
  }

  return `<strong>Review:</strong> <span class="review-missing">No review link yet</span>`;
}

function isSafeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function formatValueList(records, accessor) {
  const values = uniqueValues(records, accessor).sort(sortAllianceValues);

  if (values.length === 0) {
    return "Unknown";
  }

  return values.join(", ");
}

function sumDisplayedMiles(routeRecords) {
  return d3.sum(routeRecords, route => {
    const miles = getRouteMiles(route);
    return Number.isFinite(miles) ? miles : 0;
  });
}

function getRouteMiles(route) {
  return Number.isFinite(route.route_miles) ? route.route_miles : 0;
}

function updateRouteCount(visibleRouteCount, totalRouteCount, visibleFlightCount, totalFlightCount) {
  const routeCount = d3.select(selectors.routeCount);

  if (routeCount.empty()) {
    return;
  }

  routeCount.text(
    `Showing ${visibleRouteCount.toLocaleString()} of ${totalRouteCount.toLocaleString()} routes · ` +
    `${visibleFlightCount.toLocaleString()} of ${totalFlightCount.toLocaleString()} flights`
  );
}

function updateMileageCounter(miles) {
  const counter = d3.select(selectors.mileageCounter);

  if (counter.empty()) {
    return;
  }

  const roundedMiles = Number.isFinite(miles) ? Math.round(miles) : 0;
  const formatted = roundedMiles.toLocaleString("en-US");

  counter
    .attr("aria-label", `${formatted} miles flown`)
    .html(
      formatted
        .split("")
        .map(char => {
          if (char === ",") {
            return `<span class="splitflap-separator">,</span>`;
          }

          return `<span class="splitflap-char">${escapeHtml(char)}</span>`;
        })
        .join("")
    );
}

function updateMapLegend(routeGroups) {
  const legend = d3.select(selectors.legend);

  if (legend.empty()) {
    return;
  }

  legend.html("");
  legend.classed("is-empty", routeGroups.length === 0);

  if (routeGroups.length === 0) {
    return;
  }

  const visibleAlliances = uniqueValues(routeGroups, d => d.carrier_alliance).sort(sortAllianceValues);
  const visibleMakes = uniqueValues(routeGroups, d => d.aircraft_make).sort();

  renderLegendSection({
    legend,
    title: "Alliance color",
    values: visibleAlliances,
    strokeForValue: value => allianceColor(value),
    dashForValue: () => "none"
  });

}

function renderLegendSection({ legend, title, values, strokeForValue, dashForValue }) {
  const section = legend.append("div")
    .attr("class", "legend-section");

  section.append("div")
    .attr("class", "legend-title")
    .text(title);

  const items = section.append("div")
    .attr("class", "legend-items")
    .selectAll("div.legend-item")
    .data(values, d => d)
    .join("div")
    .attr("class", "legend-item");

  const sample = items.append("svg")
    .attr("class", "legend-line-sample")
    .attr("viewBox", "0 0 42 10")
    .attr("aria-hidden", "true");

  sample.append("line")
    .attr("x1", 2)
    .attr("y1", 5)
    .attr("x2", 40)
    .attr("y2", 5)
    .style("stroke", d => strokeForValue(d))
    .style("stroke-dasharray", d => dashForValue(d));

  items.append("span")
    .attr("class", "legend-label")
    .text(d => d);
}



function getVisibleAirports(visibleRoutes) {
  const airports = new Map();

  visibleRoutes.forEach(route => {
    addAirport(airports, {
      iata: route.origin_iata,
      name: route.origin_name,
      city: route.origin_city,
      state: route.origin_state,
      country: route.origin_country,
      lat: route.origin_lat,
      lon: route.origin_lon
    });

    addAirport(airports, {
      iata: route.dest_iata,
      name: route.dest_name,
      city: route.dest_city,
      state: route.dest_state,
      country: route.dest_country,
      lat: route.dest_lat,
      lon: route.dest_lon
    });
  });

  return Array.from(airports.values());
}

function addAirport(airports, airport) {
  const iata = airport.iata;
  const lat = Number(airport.lat);
  const lon = Number(airport.lon);

  if (!iata || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return;
  }

  if (!airports.has(iata)) {
    airports.set(iata, {
      ...airport,
      iata,
      lat,
      lon
    });
  }
}

function getCurrentRegionDefinition() {
  return regionByKey.get(filters.region) || regionByKey.get("All regions");
}


function updateAirportDots(visibleRoutes) {
  const visibleAirports = getVisibleAirports(visibleRoutes)
    .map(airport => ({
      ...airport,
      point: projection([airport.lon, airport.lat])
    }))
    .filter(airport => airport.point);

  const airportGroups = layers.airports.selectAll("g.airport")
    .data(visibleAirports, d => d.iata)
    .join(
      enter => {
        const group = enter.append("g")
          .attr("class", "airport");

        group.append("circle")
          .attr("r", 3.2);

        return group;
      },
      update => update,
      exit => exit.remove()
    );

  airportGroups
    .attr("transform", d => `translate(${d.point[0]},${d.point[1]})`);
}
  };
}

const REGION_FOCUS_PADDING = 35;

function getCurrentRegionDefinition() {
  return regionByKey.get(filters.region) || regionByKey.get("All regions");
}

function updateProjectionForCurrentRegion(animate = true) {
  const region = getCurrentRegionDefinition();

  currentRegionKey = region.key;

  projection.rotate(region.rotate || [0, 0, 0]);

  if (region.isWorld) {
    projection.fitExtent(
      [[0, 0], [width, height]],
      { type: "Sphere" }
    );
  } else {
    projection.fitExtent(
      [
        [REGION_FOCUS_PADDING, REGION_FOCUS_PADDING],
        [width - REGION_FOCUS_PADDING, height - REGION_FOCUS_PADDING]
      ],
      regionToGeoJsonFeature(region)
    );
  }

  function countryTouchesRegion(feature, region) {
  if (region.isWorld) {
    return true;
  }

  const bounds = d3.geoBounds(feature);

  if (!bounds || !bounds[0] || !bounds[1]) {
    return false;
  }

  const countryWest = bounds[0][0];
  const countrySouth = bounds[0][1];
  const countryEast = bounds[1][0];
  const countryNorth = bounds[1][1];

  if (countryNorth < region.south || countrySouth > region.north) {
    return false;
  }

  return longitudeRangesOverlap(countryWest, countryEast, region.west, region.east);
}

function longitudeRangesOverlap(westA, eastA, westB, eastB) {
  const rangesA = splitLongitudeRange(westA, eastA);
  const rangesB = splitLongitudeRange(westB, eastB);

  return rangesA.some(a => {
    return rangesB.some(b => {
      return a.west <= b.east && b.west <= a.east;
    });
  });
}

function splitLongitudeRange(west, east) {
  /*
    Handles ranges that cross the antimeridian.
    Example: Oceania may be 95 to 240, which becomes:
    95 to 180 and -180 to -120.
  */
  if (east > 180) {
    return [
      { west, east: 180 },
      { west: -180, east: east - 360 }
    ];
  }

  if (west < -180) {
    return [
      { west: west + 360, east: 180 },
      { west: -180, east }
    ];
  }

  if (east < west) {
    return [
      { west, east: 180 },
      { west: -180, east }
    ];
  }

  return [
    { west, east }
  ];
}f
  updateBaseMapProjection(region, animate);
  updateRegionFocusBoundary(region, animate);

  // Helpful while debugging.
  // If this value does not change when selecting a region,
  // something is resetting the projection later.
  console.log("Region:", region.key, "Projection scale:", projection.scale());
}

function regionToGeoJsonFeature(region) {
  if (region.isWorld) {
    return { type: "Sphere" };
  }

  /*
    Most regions are simple boxes.
    Oceania crosses the antimeridian, so it is split into two boxes.
  */
  if (region.east <= 180) {
    return {
      type: "Feature",
      properties: {
        name: region.label
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          makeRegionBoxRing(region.west, region.east, region.south, region.north)
        ]
      }
    };
  }

  const wrappedEast = region.east - 360;

  return {
    type: "Feature",
    properties: {
      name: region.label
    },
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          makeRegionBoxRing(region.west, 180, region.south, region.north)
        ],
        [
          makeRegionBoxRing(-180, wrappedEast, region.south, region.north)
        ]
      ]
    }
  };
}

function makeRegionBoxRing(west, east, south, north) {
  const step = 2;
  const ring = [];

  for (const lon of rangeInclusive(west, east, step)) {
    ring.push([lon, south]);
  }

  for (const lat of rangeInclusive(south, north, step).slice(1)) {
    ring.push([east, lat]);
  }

  for (const lon of rangeInclusive(east, west, step).slice(1)) {
    ring.push([lon, north]);
  }

  for (const lat of rangeInclusive(north, south, step).slice(1)) {
    ring.push([west, lat]);
  }

  ring.push([west, south]);

  return ring;
}

function rangeInclusive(start, end, step) {
  const values = [];
  const direction = end >= start ? 1 : -1;
  const signedStep = Math.abs(step) * direction;

  let value = start;

  if (direction > 0) {
    while (value < end) {
      values.push(value);
      value += signedStep;
    }
  } else {
    while (value > end) {
      values.push(value);
      value += signedStep;
    }
  }

  values.push(end);

  return values;
}

function updateBaseMapProjection(region, animate = true) {
  const ocean = layers.base.selectAll("path.ocean");
  const countries = layers.base.selectAll("path.country");

  ocean.classed("is-region-focused", !region.isWorld);

  countries
    .classed("is-inside-focus", d => !region.isWorld && countryTouchesRegion(d, region))
    .classed("is-outside-focus", d => !region.isWorld && !countryTouchesRegion(d, region));

  if (region.isWorld) {
    countries
      .classed("is-inside-focus", false)
      .classed("is-outside-focus", false);
  }

  const paths = layers.base.selectAll("path");

  if (animate) {
    paths
      .transition()
      .duration(650)
      .ease(d3.easeCubicOut)
      .attr("d", path);
  } else {
    paths.attr("d", path);
  }
}

function updateRegionFocusBoundary(region, animate = true) {
  const boundaryData = region.isWorld
    ? []
    : [regionToGeoJsonFeature(region)];

  const boundary = layers.focus.selectAll("path.region-focus-boundary")
    .data(boundaryData);

  boundary.exit().remove();

  const merged = boundary.enter()
    .append("path")
    .attr("class", "region-focus-boundary")
    .merge(boundary);

  if (animate) {
    merged
      .transition()
      .duration(650)
      .ease(d3.easeCubicOut)
      .attr("d", path);
  } else {
    merged.attr("d", path);
  }
}
function isWorldRegion() {
  return getCurrentRegionDefinition().isWorld;
}

function coordinateIsInCurrentRegion(lon, lat) {
  const region = getCurrentRegionDefinition();

  if (region.isWorld) {
    return true;
  }

  return coordinateIsInRegion(lon, lat, region);
}

function coordinateIsInRegion(lon, lat, region) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return false;
  }

  if (lat < region.south || lat > region.north) {
    return false;
  }

  const adjustedLon = normalizeLongitudeForRegion(lon, region);
  return adjustedLon >= region.west && adjustedLon <= region.east;
}

function normalizeLongitudeForRegion(lon, region) {
  if (region.east > 180 && lon < 0) {
    return lon + 360;
  }

  return lon;
}

function routeTouchesCurrentRegion(route) {
  if (isWorldRegion()) {
    return true;
  }

  return (
    coordinateIsInCurrentRegion(route.origin_lon, route.origin_lat) ||
    coordinateIsInCurrentRegion(route.dest_lon, route.dest_lat)
  );
}

function uniqueValues(data, accessor) {
  return Array.from(new Set(data.map(accessor).filter(Boolean)));
}

function allianceKey(route) {
  return route.carrier_alliance || "Unaffiliated";
}

function aircraftMakeKey(route) {
  return route.aircraft_make || "Unknown";
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function showMapError(error) {
  svg.selectAll("*").remove();

  svg.append("text")
    .attr("x", 40)
    .attr("y", 60)
    .attr("font-size", 24)
    .attr("font-weight", 700)
    .text("Map failed to load");

  svg.append("text")
    .attr("x", 40)
    .attr("y", 95)
    .attr("font-size", 16)
    .text(error.message || String(error));

  svg.append("text")
    .attr("x", 40)
    .attr("y", 125)
    .attr("font-size", 14)
    .text("Open the browser console for the full error.");
}
