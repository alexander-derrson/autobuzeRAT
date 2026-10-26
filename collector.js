// collector.js - keeps data/lastseen.json up to date, even when nobody has
// the website open. Run it on any always-on machine that serves the site:
//
//   node collector.js            (polls every 10 seconds, forever)
//   node collector.js --once     (one poll, e.g. from cron / a scheduled job)
//
// Needs Node 18+. The website reads data/lastseen.json for the
// "All vehicles" table; vehicles that are no longer in data/vehicles.json
// are dropped from it.

const fs = require("fs");
const path = require("path");

const OPERATOR = "RAT Craiova";

const VEHICLES_API =
  "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53/transport/planner/vehicles";

const DATA_DIR = path.join(__dirname, "data");
const OUT_FILE = path.join(DATA_DIR, "lastseen.json");
const VEHICLES_FILE = path.join(DATA_DIR, "vehicles.json");

const INTERVAL_MS = 10000;


// The API sends some vehicles as S01-S29; they are 001-029 everywhere else
function normalizeLabel(label) {

  const text = String(label ?? "").trim();
  const match = text.match(/^S(\d{2})$/i);

  return match ? `0${match[1]}` : text;
}


function readJson(file, fallback) {

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}


async function poll() {

  const response = await fetch(VEHICLES_API);

  if (!response.ok) {
    throw new Error(`vehicles API returned ${response.status}`);
  }

  const feed = await response.json();

  if (!Array.isArray(feed)) {
    throw new Error("vehicles API did not return an array");
  }

  // Re-read on every poll so edits to vehicles.json apply immediately
  const known = readJson(VEHICLES_FILE, {})[OPERATOR] ?? {};
  const previous = readJson(OUT_FILE, {})[OPERATOR] ?? {};

  const result = {};

  // Keep only vehicles that are still listed in vehicles.json
  Object.keys(known).forEach(label => {
    if (previous[label]) {
      result[label] = previous[label];
    }
  });

  feed.forEach(vehicle => {

    const label = normalizeLabel(vehicle.label);

    if (!(label in known)) {
      return;
    }

    const parsed = Date.parse(vehicle.lastUpdated);
    const t = Number.isFinite(parsed) ? parsed : Date.now();

    result[label] = {
      t: Math.max(result[label]?.t ?? 0, t),
      routeId: vehicle.routeId ?? result[label]?.routeId ?? null
    };
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Write to a temp file first so the website never reads half a file
  const temp = `${OUT_FILE}.tmp`;

  fs.writeFileSync(temp, JSON.stringify({ [OPERATOR]: result }));
  fs.renameSync(temp, OUT_FILE);

  console.log(
    `${new Date().toISOString()}  ${feed.length} vehicles in feed, ` +
    `${Object.keys(result).length} tracked`
  );
}


async function run() {

  try {
    await poll();
  } catch (error) {
    console.error("Poll failed:", error.message);
  }

  if (process.argv.includes("--once")) {
    return;
  }

  setTimeout(run, INTERVAL_MS);
}

run();
