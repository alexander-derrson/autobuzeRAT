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

// The city has a single operator
const OPERATOR = API_URLS[0].operator;

let selectedRoute = "all";

// Route lines and stops (loaded from the API)
let PATTERNS = {};
let ROUTE_META = {};
let STOPS = {};

// All patterns of each route: operator -> routeId -> [patterns]
let ROUTE_PATTERNS = {};

// Extra routes / stops / timetables that are not in the API
// (data/extra.json, optional)
let EXTRA = null;

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

// Layer that holds the line(s) of the route chosen in the route list
const routeSelectionLayer = L.layerGroup().addTo(map);

// Dedicated pane so the route line sits above the general stops
map.createPane("routePane").style.zIndex = 450;

// Layer with every stop of the network (shown when zoomed in)
const STOP_MIN_ZOOM = 14;
const stopsLayer = L.layerGroup().addTo(map);

// One marker per stop, created once: "operator|stopId" -> marker
const stopMarkers = new Map();

map.on("zoomend", updateStopsVisibility);

// Stop whose popup is currently open (so it can refresh live)
let openStop = null;

// Stop marker whose lines are currently highlighted
let selectedStopMarker = null;

// Route list / stop search state
let routeListSignature = "";
let stopSearchIndex = [];
let searchResults = [];
let activeResult = -1;


// ============================================================
// LOAD LOCAL DATA
// ============================================================

async function loadLocalData() {

  const [
    vehiclesResponse,
    routesResponse,
    extraResponse
  ] = await Promise.all([
    fetch("data/vehicles.json"),
    fetch("data/routes.json"),
    fetch("data/extra.json").catch(() => null)
  ]);

  if (!vehiclesResponse.ok) {
    throw new Error("Could not load data/vehicles.json");
  }

  if (!routesResponse.ok) {
    throw new Error("Could not load data/routes.json");
  }

  VEHICLES = await vehiclesResponse.json();
  ROUTES = await routesResponse.json();

  // Optional file with routes / stops / timetables missing from the API
  EXTRA = null;

  if (extraResponse && extraResponse.ok) {

    try {
      EXTRA = await extraResponse.json();
    } catch (error) {
      console.warn("data/extra.json is not valid JSON:", error);
    }
  }
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
  ROUTE_PATTERNS[api.operator] = {};

  routes.forEach(route => {

    ROUTE_META[api.operator][String(route.id)] = {
      color: route.color ?? null,
      textColor: route.textColor ?? null,
      shortName: route.shortName
    };

    ROUTE_PATTERNS[api.operator][String(route.id)] = [];

    (route.patterns ?? []).forEach(pattern => {

      PATTERNS[
        patternKey(api.operator, route.id, pattern.index)
      ] = pattern;

      ROUTE_PATTERNS[api.operator][String(route.id)].push(pattern);
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


// ============================================================
// EXTRA DATA (routes / stops / timetables that are not in the API)
// ============================================================

function distanceMeters(a, b) {

  const toRadians = degrees => degrees * Math.PI / 180;

  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
    Math.cos(toRadians(b.lat)) *
    Math.sin(dLng / 2) ** 2;

  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}


// Minutes after the departure from the first stop, for every stop
// of the pattern. Known values come from "offsets"; the last stop can
// come from "duration". Gaps are filled proportionally to the distance.
function computeOffsets(operator, stopIds, pattern) {

  const count = stopIds.length;
  const offsets = new Array(count).fill(null);

  if (Array.isArray(pattern.offsets)) {

    pattern.offsets.forEach((value, index) => {

      if (
        index < count &&
        value !== null &&
        value !== undefined &&
        !Number.isNaN(Number(value))
      ) {
        offsets[index] = Number(value);
      }
    });
  }

  if (offsets[0] === null) {
    offsets[0] = 0;
  }

  if (
    offsets[count - 1] === null &&
    pattern.duration !== undefined &&
    pattern.duration !== null &&
    !Number.isNaN(Number(pattern.duration))
  ) {
    offsets[count - 1] = Number(pattern.duration);
  }

  // Without a duration only the first stop can be timed
  if (offsets[count - 1] === null) {
    return offsets;
  }

  const stops = stopIds.map(id => getStop(operator, id));

  const distance = [0];

  for (let i = 1; i < count; i++) {
    distance[i] = distance[i - 1] + distanceMeters(stops[i - 1], stops[i]);
  }

  let previous = 0;

  for (let i = 1; i < count; i++) {

    if (offsets[i] === null) {
      continue;
    }

    const span = distance[i] - distance[previous];

    for (let j = previous + 1; j < i; j++) {

      const ratio = span > 0
        ? (distance[j] - distance[previous]) / span
        : (j - previous) / (i - previous);

      offsets[j] =
        offsets[previous] + ratio * (offsets[i] - offsets[previous]);
    }

    previous = i;
  }

  return offsets;
}


function mergeExtraData() {

  if (!EXTRA) {
    return;
  }

  const operator = OPERATOR;

  STOPS[operator] = STOPS[operator] ?? {};
  ROUTE_META[operator] = ROUTE_META[operator] ?? {};
  ROUTE_PATTERNS[operator] = ROUTE_PATTERNS[operator] ?? {};

  // ----------------------------------------------------------
  // Extra stops
  // ----------------------------------------------------------

  (EXTRA.stops ?? []).forEach(stop => {

    const id = stop.id;
    const lat = Number(stop.latitude ?? stop.lat);
    const lng = Number(stop.longitude ?? stop.lng);

    if (
      id === undefined ||
      id === null ||
      Number.isNaN(lat) ||
      Number.isNaN(lng)
    ) {
      console.warn("extra.json: stop needs id, latitude, longitude:", stop);
      return;
    }

    if (STOPS[operator][String(id)] && !STOPS[operator][String(id)].extra) {
      console.warn(`extra.json: stop id ${id} already exists in the API, skipped`);
      return;
    }

    STOPS[operator][String(id)] = {
      id,
      name: stop.name ?? `Stop ${id}`,
      code: stop.code ?? null,
      lat,
      lng,
      patterns: [],
      extra: true
    };
  });

  // ----------------------------------------------------------
  // Extra routes
  // ----------------------------------------------------------

  (EXTRA.routes ?? []).forEach(route => {

    const routeId = String(route.id);

    if (ROUTE_META[operator][routeId] && !ROUTE_META[operator][routeId].extra) {
      console.warn(`extra.json: route id ${routeId} already exists in the API, skipped`);
      return;
    }

    ROUTE_META[operator][routeId] = {
      color: route.color ?? null,
      textColor: route.textColor ?? null,
      shortName: route.shortName ?? routeId,
      extra: true
    };

    ROUTE_PATTERNS[operator][routeId] = [];

    (route.patterns ?? []).forEach((item, position) => {

      const index = item.index ?? position + 1;
      const stopIds = item.stops ?? [];

      const missing = stopIds.filter(id => !getStop(operator, id));

      if (stopIds.length < 2 || missing.length > 0) {
        console.warn(
          `extra.json: route ${routeId} pattern ${index} skipped`,
          stopIds.length < 2
            ? "(needs at least 2 stops)"
            : `(unknown stops: ${missing.join(", ")})`
        );
        return;
      }

      const pattern = {
        index,
        routeId: route.id,
        fromStopId: stopIds[0],
        toStopId: stopIds[stopIds.length - 1],
        direction: item.direction ?? position % 2,
        stops: stopIds,
        geometry: item.geometry ?? null,
        headsign: item.headsign ?? null,
        schedule: item.schedule ?? {},
        offsets: computeOffsets(operator, stopIds, item),
        extra: true
      };

      if (Array.isArray(item.path)) {
        pattern._points = item.path.map(point => [
          Number(point[0]),
          Number(point[1])
        ]);
      }

      if (pattern.offsets[stopIds.length - 1] === null) {
        console.warn(
          `extra.json: route ${routeId} pattern ${index} has no "duration": only the first stop gets times`
        );
      }

      PATTERNS[patternKey(operator, route.id, index)] = pattern;
      ROUTE_PATTERNS[operator][routeId].push(pattern);

      // Let every stop of the pattern know that the line serves it
      new Set(stopIds.map(String)).forEach(stopId => {

        const stop = getStop(operator, stopId);

        stop.patterns = stop.patterns ?? [];

        stop.patterns.push({
          index,
          routeId: route.id,
          fromStopId: pattern.fromStopId,
          toStopId: pattern.toStopId,
          direction: pattern.direction
        });
      });
    });
  });

  console.log(
    `Loaded extra data: ${(EXTRA.routes ?? []).length} routes, ${(EXTRA.stops ?? []).length} stops`
  );
}


// Date / weekday / minutes since midnight in Craiova (Bucharest time)
function getBucharestNow(nowMs) {

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(nowMs));

  const get = type => parts.find(part => part.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes:
      Number(get("hour")) * 60 +
      Number(get("minute")) +
      Number(get("second")) / 60
  };
}


// weekday / saturday / sunday (public holidays count as sunday)
function getDayType(info) {

  if ((EXTRA?.holidays ?? []).includes(info.date)) {
    return "sunday";
  }

  if (info.weekday === "Sat") {
    return "saturday";
  }

  if (info.weekday === "Sun") {
    return "sunday";
  }

  return "weekday";
}


// "05:30" -> 330 (hours above 24 are allowed: "24:30" = 00:30 next day)
function parseClock(text) {

  const match = /^(\d{1,2})[:.](\d{2})$/.exec(String(text).trim());

  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}


// Scheduled arrivals of the extra lines at a stop (next 24 hours)
function getExtraDepartures(operator, stop, nowMs = Date.now()) {

  if (!EXTRA) {
    return [];
  }

  const today = getBucharestNow(nowMs);

  const days = [
    { shift: -1440, info: getBucharestNow(nowMs - 86400000) },
    { shift: 0, info: today },
    { shift: 1440, info: getBucharestNow(nowMs + 86400000) }
  ].map(day => ({ shift: day.shift, type: getDayType(day.info) }));

  const results = [];
  const seen = new Set();

  (stop.patterns ?? []).forEach(item => {

    const key = patternKey(operator, item.routeId, item.index);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const pattern = PATTERNS[key];

    if (!pattern || !pattern.extra || !pattern.offsets) {
      return;
    }

    pattern.stops.forEach((stopId, index) => {

      if (String(stopId) !== String(stop.id)) {
        return;
      }

      const offset = pattern.offsets[index];

      if (offset === null || offset === undefined) {
        return;
      }

      days.forEach(day => {

        const times =
          pattern.schedule?.[day.type] ??
          pattern.schedule?.daily ??
          [];

        times.forEach(text => {

          const departure = parseClock(text);

          if (departure === null) {
            return;
          }

          const predicted =
            nowMs +
            (day.shift + departure + offset - today.minutes) * 60000;

          if (
            predicted < nowMs - 60000 ||
            predicted > nowMs + 24 * 3600000
          ) {
            return;
          }

          results.push({
            routeId: pattern.routeId,
            pattern,
            predicted,
            realtime: false
          });
        });
      });
    });
  });

  return results;
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

  mergeExtraData();

  buildStopsLayer();

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
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit"
  });
}


// Fetches .../stops/{id}/times (cached for a short while)
function requestStopTimes(operator, stop) {

  const api = getApi(operator);

  // Extra stops are not in the API: nothing to request
  if (stop.extra || !api || !api.stopsUrl) {
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

  const apiDepartures = getStopDepartures(operator, stop);
  const extraDepartures = getExtraDepartures(operator, stop);

  // Extra stops have no API timetable to wait for
  const loading = !stop.extra && apiDepartures === null;

  const departures = [
    ...(apiDepartures ?? []),
    ...extraDepartures
  ].sort((a, b) => a.predicted - b.predicted);

  let timetableHtml;

  if (departures.length === 0) {

    if (loading) {
      timetableHtml = "<li>Se încarcă...</li>";
    } else if (entry?.error) {
      timetableHtml = "<li>Orarul nu a putut fi încărcat</li>";
    } else {
      timetableHtml = "<li>Nicio sosire programată în curând</li>";
    }

  } else {

    timetableHtml = departures.slice(0, 8).map(item => {

      let headsign = "";

      if (item.pattern) {

        if (String(item.pattern.toStopId) === String(stop.id)) {
          headsign = "capăt de linie";
        } else {
          headsign =
            item.pattern.headsign ??
            getStop(operator, item.pattern.toStopId)?.name ??
            "";
        }
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

  // With a line selected in the route list, that line stays highlighted
  if (selectedRoute !== "all") {
    return;
  }

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

  // Draw the lines serving this stop when it is clicked,
  // remove them when its popup is closed.
  marker.on("click", () => showStopRoutes(marker, operator, stop));

  marker.on("popupopen", () => {
    openStop = { marker, operator, stop };
  });

  marker.on("popupclose", () => {

    if (openStop && openStop.marker === marker) {
      openStop = null;
    }

    if (selectedStopMarker === marker) {
      clearStopRoutes();
    }

    // Deferred: removing a marker while its popup is closing
    // would re-enter this handler.
    setTimeout(updateStopsVisibility, 0);
  });

  return marker;
}


function buildStopsLayer() {

  stopsLayer.clearLayers();
  stopMarkers.clear();

  Object.entries(STOPS).forEach(([operator, stops]) => {

    Object.values(stops).forEach(stop => {
      stopMarkers.set(
        `${operator}|${stop.id}`,
        createStopMarker(operator, stop)
      );
    });
  });

  buildStopSearchIndex();

  updateStopsVisibility();
}


// Which stops should be on the map right now:
// - a line is selected in the route list -> only the stops of that line
// - otherwise -> every stop, but only when zoomed in
function getWantedStopKeys() {

  const wanted = new Set();

  if (selectedRoute !== "all") {

    (ROUTE_PATTERNS[OPERATOR]?.[String(selectedRoute)] ?? [])
      .forEach(pattern => {
        (pattern.stops ?? []).forEach(stopId => {
          wanted.add(`${OPERATOR}|${stopId}`);
        });
      });

  } else if (map.getZoom() >= STOP_MIN_ZOOM) {

    stopMarkers.forEach((marker, key) => wanted.add(key));
  }

  return wanted;
}


function updateStopsVisibility() {

  const wanted = getWantedStopKeys();

  stopMarkers.forEach((marker, key) => {

    const shown = stopsLayer.hasLayer(marker);

    // A stop with an open popup / highlighted lines is never hidden
    const keep =
      wanted.has(key) ||
      (openStop && openStop.marker === marker) ||
      selectedStopMarker === marker;

    if (keep && !shown) {
      stopsLayer.addLayer(marker);
    } else if (!keep && shown) {
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
function drawPatternLine(
  operator,
  routeId,
  pattern,
  weight = 5,
  layer = routeLayer
) {

  const hex = safeHex(
    ROUTE_META[operator]?.[String(routeId)]?.color
  );

  const color = hex ? `#${hex}` : "#3388ff";

  const stops = (pattern.stops ?? [])
    .map(stopId => getStop(operator, stopId))
    .filter(Boolean);

  if (!pattern._points && pattern.geometry) {
    pattern._points = decodePolyline(pattern.geometry);
  }

  let points = pattern._points ?? [];

  if (points.length > 1) {

    L.polyline(points, {
      pane: "routePane",
      interactive: false,
      color,
      weight,
      opacity: 0.85
    }).addTo(layer);

  } else if (stops.length > 1) {

    // No drawn geometry for this pattern: connect the stops
    points = stops.map(stop => [stop.lat, stop.lng]);

    L.polyline(points, {
      pane: "routePane",
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

  const { color, stops } = drawPatternLine(
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

  // With a line selected in the route list, that line stays highlighted
  if (selectedRoute !== "all") {
    return;
  }

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
// ROUTE LIST
// ============================================================

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


// Every route of the network, also the ones with no vehicles now
function getAllRoutes() {

  const routes = [];
  const labels = new Set();

  const add = routeId => {

    const id = String(routeId);
    const indicative = getRouteIndicative(OPERATOR, id);

    routes.push({ routeId: id, indicative });
    labels.add(normalizeText(indicative));
  };

  // Routes from the API (and extra.json)
  Object.keys(ROUTE_META[OPERATOR] ?? {}).forEach(add);

  // Fallback: routes only known from routes.json / running vehicles
  const addIfNew = routeId => {

    const id = String(routeId);

    if (routes.some(route => route.routeId === id)) {
      return;
    }

    if (labels.has(normalizeText(getRouteIndicative(OPERATOR, id)))) {
      return;
    }

    add(id);
  };

  Object.keys(ROUTES[OPERATOR] ?? {}).forEach(addIfNew);

  allVehicles.forEach(vehicle => {

    if (vehicle.routeId !== null && vehicle.routeId !== undefined) {
      addIfNew(vehicle.routeId);
    }
  });

  return routes.sort((a, b) =>
    compareIndicatives(a.indicative, b.indicative)
  );
}


function updateRouteFilter() {

  const routeFilter =
    document.getElementById("routeFilter");

  const routes = getAllRoutes();

  const signature = routes
    .map(route => `${route.routeId}:${route.indicative}`)
    .join("|");

  // Rebuild only when the list changes, so an open list is not reset
  if (signature === routeListSignature) {
    return;
  }

  routeListSignature = signature;

  routeFilter.innerHTML =
    '<option value="all">All routes</option>';

  routes.forEach(route => {

    const option = document.createElement("option");

    option.value = route.routeId;
    option.textContent = route.indicative;

    routeFilter.appendChild(option);
  });

  if (
    selectedRoute !== "all" &&
    routes.some(route => route.routeId === String(selectedRoute))
  ) {

    routeFilter.value = selectedRoute;

  } else {

    routeFilter.value = "all";

    if (selectedRoute !== "all") {
      selectedRoute = "all";
      applyRouteSelection();
    }
  }
}


// Highlights the line(s) of the selected route and shows its stops.
function applyRouteSelection() {

  routeSelectionLayer.clearLayers();

  // Drop highlights made by clicking a bus or a stop
  clearVehicleRoute();
  clearStopRoutes();

  if (selectedRoute !== "all") {

    const patterns =
      ROUTE_PATTERNS[OPERATOR]?.[String(selectedRoute)] ?? [];

    const allPoints = [];

    patterns.forEach(pattern => {

      const { points } = drawPatternLine(
        OPERATOR,
        selectedRoute,
        pattern,
        5,
        routeSelectionLayer
      );

      allPoints.push(...points);
    });

    if (allPoints.length > 1) {
      map.fitBounds(allPoints, { padding: [40, 40] });
    }
  }

  updateStopsVisibility();
}


// ============================================================
// STOP SEARCH
// ============================================================

function buildStopSearchIndex() {

  stopSearchIndex = [];

  Object.entries(STOPS).forEach(([operator, stops]) => {

    Object.values(stops).forEach(stop => {

      const seen = new Set();
      const lines = [];

      (stop.patterns ?? []).forEach(pattern => {

        const routeId = String(pattern.routeId);

        if (seen.has(routeId)) {
          return;
        }

        seen.add(routeId);

        lines.push({
          routeId,
          indicative: getRouteIndicative(operator, routeId)
        });
      });

      lines.sort((a, b) =>
        compareIndicatives(a.indicative, b.indicative)
      );

      stopSearchIndex.push({
        operator,
        stop,
        name: normalizeText(stop.name),
        code: normalizeText(stop.code),
        lines,
        lineKeys: lines.map(line => normalizeText(line.indicative))
      });
    });
  });
}


// Every word typed must match the stop name, the code or one of
// the lines that serve the stop ("complex nou 25").
function searchStops(query) {

  const tokens = normalizeText(query)
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return [];
  }

  const phrase = tokens.join(" ");
  const results = [];

  stopSearchIndex.forEach(entry => {

    const words = entry.name.split(/\s+/);

    let score = entry.name.startsWith(phrase) ? 3 : 0;

    for (const token of tokens) {

      const nameStart = words.some(word => word.startsWith(token));
      const nameHas = entry.name.includes(token);
      const lineExact = entry.lineKeys.includes(token);
      const linePrefix = entry.lineKeys.some(key => key.startsWith(token));
      const codeExact = entry.code === token;

      if (!nameHas && !linePrefix && !codeExact) {
        return;
      }

      score +=
        (nameStart ? 3 : nameHas ? 1 : 0) +
        (lineExact ? 2 : linePrefix ? 1 : 0) +
        (codeExact ? 2 : 0);
    }

    results.push({ entry, score });
  });

  results.sort((a, b) =>
    b.score - a.score ||
    a.entry.name.localeCompare(b.entry.name) ||
    String(a.entry.stop.code).localeCompare(String(b.entry.stop.code))
  );

  return results.slice(0, 10).map(result => result.entry);
}


function hideStopResults() {

  const list = document.getElementById("stopResults");

  if (list) {
    list.hidden = true;
  }

  activeResult = -1;
}


function renderStopResults(query) {

  const list = document.getElementById("stopResults");

  if (!normalizeText(query)) {
    hideStopResults();
    return;
  }

  activeResult = -1;

  if (stopSearchIndex.length === 0) {

    searchResults = [];

    list.innerHTML =
      '<li class="stop-result-empty">Stops are still loading...</li>';

  } else {

    searchResults = searchStops(query);

    list.innerHTML = searchResults.length
      ? searchResults.map((entry, index) => `
          <li class="stop-result" data-index="${index}">
            <span class="stop-result-name">
              ${escapeHtml(entry.stop.name)}${entry.stop.code
                ? ` <small>(${escapeHtml(entry.stop.code)})</small>`
                : ""}
            </span>
            <span class="stop-result-lines">
              ${entry.lines
                .map(line => routeBadge(entry.operator, line.routeId))
                .join(" ")}
            </span>
          </li>
        `).join("")
      : '<li class="stop-result-empty">No stops found</li>';
  }

  list.hidden = false;
}


function setActiveResult(index) {

  const items = document.querySelectorAll("#stopResults .stop-result");

  if (items.length === 0) {
    return;
  }

  activeResult = (index + items.length) % items.length;

  items.forEach((item, position) => {
    item.classList.toggle("active", position === activeResult);
  });

  items[activeResult].scrollIntoView({ block: "nearest" });
}


// Moves the map to the stop and opens its popup,
// exactly like clicking the stop.
function goToStop(entry) {

  const marker = stopMarkers.get(`${entry.operator}|${entry.stop.id}`);

  if (!marker) {
    return;
  }

  const input = document.getElementById("stopSearch");

  input.value = entry.stop.name;
  input.blur();

  hideStopResults();

  // The stop may be hidden (zoomed out / other line selected)
  if (!stopsLayer.hasLayer(marker)) {
    stopsLayer.addLayer(marker);
  }

  map.setView(
    [entry.stop.lat, entry.stop.lng],
    Math.max(map.getZoom(), 17),
    { animate: false }
  );

  marker.openPopup();

  showStopRoutes(marker, entry.operator, entry.stop);
}


function setupStopSearch() {

  const input = document.getElementById("stopSearch");
  const list = document.getElementById("stopResults");

  if (!input || !list) {
    return;
  }

  input.addEventListener("input", () => {
    renderStopResults(input.value);
  });

  input.addEventListener("focus", () => {
    renderStopResults(input.value);
  });

  input.addEventListener("keydown", event => {

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResult(activeResult + 1);

    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResult(activeResult - 1);

    } else if (event.key === "Enter") {

      event.preventDefault();

      const entry = searchResults[activeResult >= 0 ? activeResult : 0];

      if (entry) {
        goToStop(entry);
      }

    } else if (event.key === "Escape") {
      hideStopResults();
    }
  });

  list.addEventListener("click", event => {

    const item = event.target.closest(".stop-result");

    if (!item) {
      return;
    }

    const entry = searchResults[Number(item.dataset.index)];

    if (entry) {
      goToStop(entry);
    }
  });

  document.addEventListener("click", event => {

    if (!event.target.closest(".stop-search")) {
      hideStopResults();
    }
  });
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
    selectedRoute !== "all" && vehicles.length === 0
      ? `No vehicles on this line right now • Last update: ${time}`
      : `${vehicles.length} vehicles shown • Last update: ${time}`;
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
  .addEventListener(
    "change",
    event => {

      selectedRoute =
        event.target.value;

      applyRouteSelection();

      displayVehicles();
    }
  );


// ============================================================
// STOP SEARCH
// ============================================================

setupStopSearch();


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