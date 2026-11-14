// ============================================================
// orare.js - pagina "Orare" (orare.html) si orarul unei linii (linie.html)
// ============================================================
//
//  - liniile metropolitane (data/extra.json): orele de plecare din
//    "schedule" (luni-vineri / sambata / duminica)
//  - celelalte linii (API): orele PROGRAMATE (scheduledArrival) ale
//    capetelor de linie, luate din  .../stops/{id}/times .
//    Intarzierile / "realtime" / vehiculele de pe harta NU sunt folosite.

const OPERATOR = "RAT Craiova";

const API_BASE =
  "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53/transport/planner";

const ROUTES_URL = `${API_BASE}/routes`;
const STOPS_URL = `${API_BASE}/stops`;

const DAY_TYPES = [
  { key: "weekday", label: "Luni – Vineri" },
  { key: "saturday", label: "Sâmbătă" },
  { key: "sunday", label: "Duminică și sărbători" }
];

let LINES = [];          // toate liniile
let STOP_NAMES = {};     // stopId -> nume
let HOLIDAYS = [];       // din extra.json


// ------------------------------------------------------------
// Utilitare
// ------------------------------------------------------------

function escapeHtml(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


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

  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
    ? "#000000"
    : "#ffffff";
}


function compareIndicatives(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}


function normalizeText(value) {

  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}


function setStatus(text) {
  document.getElementById("status").textContent = text;
}


function stopName(id) {
  return STOP_NAMES[String(id)] ?? `Stația ${id}`;
}


// Data / zi / ora in Craiova
function bucharestParts(ms) {

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(ms));

  const get = type => parts.find(part => part.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}


// weekday / saturday / sunday (sarbatorile conteaza ca duminica)
function dayTypeOf(date, weekday) {

  if (HOLIDAYS.includes(date)) {
    return "sunday";
  }

  if (weekday === "Sat") {
    return "saturday";
  }

  if (weekday === "Sun") {
    return "sunday";
  }

  return "weekday";
}


function formatDate(iso) {

  const [year, month, day] = iso.split("-");

  return `${day}.${month}.${year}`;
}


// "05:30" -> 330 ("24:30" = 00:30 a doua zi)
function parseClock(text) {

  const match = /^(\d{1,2})[:.](\d{2})$/.exec(String(text).trim());

  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}


async function getJson(url) {

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }

  return response.json();
}


// ------------------------------------------------------------
// Incarcarea datelor
// ------------------------------------------------------------

async function loadData() {

  const [apiRoutes, apiStops, localRoutes, extra] = await Promise.all([
    getJson(ROUTES_URL).catch(error => {
      console.warn("Nu s-au putut încărca liniile din API:", error);
      return null;
    }),
    getJson(STOPS_URL).catch(error => {
      console.warn("Nu s-au putut încărca stațiile din API:", error);
      return null;
    }),
    getJson("data/routes.json").catch(() => ({})),
    getJson("data/extra.json").catch(() => null)
  ]);

  const indicatives = localRoutes?.[OPERATOR] ?? {};

  HOLIDAYS = extra?.holidays ?? [];

  // ---- nume de statii (API + extra)
  STOP_NAMES = {};

  const stopList = Array.isArray(apiStops)
    ? apiStops
    : (apiStops?.stops ?? apiStops?.data ?? []);

  stopList.forEach(stop => {

    const id = stop.id ?? stop.stopId;

    if (id !== undefined && id !== null) {
      STOP_NAMES[String(id)] =
        stop.name ?? stop.stopName ?? stop.shortName ?? stop.longName ??
        `Stația ${id}`;
    }
  });

  (extra?.stops ?? []).forEach(stop => {

    if (stop.id !== undefined && !(String(stop.id) in STOP_NAMES)) {
      STOP_NAMES[String(stop.id)] = stop.name ?? `Stația ${stop.id}`;
    }
  });

  // ---- linii
  LINES = [];

  const indicativeOf = (id, fallback) =>
    indicatives[String(id)]?.indicative ?? fallback ?? String(id);

  // Linii din API
  (Array.isArray(apiRoutes) ? apiRoutes : []).forEach(route => {

    const id = String(route.id);

    LINES.push({
      id,
      indicative: indicativeOf(id, route.shortName),
      color: safeHex(route.color),
      textColor: safeHex(route.textColor),
      longName: route.longName ?? null,
      extra: false,
      patterns: (route.patterns ?? []).map(pattern => {

        const stops = pattern.stops ?? [];

        return {
          index: pattern.index,
          direction: Number(pattern.direction ?? -1),
          fromId: pattern.fromStopId ?? stops[0],
          toId: pattern.toStopId ?? stops[stops.length - 1],
          headsign: pattern.headsign ?? null
        };
      })
    });
  });

  // Linii metropolitane din extra.json
  (extra?.routes ?? []).forEach(route => {

    const id = String(route.id);

    if (LINES.some(line => line.id === id)) {
      return;
    }

    LINES.push({
      id,
      indicative: indicativeOf(id, route.shortName),
      color: safeHex(route.color),
      textColor: safeHex(route.textColor),
      longName: route.longName ?? null,
      extra: true,
      patterns: (route.patterns ?? []).map((item, position) => {

        const stops = item.stops ?? [];

        return {
          index: item.index ?? position + 1,
          direction: item.direction ?? position % 2,
          fromId: stops[0],
          toId: stops[stops.length - 1],
          headsign: item.headsign ?? null,
          schedule: item.schedule ?? {}
        };
      })
    });
  });

  // Linii cunoscute doar din routes.json (fara trasee in API)
  const labels = new Set(LINES.map(line => normalizeText(line.indicative)));

  Object.keys(indicatives).forEach(id => {

    const indicative = indicativeOf(id);

    if (
      LINES.some(line => line.id === String(id)) ||
      labels.has(normalizeText(indicative))
    ) {
      return;
    }

    labels.add(normalizeText(indicative));

    LINES.push({
      id: String(id),
      indicative,
      color: null,
      textColor: null,
      longName: null,
      extra: false,
      patterns: []
    });
  });

  LINES.sort((a, b) => compareIndicatives(a.indicative, b.indicative));

  return { apiOk: Array.isArray(apiRoutes) };
}


// ------------------------------------------------------------
// Pagina 1: lista liniilor
// ------------------------------------------------------------

// Capetele liniei: o sectiune pentru fiecare sens (capat de plecare)
function buildSections(line) {

  let patterns = line.patterns.filter(pattern => pattern.fromId !== undefined);

  // Traseul "intreaga linie" (direction -1) se foloseste doar daca nu
  // exista sensuri separate
  if (patterns.some(pattern => pattern.direction >= 0)) {
    patterns = patterns.filter(pattern => pattern.direction >= 0);
  }

  const sections = [];

  patterns.forEach(pattern => {

    const key = `${pattern.fromId}>${pattern.toId}`;

    let section = sections.find(item => item.key === key);

    if (!section) {

      section = {
        key,
        fromId: pattern.fromId,
        toId: pattern.toId,
        headsign: pattern.headsign,
        indices: new Set(),
        schedules: [],
        times: null,      // API: Map(zi -> {date, minutes[]})
        error: false
      };

      sections.push(section);
    }

    section.indices.add(String(pattern.index));

    if (pattern.schedule) {
      section.schedules.push(pattern.schedule);
    }
  });

  // Sensul 0 inaintea sensului 1 (ordinea din date)
  return sections;
}


function lineSubtitle(line) {

  const sections = buildSections(line);

  if (sections.length === 0) {
    return "";
  }

  const first = sections[0];

  if (String(first.fromId) === String(first.toId)) {
    return `${stopName(first.fromId)} (circular)`;
  }

  return `${stopName(first.fromId)} - ${stopName(first.toId)}`;
}


function renderList() {

  const content = document.getElementById("content");

  if (LINES.length === 0) {

    content.innerHTML =
      '<div class="orare-error">Nu s-au putut încărca liniile.</div>';

    return;
  }

  content.innerHTML = `
    <div class="line-grid">
      ${LINES.map(line => {

        const color = line.color ? `#${line.color}` : "#666666";
        const subtitle = lineSubtitle(line);

        return `
          <a class="line-card"
             style="--line-color: ${color};"
             href="linie.html?id=${encodeURIComponent(line.id)}">
            <span class="line-card-title">Linia ${escapeHtml(line.indicative)}</span>
            ${subtitle
              ? `<span class="line-card-sub">${escapeHtml(subtitle)}</span>`
              : ""}
          </a>
        `;
      }).join("")}
    </div>
  `;
}


// ------------------------------------------------------------
// Pagina 2: orarul unei linii
// ------------------------------------------------------------

// Din raspunsul .../stops/{id}/times pastreaza doar plecarile
// PROGRAMATE ale liniei, pe zile.
function applyApiTimes(data, line, stopId, sections) {

  const mine = sections.filter(
    section => String(section.fromId) === String(stopId)
  );

  const buckets = new Map(mine.map(section => [section, new Map()]));

  (Array.isArray(data) ? data : []).forEach(group => {

    if (String(group.route?.routeId) !== line.id) {
      return;
    }

    const index = String(group.route?.index);
    const groupTo = group.route?.toStopId;

    // 1. dupa indexul traseului, 2. dupa destinatie
    let section = mine.find(item => item.indices.has(index));

    if (!section && groupTo !== undefined && groupTo !== null) {
      section = mine.find(item => String(item.toId) === String(groupTo));
    }

    // Sosiri la acest capat (nu plecari): nu intra in orar
    if (!section && String(groupTo) === String(stopId)) {
      return;
    }

    // Un singur sens care pleaca de aici: restul grupurilor ii apartin
    if (!section && mine.length === 1) {
      section = mine[0];
    }

    if (!section) {
      return;
    }

    const byDate = buckets.get(section);

    (group.times ?? []).forEach(time => {

      // Doar ora programata, fara intarziere
      const ms = Date.parse(time.scheduledDeparture ?? time.scheduledArrival);

      if (Number.isNaN(ms)) {
        return;
      }

      const parts = bucharestParts(ms);

      if (!byDate.has(parts.date)) {

        byDate.set(parts.date, {
          type: dayTypeOf(parts.date, parts.weekday),
          minutes: new Set()
        });
      }

      byDate.get(parts.date).minutes.add(parts.minutes);
    });
  });

  mine.forEach(section => {

    const byType = new Map();

    // Pentru fiecare tip de zi se alege data cu cele mai multe plecari
    buckets.get(section).forEach((entry, date) => {

      const best = byType.get(entry.type);

      if (!best || entry.minutes.size > best.minutes.length) {

        byType.set(entry.type, {
          date,
          minutes: [...entry.minutes].sort((a, b) => a - b)
        });
      }
    });

    section.times = byType;
    section.error = false;

    console.log(
      `Linia ${line.indicative}, plecări din ${stopName(stopId)}:`,
      Object.fromEntries(
        [...byType].map(([type, value]) => [type, `${value.date}: ${value.minutes.length}`])
      )
    );
  });
}


function minutesFor(section, dayType) {

  // Linii metropolitane: din schedule
  if (section.schedules.length > 0) {

    const all = new Set();

    section.schedules.forEach(schedule => {

      (schedule[dayType] ?? schedule.daily ?? []).forEach(text => {

        const value = parseClock(text);

        if (value !== null) {
          all.add(value);
        }
      });
    });

    return { minutes: [...all].sort((a, b) => a - b), date: null };
  }

  // Linii din API
  const entry = section.times?.get(dayType);

  return entry
    ? { minutes: entry.minutes, date: entry.date }
    : { minutes: [], date: null };
}


function timetableTable(minutes) {

  const hours = new Map();

  minutes.forEach(total => {

    const hour = Math.floor(total / 60);

    if (!hours.has(hour)) {
      hours.set(hour, []);
    }

    hours.get(hour).push(total % 60);
  });

  const pad = number => String(number).padStart(2, "0");

  return `
    <table class="orar-table">
      <thead>
        <tr><th>Ora</th><th>Minute</th></tr>
      </thead>
      <tbody>
        ${[...hours].map(([hour, mins]) => `
          <tr>
            <td class="orar-hour">${pad(hour % 24)}</td>
            <td>${mins.map(m => `<span class="orar-min">${pad(m)}</span>`).join("")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}


function renderSections(line, sections, dayType) {

  const grid = document.getElementById("orarGrid");

  grid.innerHTML = sections.map(section => {

    const { minutes, date } = minutesFor(section, dayType);

    const title = `Plecări din ${stopName(section.fromId)}`;

    const destination =
      section.headsign || stopName(section.toId);

    let body;

    if (section.error) {
      body = '<div class="orar-empty">Orarul nu a putut fi încărcat.</div>';
    } else if (minutes.length === 0) {
      body = '<div class="orar-empty">Nicio plecare în acest tip de zi.</div>';
    } else {
      body = timetableTable(minutes);
    }

    const foot = minutes.length > 0
      ? `<div class="orar-foot">${minutes.length} plecări${date ? ` · orar din ${formatDate(date)}` : ""}</div>`
      : "";

    return `
      <section class="orar-section">
        <div class="orar-section-head">
          ${escapeHtml(title)}
          <small>spre ${escapeHtml(destination)}</small>
        </div>
        ${body}
        ${foot}
      </section>
    `;
  }).join("");
}


async function renderLine(apiOk) {

  const content = document.getElementById("content");
  const id = new URLSearchParams(location.search).get("id");
  const line = LINES.find(item => item.id === id);

  if (!line) {

    content.innerHTML = `
      <div class="orare-error">
        Linia nu a fost găsită. <a href="orare.html" style="color:#7aa2ff;">Înapoi la lista de linii</a>
      </div>
    `;

    return;
  }

  document.title = `Linia ${line.indicative} - Orar - RAT Craiova Tracker`;

  const background = line.color ? `#${line.color}` : "#666666";
  const foreground = line.textColor
    ? `#${line.textColor}`
    : readableTextColor(line.color);

  const sections = buildSections(line);
  const subtitle = lineSubtitle(line);

  // Ziua selectata implicit: cea de azi
  const now = bucharestParts(Date.now());
  let dayType = dayTypeOf(now.date, now.weekday);

  content.innerHTML = `
    <div class="line-head">
      <span class="line-badge" style="background:${background}; color:${foreground};">
        ${escapeHtml(line.indicative)}
      </span>
      <h2>Linia ${escapeHtml(line.indicative)}</h2>
      ${subtitle ? `<span class="line-sub">${escapeHtml(subtitle)}</span>` : ""}
    </div>

    <div class="vehicle-tabs day-tabs" id="dayTabs" role="tablist">
      ${DAY_TYPES.map(day => `
        <button type="button"
                class="vehicle-tab${day.key === dayType ? " selected" : ""}"
                data-day="${day.key}" role="tab"
                aria-selected="${day.key === dayType}">
          ${day.label}
        </button>
      `).join("")}
    </div>

    <div class="orar-grid" id="orarGrid">
      <div class="orar-empty">Se încarcă orarul...</div>
    </div>

    <p class="orare-note">
      Orele afișate sunt cele programate (orarul oficial), fără întârzieri
      sau poziția vehiculelor din timp real.
    </p>
  `;

  document.getElementById("dayTabs").addEventListener("click", event => {

    const tab = event.target.closest(".vehicle-tab");

    if (!tab) {
      return;
    }

    dayType = tab.dataset.day;

    document.querySelectorAll("#dayTabs .vehicle-tab").forEach(item => {
      const selected = item === tab;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });

    renderSections(line, sections, dayType);
  });

  if (sections.length === 0) {

    document.getElementById("orarGrid").innerHTML =
      '<div class="orare-error">Nu există date de orar pentru această linie.</div>';

    setStatus("");
    return;
  }

  // Linii metropolitane: orarul e deja in extra.json
  if (line.extra) {

    renderSections(line, sections, dayType);
    setStatus(`Linia ${line.indicative}`);
    return;
  }

  if (!apiOk) {

    sections.forEach(section => { section.error = true; });
    renderSections(line, sections, dayType);
    setStatus("API-ul nu a răspuns");
    return;
  }

  // Linii din API: orele programate din capete
  const terminals = [...new Set(sections.map(section => String(section.fromId)))];

  await Promise.all(terminals.map(async stopId => {

    try {

      const data = await getJson(`${STOPS_URL}/${stopId}/times`);

      applyApiTimes(data, line, stopId, sections);

    } catch (error) {

      console.warn(`Nu s-a putut încărca orarul stației ${stopId}:`, error);

      sections
        .filter(section => String(section.fromId) === stopId)
        .forEach(section => { section.error = true; });
    }
  }));

  renderSections(line, sections, dayType);
  setStatus(`Linia ${line.indicative}`);
}


// ------------------------------------------------------------
// Pornire
// ------------------------------------------------------------

async function start() {

  document.querySelectorAll("[data-href]").forEach(button => {
    button.addEventListener("click", () => {
      window.location.href = button.dataset.href;
    });
  });

  try {

    const { apiOk } = await loadData();

    if (document.body.dataset.page === "line") {

      await renderLine(apiOk);

    } else {

      renderList();
      setStatus(apiOk ? `${LINES.length} linii` : "API-ul nu a răspuns (listă parțială)");
    }

  } catch (error) {

    console.error(error);
    setStatus("Eroare la încărcarea datelor");

    document.getElementById("content").innerHTML =
      '<div class="orare-error">Datele nu au putut fi încărcate.</div>';
  }
}

start();
