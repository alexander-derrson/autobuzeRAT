// ============================================================
// API CONFIGURATION
// ============================================================

const API_URLS = [
  {
    operator: "RAT Craiova",
    name: "RAT Craiova",
    url: "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53/transport/planner/vehicles",
    routesUrl: "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53/transport/planner/routes",
    stopsUrl: "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53/transport/planner/stops"
  }
];


// ============================================================
// GLOBAL VARIABLES
// ============================================================

let VEHICLES = {};
let ROUTES = {};

let allVehicles = [];

let markers = {};

// Route chosen in the "Route" dropdown: { operator, routeId },
// or null when "All routes" is selected
let selectedRoute = null;

// Route lines and stops (loaded from the API)
let PATTERNS = {};
let ROUTE_META = {};
let STOPS = {};

// Timetable per stop, fetched when a stop popup is opened
let STOP_TIMES = {};
const STOP_TIMES_TTL = 20000;

let selectedVehicleKey = null;
let drawnPatternKey = null;
let transportDataPromise = null;

// Stop markers by "operator|stopId" (used for visibility + stop search)
let stopMarkers = {};

// Keys of the stops on the selected route (null = no route selected)
let selectedRouteStopKeys = null;

// Stop that must stay on the map even if it would normally be hidden:
// the one picked from the search box, until its popup is closed
let pinnedStopKey = null;

// Searchable list of stops, built once stops + route patterns are loaded
let STOP_INDEX = [];
let transportReady = false;

// Status bar
let shownVehicleCount = 0;
let lastUpdateTime = null;
let routeNote = "";

// Lets a newer route selection cancel an older one that is still loading
let routeDrawToken = 0;




// ============================================================
// MAP
// ============================================================

const map = L.map("map").setView(
  [44.321, 23.800],
  13
);

const iconOptions = { iconSize: [75, 65], iconAnchor: [35, 32], popupAnchor: [0, -32] };

const MARKER_ICONS = {
  bus:  L.icon({ iconUrl: 'markerBus.png',  ...iconOptions }),
  tram: L.icon({ iconUrl: 'markerTram.png', ...iconOptions })
};

L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }
).addTo(map);

// Layer that holds the drawn route line + stops of the selected vehicle / stop
const routeLayer = L.layerGroup().addTo(map);

// Dedicated pane so that line sits above the general stops
map.createPane("routePane").style.zIndex = 450;

// Layer for the route picked in the "Route" dropdown. Its panes sit BELOW
// the stops (overlayPane = 400), so the stop dots stay on top and clickable.
const selectedRouteLayer = L.layerGroup().addTo(map);
map.createPane("selectedRouteCasingPane").style.zIndex = 380;
map.createPane("selectedRoutePane").style.zIndex = 390;

// Layer with the stop markers. Which of them are actually on the map is
// decided by updateStopsVisibility().
const STOP_MIN_ZOOM = 14;
const STOP_FOCUS_ZOOM = 17;
const stopsLayer = L.layerGroup().addTo(map);

// Stop dots: white with a thin black outline, thicker when selected
const STOP_STYLE = {
  radius: 5,
  color: "#000000",
  weight: 1,
  fillColor: "#ffffff",
  fillOpacity: 1
};

const STOP_STYLE_SELECTED = {
  ...STOP_STYLE,
  weight: 4
};

map.on("zoomend", updateStopsVisibility);

// Stop whose popup is currently open (so it can refresh live)
let openStop = null;

// Stop marker whose lines are currently highlighted
let selectedStopMarker = null;


// ============================================================
// LOAD LOCAL DATA
// ============================================================

async function loadLocalData() {

  const [
    vehiclesResponse,
    routesResponse
  ] = await Promise.all([
    fetch("data/vehicles.json"),
    fetch("data/routes.json")
  ]);

  if (!vehiclesResponse.ok) {
    throw new Error("Could not load data/vehicles.json");
  }

  if (!routesResponse.ok) {
    throw new Error("Could not load data/routes.json");
  }

  VEHICLES = await vehiclesResponse.json();
  ROUTES = await routesResponse.json();
}


// ============================================================
// ENRICH VEHICLE DATA
// ============================================================

function enrichVehicle(vehicle) {

  const operatorRoutes =
    ROUTES[vehicle.operator];

  const routeInfo =
    operatorRoutes?.[String(vehicle.routeId)];

  const directionName =
    routeInfo?.directions?.[String(vehicle.direction)];

  const vehicleInfo =
    VEHICLES[vehicle.operator]?.[
      String(vehicle.label)
    ];

  // Debug information
  if (!routeInfo) {
    console.warn(
      "Route not found:",
      {
        operator: vehicle.operator,
        routeId: vehicle.routeId,
        availableRoutes: operatorRoutes
          ? Object.keys(operatorRoutes)
          : "NO OPERATOR FOUND"
      }
    );
  }

  if (!directionName) {
    console.warn(
      "Direction not found:",
      {
        operator: vehicle.operator,
        routeId: vehicle.routeId,
        direction: vehicle.direction,
        routeInfo: routeInfo
      }
    );
  }

  return {
  ...vehicle,

  licensePlate:
    !vehicleInfo?.licensePlate ||
    vehicleInfo.licensePlate.toLowerCase() === "unknown"
      ? `Unknown (vehicle ${vehicle.vehicleId})`
      : vehicleInfo.licensePlate,

  model:
    vehicleInfo?.model ?? "Unknown",

  vehicleType:
    vehicleInfo?.type ?? "bus",

  routeIndicative:
    routeInfo?.indicative ??
    ROUTE_META[vehicle.operator]?.[String(vehicle.routeId)]?.shortName ??
    String(vehicle.routeId),

  direction:
    directionName ?? "Unknown"
};
}


// ============================================================
// NORMALIZE VEHICLE LABEL
// ============================================================
// The API sends some vehicles as S01-S29.
// They are shown (and looked up in vehicles.json) as 001-029.

function normalizeLabel(label) {

  if (label === null || label === undefined) {
    return label;
  }

  const text = String(label).trim();

  const match = text.match(/^S(\d{2})$/i);

  if (match) {
    return `0${match[1]}`;
  }

  return text;
}


// ============================================================
// FETCH VEHICLES FROM ONE API
// ============================================================

async function fetchFromAPI(api) {

  const response = await fetch(api.url);

  if (!response.ok) {
    throw new Error(
      `${api.name} API returned ${response.status}`
    );
  }

  const vehicles = await response.json();

  if (!Array.isArray(vehicles)) {
    throw new Error(
      `${api.name} API did not return an array`
    );
  }

  return vehicles.map(vehicle => ({
    ...vehicle,

    // Original label from the API (e.g. S01)
    apiLabel: vehicle.label,

    // Label used everywhere else (e.g. 001)
    label: normalizeLabel(vehicle.label),

    operator: api.operator,

    operatorName: api.name
  }));
}


// ============================================================
// FETCH ALL VEHICLES
// ============================================================

async function fetchVehicles() {

  const results = await Promise.allSettled(
    API_URLS.map(fetchFromAPI)
  );

  const vehicles = [];

  results.forEach((result, index) => {

    const api = API_URLS[index];

    if (result.status === "fulfilled") {

      vehicles.push(...result.value);

    } else {

      console.error(
        `Could not load ${api.name}:`,
        result.reason
      );
    }
  });

  return vehicles.map(enrichVehicle);
}


// ============================================================
// GET VEHICLE COORDINATES
// ============================================================

function getLatitude(vehicle) {

  return (
    vehicle.latitude ??
    vehicle.lat ??
    vehicle.position?.latitude ??
    vehicle.position?.lat ??
    null
  );
}


function getLongitude(vehicle) {

  return (
    vehicle.longitude ??
    vehicle.lng ??
    vehicle.lon ??
    vehicle.position?.longitude ??
    vehicle.position?.lng ??
    null
  );
}


// ============================================================
// GET VEHICLE ID
// ============================================================

function getVehicleId(vehicle) {

  return (
    vehicle.label ??
    null
  );
}


// ============================================================
// GET ROUTE ID
// ============================================================

function getRouteId(vehicle) {

  return (
    vehicle.routeId ??
    vehicle.route_id ??
    null
  );
}


// ============================================================
// NORMALIZE VEHICLE
// ============================================================

function normalizeVehicle(vehicle) {
  return {
    ...vehicle,

    vehicleId: vehicle.label,
    routeId: vehicle.routeId,
    direction: vehicle.direction
  };
}


// ============================================================
// ROUTE LINES + STOPS
// ============================================================

function patternKey(operator, routeId, patternIndex) {
  return `${operator}|${routeId}|${patternIndex}`;
}


function vehicleKeyOf(vehicle) {
  return `${vehicle.operator}-${vehicle.vehicleId}`;
}


function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}


// Decodes an encoded polyline (Google format, precision 5)
// into an array of [lat, lng] pairs.
function decodePolyline(encoded, precision = 5) {

  const factor = Math.pow(10, precision);
  const points = [];

  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {

    let result = 0;
    let shift = 0;
    let byte;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    const point = [lat / factor, lng / factor];
    const last = points[points.length - 1];

    // Skip repeated points ("??" segments in the API data)
    if (!last || last[0] !== point[0] || last[1] !== point[1]) {
      points.push(point);
    }
  }

  return points;
}


async function loadRoutes(api) {

  const response = await fetch(api.routesUrl);

  if (!response.ok) {
    throw new Error(`routes returned ${response.status}`);
  }

  const routes = await response.json();

  if (!Array.isArray(routes)) {
    throw new Error("routes response is not an array");
  }

  ROUTE_META[api.operator] = {};

  routes.forEach(route => {

    ROUTE_META[api.operator][String(route.id)] = {
      color: route.color ?? null,
      textColor: route.textColor ?? null,
      shortName: route.shortName
    };

    (route.patterns ?? []).forEach(pattern => {
      PATTERNS[
        patternKey(api.operator, route.id, pattern.index)
      ] = pattern;
    });
  });

  console.log(
    `Loaded ${Object.keys(ROUTE_META[api.operator]).length} routes for ${api.name}`
  );
}


async function loadStops(api) {

  const response = await fetch(api.stopsUrl);

  if (!response.ok) {
    throw new Error(`stops returned ${response.status}`);
  }

  const data = await response.json();

  const list = Array.isArray(data)
    ? data
    : (data.stops ?? data.data ?? []);

  STOPS[api.operator] = {};

  list.forEach(stop => {

    const id = stop.id ?? stop.stopId;
    const lat = getLatitude(stop);
    const lng = getLongitude(stop);

    if (id === undefined || lat === null || lng === null) {
      return;
    }

    STOPS[api.operator][String(id)] = {
      id,
      name:
        stop.name ??
        stop.stopName ??
        stop.shortName ??
        stop.longName ??
        `Stop ${id}`,
      code: stop.code ?? null,
      lat: Number(lat),
      lng: Number(lng),
      patterns: stop.patterns ?? []
    };
  });

  const count = Object.keys(STOPS[api.operator]).length;

  if (count === 0) {
    console.warn(
      "No stops could be read from the stops API. First item:",
      list[0]
    );
  } else {
    console.log(`Loaded ${count} stops for ${api.name}`);
  }
}


async function loadTransportData() {

  for (const api of API_URLS) {

    await Promise.all([
      api.routesUrl
        ? loadRoutes(api).catch(error =>
            console.warn(`Could not load routes for ${api.name}:`, error))
        : null,
      api.stopsUrl
        ? loadStops(api).catch(error =>
            console.warn(`Could not load stops for ${api.name}:`, error))
        : null
    ]);
  }

  buildStopsLayer();
  buildStopIndex();

  transportReady = true;

  // The API can know routes that routes.json does not (and vice versa)
  updateRouteFilter();
}


function getPattern(vehicle) {
  return PATTERNS[
    patternKey(vehicle.operator, vehicle.routeId, vehicle.patternIndex)
  ] ?? null;
}


function getStop(operator, stopId) {

  if (stopId === null || stopId === undefined) {
    return null;
  }

  return STOPS[operator]?.[String(stopId)] ?? null;
}


// ============================================================
// STOP MARKERS + POPUP
// ============================================================

function getRouteIndicative(operator, routeId) {
  return (
    ROUTES[operator]?.[String(routeId)]?.indicative ??
    ROUTE_META[operator]?.[String(routeId)]?.shortName ??
    String(routeId)
  );
}


// Vehicles heading to (or standing at) this stop, on a route that
// serves it. stopsAway = 0 means the stop is the vehicle's next stop.
function getStopArrivals(operator, stop) {

  const arrivals = [];

  allVehicles.forEach(vehicle => {

    if (vehicle.operator !== operator) {
      return;
    }

    const pattern = getPattern(vehicle);

    if (!pattern || !Array.isArray(pattern.stops)) {
      return;
    }

    const nextIndex = pattern.stops.findIndex(
      id => Number(id) === Number(vehicle.stopId)
    );

    if (nextIndex < 0) {
      return;
    }

    const targetIndex = pattern.stops.findIndex(
      (id, index) =>
        index >= nextIndex && Number(id) === Number(stop.id)
    );

    if (targetIndex < 0) {
      return;
    }

    arrivals.push({
      vehicle,
      stopsAway: targetIndex - nextIndex
    });
  });

  arrivals.sort((a, b) => {

    if (a.stopsAway !== b.stopsAway) {
      return a.stopsAway - b.stopsAway;
    }

    return String(a.vehicle.label)
      .localeCompare(String(b.vehicle.label));
  });

  return arrivals;
}


function formatArrival(vehicle, stopsAway) {

  if (stopsAway === 0) {

    if (vehicle.stopStatus === "STOPPED_AT") {
      return "în stație";
    }

    const arrival = new Date(vehicle.nextStopArrival);

    if (
      !vehicle.nextStopArrival ||
      Number.isNaN(arrival.getTime())
    ) {
      return "urmează";
    }

    const minutes = Math.round(
      (arrival.getTime() - Date.now()) / 60000
    );

    const time = arrival.toLocaleTimeString("ro-RO", {
      hour: "2-digit",
      minute: "2-digit"
    });

    return minutes <= 0
      ? `${time} (acum)`
      : `${time} (peste ${minutes} min)`;
  }

  return stopsAway === 1
    ? "o stație distanță"
    : `${stopsAway} stații distanță`;
}


// ============================================================
// STOP TIMETABLE (scheduled + real-time arrivals)
// ============================================================

function getApi(operator) {
  return API_URLS.find(api => api.operator === operator) ?? null;
}


// Only accepts a plain 6-digit hex colour (values come from the API)
function safeHex(value) {

  const text = String(value ?? "").replace("#", "");

  return /^[0-9a-fA-F]{6}$/.test(text) ? text : null;
}


function readableTextColor(hex) {

  const value = safeHex(hex);

  if (!value) {
    return "#ffffff";
  }

  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);

  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  return luminance > 0.6 ? "#000000" : "#ffffff";
}


function routeBadge(operator, routeId) {

  const meta = ROUTE_META[operator]?.[String(routeId)];

  const color = safeHex(meta?.color);
  const textColor = safeHex(meta?.textColor);

  const background = color ? `#${color}` : "#666666";
  const foreground = textColor
    ? `#${textColor}`
    : readableTextColor(color);

  return `<span style="display:inline-block; min-width:34px; text-align:center; padding:1px 6px; border-radius:4px; font-weight:bold; background:${background}; color:${foreground};">${escapeHtml(getRouteIndicative(operator, routeId))}</span>`;
}


function formatClock(timestamp) {

  return new Date(timestamp).toLocaleTimeString("ro-RO", {
    hour: "2-digit",
    minute: "2-digit"
  });
}


// Fetches .../stops/{id}/times (cached for a short while)
function requestStopTimes(operator, stop) {

  const api = getApi(operator);

  if (!api || !api.stopsUrl) {
    return;
  }

  const key = `${operator}|${stop.id}`;
  const previous = STOP_TIMES[key];

  if (
    previous &&
    (previous.loading || Date.now() - previous.time < STOP_TIMES_TTL)
  ) {
    return;
  }

  STOP_TIMES[key] = {
    data: previous?.data ?? null,
    error: false,
    loading: true,
    time: previous?.time ?? 0
  };

  fetch(`${api.stopsUrl}/${stop.id}/times`)
    .then(response => {

      if (!response.ok) {
        throw new Error(`stop times returned ${response.status}`);
      }

      return response.json();
    })
    .then(data => {

      STOP_TIMES[key] = {
        data: Array.isArray(data) ? data : [],
        error: false,
        loading: false,
        time: Date.now()
      };
    })
    .catch(error => {

      console.warn(`Could not load times for stop ${stop.id}:`, error);

      STOP_TIMES[key] = {
        data: previous?.data ?? null,
        error: true,
        loading: false,
        time: Date.now()
      };
    })
    .finally(() => {

      if (
        openStop &&
        openStop.operator === operator &&
        openStop.stop.id === stop.id
      ) {
        refreshOpenStopPopup();
      }
    });
}


// Upcoming arrivals at a stop, sorted by time.
// Returns null while the timetable has not been loaded yet.
function getStopDepartures(operator, stop) {

  const entry = STOP_TIMES[`${operator}|${stop.id}`];

  if (!entry || !entry.data) {
    return null;
  }

  const now = Date.now();
  const departures = [];

  entry.data.forEach(group => {

    const routeId = group.route?.routeId;

    const pattern =
      PATTERNS[patternKey(operator, routeId, group.route?.index)];

    (group.times ?? []).forEach(time => {

      const scheduled = new Date(time.scheduledArrival).getTime();

      if (Number.isNaN(scheduled)) {
        return;
      }

      const delayMs = Number(time.arrivalDelay ?? 0) * 1000;

      const predicted =
        scheduled + (Number.isNaN(delayMs) ? 0 : delayMs);

      // Skip arrivals that already happened
      if (predicted < now - 60000) {
        return;
      }

      departures.push({
        routeId,
        pattern,
        predicted,
        realtime: Boolean(time.realtime)
      });
    });
  });

  departures.sort((a, b) => a.predicted - b.predicted);

  return departures;
}


function createStopPopup(operator, stop) {

  // Load (or refresh) the timetable in the background
  requestStopTimes(operator, stop);

  // ----------------------------------------------------------
  // Lines that serve this stop
  // ----------------------------------------------------------

  const indicatives = [
    ...new Set(
      (stop.patterns ?? []).map(pattern =>
        getRouteIndicative(operator, pattern.routeId)
      )
    )
  ].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true })
  );

  const linesText = indicatives.length
    ? indicatives.map(escapeHtml).join(", ")
    : "-";


  // ----------------------------------------------------------
  // Timetable
  // ----------------------------------------------------------

  const entry = STOP_TIMES[`${operator}|${stop.id}`];
  const departures = getStopDepartures(operator, stop);

  let timetableHtml;

  if (departures === null) {

    timetableHtml = entry?.error
      ? "<li>Orarul nu a putut fi încărcat</li>"
      : "<li>Se încarcă...</li>";

  } else if (departures.length === 0) {

    timetableHtml = "<li>Nicio sosire programată în curând</li>";

  } else {

    timetableHtml = departures.slice(0, 8).map(item => {

      let headsign = "";

      if (item.pattern) {
        headsign =
          Number(item.pattern.toStopId) === Number(stop.id)
            ? "capăt de linie"
            : getStop(operator, item.pattern.toStopId)?.name ?? "";
      }

      const minutes = Math.round((item.predicted - Date.now()) / 60000);

      const inText = minutes <= 0 ? "acum" : `peste ${minutes} min`;

      return `
        <li style="margin-bottom: 3px;">
          ${routeBadge(operator, item.routeId)}
          ${headsign ? `→ ${escapeHtml(headsign)}` : ""}
          <br>
          <strong>${formatClock(item.predicted)}</strong>
          (${inText})${item.realtime ? " · live" : ""}
        </li>
      `;
    }).join("");
  }


  // ----------------------------------------------------------
  // Vehicles that are close to this stop
  // ----------------------------------------------------------

  const nearby = getStopArrivals(operator, stop)
    .filter(item => item.stopsAway <= 3)
    .slice(0, 4);

  const nearbyHtml = nearby.length
    ? `
      <p><strong>Vehicule în apropiere:</strong></p>
      <ul style="margin: 4px 0; padding-left: 18px;">
        ${nearby.map(item => `
          <li>
            <strong>${escapeHtml(item.vehicle.routeIndicative)}</strong>
            · ${escapeHtml(item.vehicle.label)}
            · ${formatArrival(item.vehicle, item.stopsAway)}
          </li>
        `).join("")}
      </ul>
    `
    : "";


  const title = stop.code
    ? `${escapeHtml(stop.name)} (${escapeHtml(stop.code)})`
    : escapeHtml(stop.name);

  return `
    <div class="vehicle-popup">

      <p>
        <strong>Stația:</strong>
        ${title}
      </p>

      <p>
        <strong>Linii:</strong>
        ${linesText}
      </p>

      <p><strong>Următoarele sosiri:</strong></p>
      <ul style="margin: 4px 0; padding-left: 0; list-style: none;">
        ${timetableHtml}
      </ul>

      ${nearbyHtml}

    </div>
  `;
}


// Highlights every line that serves the clicked stop.
function showStopRoutes(marker, operator, stop) {

  // A stop selection replaces a vehicle selection
  selectedVehicleKey = null;
  drawnPatternKey = null;
  selectedStopMarker = marker;

  routeLayer.clearLayers();

  const seen = new Set();

  (stop.patterns ?? []).forEach(item => {

    const key = patternKey(operator, item.routeId, item.index);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const pattern = PATTERNS[key];

    if (pattern) {
      drawPatternLine(operator, item.routeId, pattern, 4);
    }
  });
}


function clearStopRoutes() {

  routeLayer.clearLayers();

  selectedStopMarker = null;
}


function createStopMarker(operator, stop) {

  const key = `${operator}|${stop.id}`;

  const marker = L.circleMarker(
    [stop.lat, stop.lng],
    { ...STOP_STYLE }
  );

  marker.bindTooltip(escapeHtml(stop.name));

  // A function is evaluated every time the popup opens/updates,
  // so the live arrivals are always current.
  marker.bindPopup(() => createStopPopup(operator, stop));

  // These run on popupopen / popupclose (not on click) so that a popup
  // opened from code, e.g. from the stop search, behaves exactly like a
  // real click: thick outline + the lines serving the stop are drawn.
  marker.on("popupopen", () => {

    openStop = { marker, operator, stop };

    marker.setStyle(STOP_STYLE_SELECTED);
    marker.bringToFront();

    showStopRoutes(marker, operator, stop);
  });

  marker.on("popupclose", () => {

    if (openStop && openStop.marker === marker) {
      openStop = null;
    }

    marker.setStyle(STOP_STYLE);

    if (selectedStopMarker === marker) {
      clearStopRoutes();
    }

    if (pinnedStopKey === key) {
      pinnedStopKey = null;
    }

    // Deferred: another popup may be opening right now
    setTimeout(updateStopsVisibility, 0);
  });

  return marker;
}


function buildStopsLayer() {

  stopsLayer.clearLayers();
  stopMarkers = {};

  Object.entries(STOPS).forEach(([operator, stops]) => {

    Object.values(stops).forEach(stop => {
      stopMarkers[`${operator}|${stop.id}`] =
        createStopMarker(operator, stop);
    });
  });

  updateStopsVisibility();
}


// Decides which stop markers are on the map:
//  - route selected  -> only the stops of that route (at any zoom)
//  - no route        -> every stop, but only when zoomed in
// The stop with the open popup and the stop picked from the search
// box always stay visible.
function updateStopsVisibility() {

  const zoomedIn = map.getZoom() >= STOP_MIN_ZOOM;

  const openKey = openStop
    ? `${openStop.operator}|${openStop.stop.id}`
    : null;

  Object.entries(stopMarkers).forEach(([key, marker]) => {

    const show =
      key === openKey ||
      key === pinnedStopKey ||
      (selectedRouteStopKeys
        ? selectedRouteStopKeys.has(key)
        : zoomedIn);

    const shown = stopsLayer.hasLayer(marker);

    if (show && !shown) {
      stopsLayer.addLayer(marker);
    } else if (!show && shown) {
      stopsLayer.removeLayer(marker);
    }
  });
}


// Called after every refresh: updates an open stop popup.
function refreshOpenStopPopup() {

  if (!openStop) {
    return;
  }

  openStop.marker.getPopup()?.update();
}


// Draws the line of one pattern (in the colour of its route).
// Returns the colour, the known stops and the points of the line.
//
// options:
//   layer       layer group to draw into (default: routeLayer)
//   pane        pane of the line          (default: "routePane")
//   casingPane  when set, a white outline is drawn underneath in that
//               pane so the line stands out from the map
function drawPatternLine(operator, routeId, pattern, weight = 5, options = {}) {

  const layer = options.layer ?? routeLayer;
  const pane = options.pane ?? "routePane";

  const hex = safeHex(
    ROUTE_META[operator]?.[String(routeId)]?.color
  );

  const color = hex ? `#${hex}` : "#3388ff";

  const stops = (pattern.stops ?? [])
    .map(stopId => getStop(operator, stopId))
    .filter(Boolean);

  let points = [];

  if (pattern.geometry) {

    if (!pattern._points) {
      pattern._points = decodePolyline(pattern.geometry);
    }

    points = pattern._points;

    if (options.casingPane) {
      L.polyline(points, {
        pane: options.casingPane,
        interactive: false,
        color: "#ffffff",
        weight: weight + 4,
        opacity: 0.9
      }).addTo(layer);
    }

    L.polyline(points, {
      pane,
      interactive: false,
      color,
      weight,
      opacity: 0.85
    }).addTo(layer);

  } else if (stops.length > 1) {

    // No drawn geometry for this pattern: connect the stops
    points = stops.map(stop => [stop.lat, stop.lng]);

    L.polyline(points, {
      pane,
      interactive: false,
      color,
      weight: Math.max(weight - 1, 3),
      opacity: 0.7,
      dashArray: "6 8"
    }).addTo(layer);
  }

  return { color, stops, points };
}


function drawVehicleRoute(vehicle) {

  routeLayer.clearLayers();

  const key = patternKey(
    vehicle.operator,
    vehicle.routeId,
    vehicle.patternIndex
  );

  drawnPatternKey = key;

  const pattern = PATTERNS[key];

  if (!pattern) {
    console.warn("Route pattern not found:", key);
    return;
  }

  const { stops } = drawPatternLine(
    vehicle.operator,
    vehicle.routeId,
    pattern,
    5
  );

  // ----------------------------------------------------------
  // Stops of this pattern
  // ----------------------------------------------------------

  stops.forEach(stop => {

    // Not interactive: clicks go to the stop marker underneath
    L.circleMarker([stop.lat, stop.lng], {
      ...STOP_STYLE,
      pane: "routePane",
      interactive: false
    }).addTo(routeLayer);
  });
}


function clearVehicleRoute() {

  routeLayer.clearLayers();

  selectedVehicleKey = null;
  drawnPatternKey = null;
}


async function showVehicleRoute(vehicleKey) {

  selectedStopMarker = null;
  selectedVehicleKey = vehicleKey;

  if (transportDataPromise) {
    await transportDataPromise;
  }

  // The popup may have been closed while the data was loading
  if (selectedVehicleKey !== vehicleKey) {
    return;
  }

  const vehicle = allVehicles.find(
    item => vehicleKeyOf(item) === vehicleKey
  );

  if (!vehicle) {
    clearVehicleRoute();
    return;
  }

  drawVehicleRoute(vehicle);
}


// Called after every refresh: keeps the drawn route in sync
// (a vehicle changes pattern when it starts a new trip).
function refreshSelectedRoute() {

  if (!selectedVehicleKey) {
    return;
  }

  const vehicle = allVehicles.find(
    item => vehicleKeyOf(item) === selectedVehicleKey
  );

  if (!vehicle) {
    clearVehicleRoute();
    return;
  }

  const key = patternKey(
    vehicle.operator,
    vehicle.routeId,
    vehicle.patternIndex
  );

  if (key !== drawnPatternKey) {
    drawVehicleRoute(vehicle);
  }
}


// ============================================================
// POPUP
// ============================================================

function createPopup(vehicle) {
  const delaySeconds = Number(vehicle.delaySeconds ?? 0);
  const delayMinutes = Math.round(Math.abs(delaySeconds) / 60);

  let delayText;

  if (delaySeconds < -60) {
    delayText = `${delayMinutes} min în avans`;
  } else if (delaySeconds > 60) {
    delayText = `${delayMinutes} min întârziere`;
  } else {
    delayText = "La timp";
  }

  const pattern = getPattern(vehicle);
  const destination = getStop(vehicle.operator, pattern?.toStopId);
  const nextStop = getStop(vehicle.operator, vehicle.stopId);

  let extraLines = "";

  if (destination) {
    extraLines += `
      <p>
        <strong>Spre:</strong>
        ${escapeHtml(destination.name)}
      </p>
    `;
  }

  if (nextStop) {

    let nextStopText = escapeHtml(nextStop.name);

    if (vehicle.nextStopArrival) {
      const arrival = new Date(vehicle.nextStopArrival);

      if (!Number.isNaN(arrival.getTime())) {
        nextStopText += ` (${arrival.toLocaleTimeString("ro-RO", {
          hour: "2-digit",
          minute: "2-digit"
        })})`;
      }
    }

    extraLines += `
      <p>
        <strong>Următoarea stație:</strong>
        ${nextStopText}
      </p>
    `;
  }

  return `
    <div class="vehicle-popup">

      <p>
        <strong>Operator:</strong>
        ${vehicle.operatorName}
      </p>

      <p>
        <strong>Vehicul:</strong>
        ${vehicle.label}
      </p>

      <p>
        <strong>Model:</strong>
        ${vehicle.model}
      </p>

      <p>
        <strong>Linia:</strong>
        ${vehicle.routeIndicative}
      </p>

      <p>
        <strong>Întârziere:</strong>
        ${delayText}
      </p>

      ${extraLines}

    </div>
  `;
}


// ============================================================
// GET MARKER ICON (bus / tram)
// ============================================================

function getIcon(vehicle) {
  return MARKER_ICONS[vehicle.vehicleType] ?? MARKER_ICONS.bus;
}


// ============================================================
// CREATE / UPDATE MARKER
// ============================================================

function updateMarker(vehicle) {

  const latitude = vehicle.latitude;
  const longitude = vehicle.longitude;

  if (
    latitude === null ||
    longitude === null ||
    latitude === undefined ||
    longitude === undefined
  ) {
    return;
  }

  const vehicleKey =
    `${vehicle.operator}-${vehicle.vehicleId}`;

  const position = [
    Number(latitude),
    Number(longitude)
  ];

  if (
    Number.isNaN(position[0]) ||
    Number.isNaN(position[1])
  ) {
    return;
  }

  // ----------------------------------------------------------
  // Existing marker
  // ----------------------------------------------------------

  if (markers[vehicleKey]) {

    markers[vehicleKey]
      .setLatLng(position)
      .setIcon(getIcon(vehicle))
      .setPopupContent(
        createPopup(vehicle)
      );

    return;
  }


  // ----------------------------------------------------------
  // New marker
  // ----------------------------------------------------------

  const marker = L.marker(position, { icon: getIcon(vehicle) }).addTo(map);

  marker.bindPopup(
    createPopup(vehicle)
  );

  // Draw the route line when the vehicle is clicked,
  // remove it when its popup is closed.
  marker.on("click", () => showVehicleRoute(vehicleKey));

  marker.on("popupclose", () => {
    if (selectedVehicleKey === vehicleKey) {
      clearVehicleRoute();
    }
  });

  marker.addTo(map);

  markers[vehicleKey] = marker;
}


// ============================================================
// REMOVE OLD MARKERS
// ============================================================

function removeOldMarkers(currentVehicles) {

  const currentKeys = new Set();

  currentVehicles.forEach(vehicle => {

    const key =
      `${vehicle.operator}-${vehicle.vehicleId}`;

    currentKeys.add(key);
  });


  Object.keys(markers).forEach(key => {

    if (!currentKeys.has(key)) {

      map.removeLayer(markers[key]);

      delete markers[key];
    }
  });
}


// ============================================================
// DISPLAY VEHICLES
// ============================================================

function displayVehicles() {

  const filteredVehicles =
    allVehicles.filter(vehicle => {

      // Route filter
      if (
        selectedRoute &&
        (
          vehicle.operator !== selectedRoute.operator ||
          String(vehicle.routeId) !== selectedRoute.routeId
        )
      ) {
        return false;
      }

      return true;
    });


  removeOldMarkers(filteredVehicles);


  filteredVehicles.forEach(vehicle => {

    updateMarker(vehicle);

  });


  updateStatus(filteredVehicles);
}


// ============================================================
// ROUTE DROPDOWN
// ============================================================
// Lists EVERY known route, not only the ones that currently have a
// vehicle on the map: routes.json + the routes API + any route seen
// on a vehicle.

let routeFilterSignature = "";

function updateRouteFilter() {

  const routeFilter =
    document.getElementById("routeFilter");

  const routes = new Map();


  function addRoute(operator, routeId) {

    if (routeId === null || routeId === undefined) {
      return;
    }

    const key = `${operator}|${routeId}`;

    if (!routes.has(key)) {

      routes.set(key, {
        key,
        operator,
        routeId: String(routeId),
        indicative: String(
          getRouteIndicative(operator, routeId)
        )
      });
    }
  }


  // 1. routes API: the real list of routes. Once it has loaded it is the
  //    authority, so a stale id left in routes.json cannot show up twice.
  Object.entries(ROUTE_META).forEach(([operator, metas]) => {
    Object.keys(metas ?? {}).forEach(routeId =>
      addRoute(operator, routeId)
    );
  });

  // 2. routes.json: used until the API has loaded (or if it cannot be
  //    reached), so the list is never empty. Its labels (1b, 23b, ...)
  //    are always the ones shown, see getRouteIndicative().
  Object.entries(ROUTES).forEach(([operator, operatorRoutes]) => {

    if (Object.keys(ROUTE_META[operator] ?? {}).length > 0) {
      return;
    }

    Object.keys(operatorRoutes ?? {}).forEach(routeId =>
      addRoute(operator, routeId)
    );
  });

  // 3. routes seen on vehicles
  allVehicles.forEach(vehicle =>
    addRoute(vehicle.operator, vehicle.routeId)
  );


  const sortedRoutes =
    [...routes.values()].sort((a, b) =>
      a.indicative.localeCompare(
        b.indicative,
        undefined,
        { numeric: true }
      )
    );


  // Called on every refresh: only rebuild when the list changed
  const signature = sortedRoutes
    .map(route => `${route.key}:${route.indicative}`)
    .join(",");

  if (signature === routeFilterSignature) {
    return;
  }

  routeFilterSignature = signature;


  // Only mention the operator if there is more than one
  const showOperator =
    new Set(sortedRoutes.map(route => route.operator)).size > 1;


  routeFilter.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All routes";
  routeFilter.appendChild(allOption);


  sortedRoutes.forEach(route => {

    const option =
      document.createElement("option");

    option.value = route.key;

    option.textContent = showOperator
      ? `${route.indicative} (${route.operator})`
      : route.indicative;

    routeFilter.appendChild(option);
  });


  // Restore the selection
  routeFilter.value = selectedRoute
    ? `${selectedRoute.operator}|${selectedRoute.routeId}`
    : "all";

  if (routeFilter.selectedIndex === -1) {

    routeFilter.value = "all";
    selectedRoute = null;

    drawSelectedRoute({ fit: false });
    displayVehicles();
  }
}


// ============================================================
// SELECTED ROUTE (from the dropdown)
// ============================================================
// Draws every pattern (direction / variant) of the route, shows only
// its stops, and zooms the map to it. Vehicles are filtered separately
// by displayVehicles().

async function drawSelectedRoute({ fit = true } = {}) {

  const token = ++routeDrawToken;

  selectedRouteLayer.clearLayers();
  selectedRouteStopKeys = null;
  routeNote = "";

  updateStopsVisibility();
  renderStatus();


  if (!selectedRoute) {
    return;
  }

  const { operator, routeId } = selectedRoute;


  // Lines + stops load in the background at startup
  if (transportDataPromise) {
    await transportDataPromise;
  }

  // The user picked something else while this was loading
  if (token !== routeDrawToken) {
    return;
  }


  const prefix = patternKey(operator, routeId, "");

  const patterns = Object.entries(PATTERNS)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, pattern]) => pattern);


  const stopKeys = new Set();
  const bounds = L.latLngBounds([]);

  patterns.forEach(pattern => {

    const { stops, points } = drawPatternLine(
      operator,
      routeId,
      pattern,
      6,
      {
        layer: selectedRouteLayer,
        pane: "selectedRoutePane",
        casingPane: "selectedRouteCasingPane"
      }
    );

    stops.forEach(stop => {
      stopKeys.add(`${operator}|${stop.id}`);
      bounds.extend([stop.lat, stop.lng]);
    });

    points.forEach(point => bounds.extend(point));
  });


  if (patterns.length === 0) {
    routeNote = "no route line available";
  }

  selectedRouteStopKeys = stopKeys.size > 0 ? stopKeys : null;

  updateStopsVisibility();
  renderStatus();


  if (fit && bounds.isValid()) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}


// ============================================================
// STATUS
// ============================================================

function updateStatus(vehicles) {

  shownVehicleCount = vehicles.length;

  lastUpdateTime = new Date().toLocaleTimeString();

  renderStatus();
}


function renderStatus() {

  // Nothing to show before the first update
  if (!lastUpdateTime) {
    return;
  }

  const status =
    document.getElementById("status");

  const count = shownVehicleCount;

  const vehicleText =
    `${count} ${count === 1 ? "vehicle" : "vehicles"}`;

  let text;

  if (selectedRoute) {

    const name = getRouteIndicative(
      selectedRoute.operator,
      selectedRoute.routeId
    );

    text = count === 0
      ? `Route ${name}: no vehicles on the map right now`
      : `Route ${name}: ${vehicleText} on the map`;

  } else {

    text = `${vehicleText} shown`;
  }

  text += ` • Last update: ${lastUpdateTime}`;

  if (routeNote) {
    text += ` • ${routeNote}`;
  }

  status.textContent = text;
}


// ============================================================
// UPDATE EVERYTHING
// ============================================================

async function updateVehicles() {

  const status =
    document.getElementById("status");


  status.textContent =
    "Updating...";


  try {

    allVehicles =
      await fetchVehicles();

    allVehicles =
      allVehicles.map(normalizeVehicle);


    updateRouteFilter();

    displayVehicles();

    refreshSelectedRoute();

    refreshOpenStopPopup();


    console.log(
      "Vehicles:",
      allVehicles
    );

  } catch (error) {

    console.error(error);

    status.textContent =
      `Error updating vehicles: ${error.message}`;
  }
}


// ============================================================
// ROUTE FILTER
// ============================================================

document
  .getElementById("routeFilter")
  ?.addEventListener(
    "change",
    event => {

      const value =
        event.target.value;


      if (value === "all") {

        selectedRoute =
          null;

      } else {

        // Format:
        // operator|routeId

        const separator =
          value.indexOf("|");

        selectedRoute = {
          operator: value.slice(0, separator),
          routeId: value.slice(separator + 1)
        };
      }


      // Start from a clean map: closing the popup also removes
      // any vehicle / stop highlight that is currently drawn.
      map.closePopup();

      displayVehicles();

      drawSelectedRoute({ fit: true });
    }
  );


// ============================================================
// STOP SEARCH
// ============================================================
// Type part of a stop name and / or a line number, e.g.
// "complex nou", "25" or "complex nou 25". Every word must match
// either the stop name or one of the lines that serve the stop.

// Lower case, no diacritics: "Ștefan" -> "stefan"
function normalizeText(value) {

  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}


function compareIndicatives(a, b) {

  return String(a).localeCompare(
    String(b),
    undefined,
    { numeric: true }
  );
}


function buildStopIndex() {

  STOP_INDEX = [];

  function setFor(map, id) {

    if (!map[id]) {
      map[id] = new Set();
    }

    return map[id];
  }

  Object.entries(STOPS).forEach(([operator, stops]) => {

    const routesByStop = {};
    const destinationsByStop = {};

    function note(stopId, routeId, toStopId) {

      const id = String(stopId);

      setFor(routesByStop, id).add(String(routeId));

      if (toStopId !== null && toStopId !== undefined) {
        setFor(destinationsByStop, id).add(String(toStopId));
      }
    }


    // Which routes pass through each stop, and where they are heading
    const prefix = `${operator}|`;

    Object.entries(PATTERNS).forEach(([key, pattern]) => {

      if (!key.startsWith(prefix)) {
        return;
      }

      const routeId = key.slice(prefix.length).split("|")[0];

      (pattern.stops ?? []).forEach(stopId =>
        note(stopId, routeId, pattern.toStopId)
      );
    });


    Object.values(stops).forEach(stop => {

      // Also trust what the stops API says about this stop
      (stop.patterns ?? []).forEach(item => {

        const pattern =
          PATTERNS[patternKey(operator, item.routeId, item.index)];

        note(stop.id, item.routeId, pattern?.toStopId);
      });


      const id = String(stop.id);

      const lines = [...(routesByStop[id] ?? [])]
        .map(routeId => ({
          routeId,
          indicative: String(getRouteIndicative(operator, routeId))
        }))
        .sort((a, b) => compareIndicatives(a.indicative, b.indicative));

      // Where the lines through this stop are heading. This tells apart
      // two stops with the same name on opposite sides of the street.
      const destinations = [
        ...new Set(
          [...(destinationsByStop[id] ?? [])]
            .filter(destinationId => destinationId !== id)
            .map(destinationId => getStop(operator, destinationId)?.name)
            .filter(name => name && name !== stop.name)
        )
      ];

      STOP_INDEX.push({
        operator,
        stop,
        key: `${operator}|${id}`,
        nameNorm: normalizeText(stop.name),
        lines,
        lineNorms: lines.map(line => normalizeText(line.indicative)),
        destinations
      });
    });
  });

  console.log(`Stop search index: ${STOP_INDEX.length} stops`);
}


function searchStops(query) {

  const tokens = normalizeText(query)
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return [];
  }

  const matches = [];

  STOP_INDEX.forEach(entry => {

    let score = 0;

    for (const token of tokens) {

      if (entry.nameNorm.includes(token)) {

        // A name (or word of it) that starts with the token ranks higher
        score +=
          entry.nameNorm.startsWith(token) ||
          entry.nameNorm.includes(` ${token}`)
            ? 3
            : 2;

      } else if (entry.lineNorms.includes(token)) {

        score += 3;

      } else if (entry.lineNorms.some(line => line.startsWith(token))) {

        // Still typing a line, e.g. "2" while looking for "25"
        score += 1;

      } else {

        // Every word has to match something
        return;
      }
    }

    matches.push({ entry, score });
  });

  matches.sort((a, b) =>
    b.score - a.score ||
    a.entry.stop.name.localeCompare(b.entry.stop.name, "ro") ||
    compareIndicatives(
      a.entry.lines[0]?.indicative ?? "",
      b.entry.lines[0]?.indicative ?? ""
    )
  );

  return matches.map(match => match.entry);
}


// Moves the map to a stop and opens its timetable popup, the same
// as if the stop had been clicked.
function focusStop(operator, stopId) {

  const key = `${operator}|${stopId}`;

  const stop = getStop(operator, stopId);
  const marker = stopMarkers[key];

  if (!stop || !marker) {
    return;
  }

  // Make sure the marker is on the map even if it is normally hidden
  // (zoomed out, or not part of the selected route)
  pinnedStopKey = key;
  updateStopsVisibility();

  const zoom = Math.max(map.getZoom(), STOP_FOCUS_ZOOM);

  let opened = false;

  function openPopup() {

    if (opened) {
      return;
    }

    opened = true;

    map.off("moveend", openPopup);

    if (map.hasLayer(marker)) {
      marker.openPopup();
    }
  }

  // Open once the map has finished moving; the timeout is a safety net
  map.on("moveend", openPopup);
  setTimeout(openPopup, 1500);

  map.setView([stop.lat, stop.lng], zoom, { animate: true });
}


// ---------------- search box ----------------

// Assigned by initStopSearch(). If the page has no search box (for example
// an older index.html), the search is simply disabled: it must never stop
// the rest of the app from starting.
let stopSearchInput = null;
let stopResultsEl = null;

const MAX_STOP_RESULTS = 40;
const MAX_LINE_BADGES = 8;

let stopResults = [];
let activeResultIndex = -1;


function hideStopResults() {

  stopResultsEl.hidden = true;
  activeResultIndex = -1;
}


function showStopMessage(text) {

  stopResults = [];
  activeResultIndex = -1;

  stopResultsEl.innerHTML =
    `<div class="stop-result-message">${escapeHtml(text)}</div>`;

  stopResultsEl.hidden = false;
}


function renderStopResults() {

  const query = stopSearchInput.value.trim();

  if (!query) {
    stopResults = [];
    hideStopResults();
    return;
  }

  if (!transportReady) {
    showStopMessage("Stops are still loading...");
    return;
  }

  const found = searchStops(query);

  if (found.length === 0) {
    showStopMessage("No stops found");
    return;
  }

  stopResults = found.slice(0, MAX_STOP_RESULTS);
  activeResultIndex = -1;

  const items = stopResults.map((entry, index) => {

    const badges = entry.lines
      .slice(0, MAX_LINE_BADGES)
      .map(line => routeBadge(entry.operator, line.routeId))
      .join(" ");

    const more = entry.lines.length > MAX_LINE_BADGES
      ? `<span class="stop-result-more">+${entry.lines.length - MAX_LINE_BADGES}</span>`
      : "";

    const code = entry.stop.code
      ? `<span class="stop-result-code">${escapeHtml(entry.stop.code)}</span>`
      : "";

    const heading = entry.destinations.length
      ? `<div class="stop-result-direction">→ ${escapeHtml(entry.destinations.slice(0, 2).join(", "))}${entry.destinations.length > 2 ? "…" : ""}</div>`
      : "";

    return `
      <button type="button" class="stop-result" data-index="${index}">
        <div class="stop-result-name">${escapeHtml(entry.stop.name)}${code}</div>
        <div class="stop-result-lines">${badges}${more}</div>
        ${heading}
      </button>
    `;
  });

  const footer = found.length > MAX_STOP_RESULTS
    ? `<div class="stop-result-message">Showing ${MAX_STOP_RESULTS} of ${found.length} stops. Keep typing to narrow it down.</div>`
    : "";

  stopResultsEl.innerHTML = items.join("") + footer;
  stopResultsEl.hidden = false;
}


function setActiveResult(index) {

  const buttons = stopResultsEl.querySelectorAll(".stop-result");

  buttons.forEach((button, i) =>
    button.classList.toggle("active", i === index)
  );

  activeResultIndex = index;

  buttons[index]?.scrollIntoView({ block: "nearest" });
}


function selectStopResult(entry) {

  if (!entry) {
    return;
  }

  stopSearchInput.value = entry.stop.name;

  hideStopResults();

  // Closes the keyboard on phones so the map + popup are visible
  stopSearchInput.blur();

  focusStop(entry.operator, entry.stop.id);
}


function initStopSearch() {

  stopSearchInput = document.getElementById("stopSearch");
  stopResultsEl = document.getElementById("stopResults");

  if (!stopSearchInput || !stopResultsEl) {
    console.warn(
      "Stop search disabled: #stopSearch / #stopResults not found in index.html"
    );
    return;
  }

  stopSearchInput.addEventListener("input", renderStopResults);

  stopSearchInput.addEventListener("focus", renderStopResults);

  stopSearchInput.addEventListener("keydown", event => {

    if (event.key === "Escape") {
      hideStopResults();
      return;
    }

    if (stopResultsEl.hidden || stopResults.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {

      event.preventDefault();
      setActiveResult(
        Math.min(activeResultIndex + 1, stopResults.length - 1)
      );

    } else if (event.key === "ArrowUp") {

      event.preventDefault();
      setActiveResult(Math.max(activeResultIndex - 1, 0));

    } else if (event.key === "Enter") {

      event.preventDefault();
      selectStopResult(
        stopResults[activeResultIndex >= 0 ? activeResultIndex : 0]
      );
    }
  });

  stopResultsEl.addEventListener("click", event => {

    const button = event.target.closest(".stop-result");

    if (button) {
      selectStopResult(stopResults[Number(button.dataset.index)]);
    }
  });

  // Click anywhere outside the search box closes the results
  document.addEventListener("click", event => {

    if (!event.target.closest(".stop-search")) {
      hideStopResults();
    }
  });
}

initStopSearch();


// ============================================================
// MANUAL REFRESH
// ============================================================

document
  .getElementById("refreshButton")
  ?.addEventListener(
    "click",
    updateVehicles
  );


// ============================================================
// START APPLICATION
// ============================================================

async function startApp() {

  try {

    document
      .getElementById("status")
      .textContent =
      "Loading local data...";


    await loadLocalData();

    // List every route from routes.json straight away
    updateRouteFilter();

    // Route lines + stops load in the background
    transportDataPromise = loadTransportData();


    document
      .getElementById("status")
      .textContent =
      "Loading vehicles...";


    await updateVehicles();


    // Refresh every 10 seconds
    setInterval(
      updateVehicles,
      10000
    );


  } catch (error) {

    console.error(error);

    document
      .getElementById("status")
      .textContent =
      `Startup error: ${error.message}`;
  }
}


startApp();