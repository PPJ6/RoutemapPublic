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
  routeCount: "#routeCount",
  legend: "#carrierLegend"
};

const projection = d3.geoEqualEarth()
  .fitSize([width, height], { type: "Sphere" });

const path = d3.geoPath(projection);

const layers = {
  base: svg.append("g").attr("class", "base-layer"),
  routes: svg.append("g").attr("class", "route-layer"),
  airports: svg.append("g").attr("class", "airport-layer")
};

const filters = {
  year: "All",
  carrier: "All",
  aircraft: "All",
  alliance: "All",
  aircraftMake: "All"
};

let allianceColor = d3.scaleOrdinal(d3.schemeTableau10);
let aircraftMakeDash = new Map();

let lockedRouteKey = null;
let lockedRouteGroup = null;
let lockedTooltipPoint = null;

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

    route.origin_iata = cleanText(route.origin_iata || route.origin || route["Origin IATA"]);
    route.dest_iata = cleanText(route.dest_iata || route.destination || route.dest || route["Destination IATA"]);

    route.carrier_code = cleanText(route.carrier_code || route.carrier || route["Carrier Code"] || "Unknown");
    route.carrier_name = cleanText(route.carrier_name || route.airline || route["Carrier Name"] || route.carrier_code);

    route.carrier_alliance = normalizeAlliance(
      route.carrier_alliance ||
      route.airline_alliance ||
      route.alliance ||
      route["Carrier Alliance"] ||
      route["Alliance"] ||
      "Unaffiliated"
    );

    route.aircraft_type = cleanText(route.aircraft_type || route.aircraft || route["Aircraft Type"] || "Unknown");

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

    route.year = cleanText(route.year || route["Year"] || "Unknown");

    route.origin_lat = Number(route.origin_lat);
    route.origin_lon = Number(route.origin_lon);
    route.dest_lat = Number(route.dest_lat);
    route.dest_lon = Number(route.dest_lon);
  });
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
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

 

  const preferredAllianceColors = new Map([
    ["Star Alliance", "#222222"],
    ["oneworld", "#1f77b4"],
    ["SkyTeam", "#d62728"],
    ["Unaffiliated", "#7f7f7f"],
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
}

function sortAllianceValues(a, b) {
  const order = ["Star Alliance", "oneworld", "SkyTeam", "Unaffiliated", "Multiple"];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);

  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  }

  return a.localeCompare(b);
}

function setupFilters(routes) {
  populateSelect(selectors.year, uniqueValues(routes, d => d.year).sort((a, b) => Number(b) - Number(a)));
  populateSelect(selectors.carrier, uniqueValues(routes, d => d.carrier_code).sort());
  populateSelect(selectors.aircraft, uniqueValues(routes, d => d.aircraft_type).sort());
  populateSelect(selectors.alliance, uniqueValues(routes, allianceKey).sort(sortAllianceValues));
  populateSelect(selectors.aircraftMake, uniqueValues(routes, aircraftMakeKey).sort());

  d3.select(selectors.year).on("change", event => {
    filters.year = event.target.value;
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

    d3.select(selectors.year).property("value", "All");
    d3.select(selectors.carrier).property("value", "All");
    d3.select(selectors.aircraft).property("value", "All");
    d3.select(selectors.alliance).property("value", "All");
    d3.select(selectors.aircraftMake).property("value", "All");

    updateRoutes(routes);
  });
}

function populateSelect(selector, values) {
  const select = d3.select(selector);

  if (select.empty()) {
    console.warn(`Missing select element: ${selector}`);
    return;
  }

  select.selectAll("option")
    .data(["All", ...values])
    .join("option")
    .attr("value", d => d)
    .text(d => d);
}

function updateRoutes(routes) {
  const visibleRoutes = routes.filter(routeMatchesFilters);
  const validVisibleRoutes = visibleRoutes.filter(hasValidCoordinates);
  const routeGroups = makeRouteGroups(validVisibleRoutes);
  const allRouteGroups = makeRouteGroups(routes.filter(hasValidCoordinates));

  if (lockedRouteKey && !routeGroups.some(group => group.key === lockedRouteKey)) {
    clearLockedTooltip();
  }

  const routeSelection = layers.routes.selectAll("path.route")
    .data(routeGroups, d => d.key)
    .join(
      enter => enter.append("path")
        .attr("class", "route")
        .on("mouseenter", routeMouseEnter)
        .on("mousemove", routeMouseMove)
        .on("mouseleave", routeMouseLeave)
        .on("click", routeMouseClick),
      update => update,
      exit => exit.remove()
    );

  routeSelection
    .attr("d", d => path(makeGreatCircleFeature(d)))
    .style("stroke", d => allianceColor(d.carrier_alliance))
    .style("stroke-dasharray", d => aircraftMakeDash.get(d.aircraft_make) || "none")
    .style("stroke-width", null)
    .style("stroke-opacity", null)
    .classed("is-hovered", false)
    .classed("is-selected", d => d.key === lockedRouteKey);

  updateRouteCount(routeGroups.length, allRouteGroups.length, validVisibleRoutes.length, routes.length);
  updateMapLegend(routeGroups);
  updateAirportDots(validVisibleRoutes);
}

function routeMatchesFilters(route) {
  return (
    (filters.year === "All" || String(route.year) === String(filters.year)) &&
    (filters.carrier === "All" || route.carrier_code === filters.carrier) &&
    (filters.aircraft === "All" || route.aircraft_type === filters.aircraft) &&
    (filters.alliance === "All" || allianceKey(route) === filters.alliance) &&
    (filters.aircraftMake === "All" || aircraftMakeKey(route) === filters.aircraftMake)
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
    return group;
  });
}

function routeDirectionalKey(route) {
  return `${route.origin_iata}|${route.dest_iata}`;
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

function makeGreatCircleFeature(routeGroup) {
  const start = [routeGroup.origin_lon, routeGroup.origin_lat];
  const end = [routeGroup.dest_lon, routeGroup.dest_lat];
  const interpolate = d3.geoInterpolate(start, end);

  return {
    type: "Feature",
    properties: routeGroup,
    geometry: {
      type: "LineString",
      coordinates: d3.range(0, 1.001, 0.02).map(interpolate)
    }
  };
}

function routeMouseEnter(event, routeGroup) {
  d3.select(event.currentTarget)
    .raise()
    .classed("is-hovered", true)
    .style("stroke", "#d62728")
    .style("stroke-width", 3.5)
    .style("stroke-opacity", 1)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");

  showTooltipFromEvent(event, routeGroup, false);
}

function routeMouseMove(event, routeGroup) {
  if (lockedRouteKey === routeGroup.key) {
    return;
  }

  showTooltipFromEvent(event, routeGroup, false);
}

function routeMouseLeave(event, routeGroup) {
  const routePath = d3.select(event.currentTarget);

  if (lockedRouteKey === routeGroup.key) {
    applySelectedRouteStyle(routePath, routeGroup);
    return;
  }

  routePath
    .classed("is-hovered", false)
    .classed("is-selected", false)
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

  layers.routes.selectAll("path.route")
    .classed("is-selected", d => d.key === lockedRouteKey)
    .each(function(d) {
      const routePath = d3.select(this);

      if (d.key === lockedRouteKey) {
        applySelectedRouteStyle(routePath, d);
      } else {
        routePath
          .classed("is-hovered", false)
          .style("stroke", allianceColor(d.carrier_alliance))
          .style("stroke-width", null)
          .style("stroke-opacity", null)
          .style("stroke-dasharray", aircraftMakeDash.get(d.aircraft_make) || "none");
      }
    });

  showTooltipAtPoint(lockedTooltipPoint, routeGroup, true);
}

function applySelectedRouteStyle(routePath, routeGroup) {
  routePath
    .classed("is-hovered", false)
    .classed("is-selected", true)
    .style("stroke", "#d62728")
    .style("stroke-width", 3.5)
    .style("stroke-opacity", 1)
    .style("stroke-dasharray", aircraftMakeDash.get(routeGroup.aircraft_make) || "none");
}

function clearLockedTooltip() {
  lockedRouteKey = null;
  lockedRouteGroup = null;
  lockedTooltipPoint = null;

  layers.routes.selectAll("path.route")
    .classed("is-selected", false)
    .each(function(d) {
      d3.select(this)
        .style("stroke", allianceColor(d.carrier_alliance))
        .style("stroke-width", null)
        .style("stroke-opacity", null)
        .style("stroke-dasharray", aircraftMakeDash.get(d.aircraft_make) || "none");
    });

  tooltip.attr("hidden", true);
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
  const origin = escapeHtml(routeGroup.origin_iata);
  const dest = escapeHtml(routeGroup.dest_iata);
  const routeTitle = `${origin} → ${dest}`;
  const originName = escapeHtml(routeGroup.origin_name || routeGroup.origin_city || "");
  const destName = escapeHtml(routeGroup.dest_name || routeGroup.dest_city || "");
  const allianceText = escapeHtml(formatValueList(routeGroup.records, allianceKey));
  const flightCount = routeGroup.records.length;

  const closeButton = locked
    ? `<button class="tooltip-close" type="button" data-tooltip-close aria-label="Close tooltip">×</button>`
    : "";

  return `
    <div class="tooltip-header">
      <strong>${routeTitle}</strong>
      ${closeButton}
    </div>
    <div class="tooltip-route-name">${originName} to ${destName}</div>
    <div><strong>Alliance:</strong> ${allianceText}</div>
    <div><strong>${flightCount === 1 ? "Flight" : "Flights"}:</strong> ${flightCount}</div>
    <div class="tooltip-flight-list">
      ${routeGroup.records.map(formatFlightForTooltip).join("")}
    </div>
  `;
}

function formatFlightForTooltip(route) {
  const flightLabel = escapeHtml(route.flight_no || `${route.origin_iata} → ${route.dest_iata}`);
  const carrier = escapeHtml(route.carrier_name || route.carrier_code || "Unknown carrier");
  const year = escapeHtml(route.year || "Unknown year");
  const aircraftType = escapeHtml(route.aircraft_type || "Unknown aircraft");
  const reviewLine = formatReviewLine(route);

  return `
    <div class="tooltip-flight">
      <div><strong>${flightLabel}</strong> · ${year}</div>
      <div>${carrier} · ${aircraftType}</div>
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
