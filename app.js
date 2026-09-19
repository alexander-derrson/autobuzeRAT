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
      lat: Number(lat),
      lng: Number(lng)
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
      color,
      weight: 5,
      opacity: 0.85
    }).addTo(routeLayer);

  } else if (stops.length > 1) {

    // No drawn geometry for this pattern: connect the stops
    L.polyline(
      stops.map(stop => [stop.lat, stop.lng]),
      {
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

    L.circleMarker([stop.lat, stop.lng], {
      radius: 5,
      color,
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1
    })
      .bindTooltip(escapeHtml(stop.name))
      .addTo(routeLayer);
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