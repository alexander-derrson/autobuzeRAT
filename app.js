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

let selectedOperator = "all";
let selectedRoute = "all";

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

// Layer that holds the drawn route line + stops of the selected vehicle
const routeLayer = L.layerGroup().addTo(map);

// Dedicated pane so the route line sits above the general stops
map.createPane("routePane").style.zIndex = 450;

// Layer with every stop of the network (shown when zoomed in)
const STOP_MIN_ZOOM = 14;
const stopsLayer = L.layerGroup();

map.on("zoomend", updateStopsVisibility);

// Stop whose popup is currently open (so it can refresh live)
let openStop = null;


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


function createStopMarker(operator, stop) {

  const marker = L.circleMarker([stop.lat, stop.lng], {
    radius: 5,
    color: "#000000",
    weight: 2,
    fillColor: "#ffffff",
    fillOpacity: 1
  });

  marker.bindTooltip(escapeHtml(stop.name));

  // A function is evaluated every time the popup opens/updates,
  // so the live arrivals are always current.
  marker.bindPopup(() => createStopPopup(operator, stop));

  marker.on("popupopen", () => {
    openStop = { marker, operator, stop };
  });

  marker.on("popupclose", () => {
    if (openStop && openStop.marker === marker) {
      openStop = null;
    }
  });

  return marker;
}


function buildStopsLayer() {

  stopsLayer.clearLayers();

  Object.entries(STOPS).forEach(([operator, stops]) => {

    Object.values(stops).forEach(stop => {
      createStopMarker(operator, stop).addTo(stopsLayer);
    });
  });

  updateStopsVisibility();
}


// Stops are only shown when zoomed in, to keep the map readable.
function updateStopsVisibility() {

  const show = map.getZoom() >= STOP_MIN_ZOOM;

  if (show && !map.hasLayer(stopsLayer)) {
    stopsLayer.addTo(map);
  }

  if (!show && map.hasLayer(stopsLayer)) {
    map.removeLayer(stopsLayer);
  }
}


// Called after every refresh: updates an open stop popup.
function refreshOpenStopPopup() {

  if (!openStop) {
    return;
  }

  openStop.marker.getPopup()?.update();
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

  const color =
    ROUTE_META[vehicle.operator]?.[String(vehicle.routeId)]?.color
      ? `#${ROUTE_META[vehicle.operator][String(vehicle.routeId)].color}`
      : "#3388ff";

  const stops = (pattern.stops ?? [])
    .map(stopId => getStop(vehicle.operator, stopId))
    .filter(Boolean);

  // ----------------------------------------------------------
  // Route line
  // ----------------------------------------------------------

  if (pattern.geometry) {

    const points = decodePolyline(pattern.geometry);

    L.polyline(points, {
      pane: "routePane",
      interactive: false,
      color,
      weight: 5,
      opacity: 0.85
    }).addTo(routeLayer);

  } else if (stops.length > 1) {

    // No drawn geometry for this pattern: connect the stops
    L.polyline(
      stops.map(stop => [stop.lat, stop.lng]),
      {
        pane: "routePane",
        interactive: false,
        color,
        weight: 4,
        opacity: 0.7,
        dashArray: "6 8"
      }
    ).addTo(routeLayer);
  }

  // ----------------------------------------------------------
  // Stops of this pattern
  // ----------------------------------------------------------

  stops.forEach(stop => {

    // Not interactive: clicks go to the stop marker underneath
    L.circleMarker([stop.lat, stop.lng], {
      pane: "routePane",
      interactive: false,
      radius: 5,
      color,
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1
    }).addTo(routeLayer);
  });
}


function clearVehicleRoute() {

  routeLayer.clearLayers();

  selectedVehicleKey = null;
  drawnPatternKey = null;
}


async function showVehicleRoute(vehicleKey) {

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

      // Operator filter
      if (
        selectedOperator !== "all" &&
        vehicle.operator !== selectedOperator
      ) {
        return false;
      }


      // Route filter
      if (
        selectedRoute !== "all" &&
        String(vehicle.routeId) !== String(selectedRoute)
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
// UPDATE ROUTE FILTER
// ============================================================

function updateRouteFilter() {

  const routeFilter =
    document.getElementById("routeFilter");

  const previousValue =
    routeFilter.value;


  routeFilter.innerHTML = `
    <option value="all">
      All routes
    </option>
  `;


  const routes = new Map();


  allVehicles.forEach(vehicle => {

    if (
      selectedOperator !== "all" &&
      vehicle.operator !== selectedOperator
    ) {
      return;
    }


    if (
      vehicle.routeId === null ||
      vehicle.routeId === undefined
    ) {
      return;
    }


    const key =
      `${vehicle.operator}-${vehicle.routeId}`;


    if (!routes.has(key)) {

      routes.set(key, {
        operator: vehicle.operator,
        routeId: vehicle.routeId,
        indicative: vehicle.routeIndicative
      });

    }

  });


  const sortedRoutes =
    [...routes.values()].sort((a, b) => {

      return String(a.indicative)
        .localeCompare(
          String(b.indicative),
          undefined,
          {
            numeric: true
          }
        );

    });


  sortedRoutes.forEach(route => {

    const option =
      document.createElement("option");

    option.value =
      `${route.operator}|${route.routeId}`;

    option.textContent =
      `${route.indicative} (${route.operator === "RAT Craiova"
        ? "RAT Craiova"
        : "RAT Craiova"})`;

    routeFilter.appendChild(option);

  });


  // Restore selection if possible
  if (
    [...routeFilter.options]
      .some(option => option.value === previousValue)
  ) {

    routeFilter.value = previousValue;

  } else {

    routeFilter.value = "all";

    selectedRoute = "all";
  }
}


// ============================================================
// STATUS
// ============================================================

function updateStatus(vehicles) {

  const status =
    document.getElementById("status");

  const time =
    new Date().toLocaleTimeString();


  status.textContent =
    `${vehicles.length} vehicles shown • Last update: ${time}`;
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
// OPERATOR FILTER
// ============================================================

document
  .getElementById("operatorFilter")
  .addEventListener(
    "change",
    event => {

      selectedOperator =
        event.target.value;

      selectedRoute =
        "all";

      updateRouteFilter();

      displayVehicles();
    }
  );


// ============================================================
// ROUTE FILTER
// ============================================================

document
  .getElementById("routeFilter")
  .addEventListener(
    "change",
    event => {

      const value =
        event.target.value;


      if (value === "all") {

        selectedRoute =
          "all";

      } else {

        // Format:
        // operator|routeId

        const [
          operator,
          routeId
        ] = value.split("|");


        // Make sure the selected operator
        // matches the selected route.

        selectedOperator =
          operator;

        document
          .getElementById("operatorFilter")
          .value = operator;


        selectedRoute =
          routeId;
      }


      displayVehicles();
    }
  );


// ============================================================
// MANUAL REFRESH
// ============================================================

document
  .getElementById("refreshButton")
  .addEventListener(
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