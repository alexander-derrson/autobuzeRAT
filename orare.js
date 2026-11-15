// ============================================================
// orare.js - pagina "Orare" (orare.html) si orarul unei linii (linie.html)
// ============================================================
//
//  - liniile urbane (tramvai + autobuz): orarul din data/orare.json,
//    trecut manual / calculat din documentul de program (PDF)
//  - liniile metropolitane: orele de plecare din "schedule" (data/extra.json)
//  - API-ul este folosit doar pentru lista de linii (nume, culori),
//    NU pentru ore.

const OPERATOR = "RAT Craiova";

const API_BASE =
  "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53/transport/planner";

const ROUTES_URL = `${API_BASE}/routes`;
const STOPS_URL = `${API_BASE}/stops`;

const DAY_TYPES = [
  { key: "weekday", label: "Luni – Vineri" },
  { key: "saturday", label: "Sâmbătă" },
  { key: "sunday", label: "Duminică" },
  { key: "holiday", label: "Sărbători" }
];

let LINES = [];          // toate liniile
let STOP_NAMES = {};     // stopId -> nume
let HOLIDAYS = [];       // din extra.json
let MANUAL = {};         // din orare.json (cheie = indicativ)
let MANUAL_LOADED = false;
let MANUAL_INFO = {};    // din orare.json ("info": perioade speciale etc.)


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


// weekday / saturday / sunday / holiday
function dayTypeOf(date, weekday) {

  if (HOLIDAYS.includes(date)) {
    return "holiday";
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

  const [apiRoutes, apiStops, localRoutes, extra, manual] = await Promise.all([
    getJson(ROUTES_URL).catch(error => {
      console.warn("Nu s-au putut încărca liniile din API:", error);
      return null;
    }),
    getJson(STOPS_URL).catch(error => {
      console.warn("Nu s-au putut încărca stațiile din API:", error);
      return null;
    }),
    getJson("data/routes.json").catch(() => ({})),
    getJson("data/extra.json").catch(() => null),
    getJson("data/orare.json").catch(error => {
      console.warn("Nu s-a putut încărca data/orare.json:", error);
      return null;
    })
  ]);

  MANUAL_LOADED = Boolean(manual?.lines);
  MANUAL = manual?.lines ?? {};
  MANUAL_INFO = manual?.info ?? {};

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
        byDate: new Map(), // API: data -> Set(minute din zi)
        times: new Map(),  // API: tip de zi -> {date, minutes[]}
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

  const manual = MANUAL[line.indicative];

  if (manual) {
    if (manual.itinerary) {
      return manual.itinerary;
    }

    return manual.ends.length === 1
      ? `${manual.ends[0]} (circulară)`
      : manual.ends.join(" - ");
  }

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

const MANUAL_DAYS = [
  { key: "weekday", label: "Luni – Vineri" },
  { key: "weekend", label: "Sâmbătă – Duminică" },
  { key: "holiday", label: "Sărbători" }
];

const PROGRAMS = [
  { key: "normal", label: "Program normal" },
  { key: "vacation", label: "Program vacanță" }
];


// Pastele ortodox (calendar iulian + 13 zile), pentru 1900-2099
function orthodoxEaster(year) {

  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;

  return Date.UTC(year, month - 1, day + 13);
}


// weekday / weekend / holiday (programul special: 1 ian, 25 dec, Pastele
// ortodox - duminica si luni; celelalte sarbatori legale = ca weekendul)
function manualDayType(date, weekday) {

  const [year, month, day] = date.split("-").map(Number);

  if ((month === 1 && day === 1) || (month === 12 && day === 25)) {
    return "holiday";
  }

  const today = Date.UTC(year, month - 1, day);
  const easter = orthodoxEaster(year);

  if (today === easter || today === easter + 86400000) {
    return "holiday";
  }

  if (weekday === "Sat" || weekday === "Sun" || HOLIDAYS.includes(date)) {
    return "weekend";
  }

  return "weekday";
}


// normal: 6 ian - 15 iun, 11 sep - 20 dec
// vacanta: 16 iun - 10 sep, 21 dec - 5 ian
function programOf(date) {

  const [, month, day] = date.split("-").map(Number);
  const md = month * 100 + day;

  return (md >= 616 && md <= 910) || md >= 1221 || md <= 105
    ? "vacation"
    : "normal";
}


function parseTimes(text) {

  return String(text ?? "")
    .split(/\s+/)
    .map(parseClock)
    .filter(value => value !== null);
}


function timetableTable(minutes, starred) {

  const hours = new Map();

  minutes.forEach(total => {

    const hour = Math.floor(total / 60);

    if (!hours.has(hour)) {
      hours.set(hour, []);
    }

    hours.get(hour).push(total);
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
            <td>${mins.map(total => `<span class="orar-min">${pad(total % 60)}${starred && starred(total) ? '<span class="orar-star">*</span>' : ""}</span>`).join("")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}


function sectionHtml(title, destination, minutes, footExtra, starred) {

  const body = minutes.length > 0
    ? timetableTable(minutes, starred)
    : '<div class="orar-empty">Nicio plecare în acest tip de zi.</div>';

  const foot = minutes.length > 0
    ? `<div class="orar-foot">${minutes.length} plecări${footExtra ? ` · ${escapeHtml(footExtra)}` : ""}</div>`
    : "";

  return `
    <section class="orar-section">
      <div class="orar-section-head">
        ${escapeHtml(title)}
        <small>${escapeHtml(destination)}</small>
      </div>
      ${body}
      ${foot}
    </section>
  `;
}


function lineHeader(line, subtitle) {

  const background = line.color ? `#${line.color}` : "#666666";
  const foreground = line.textColor
    ? `#${line.textColor}`
    : readableTextColor(line.color);

  return `
    <div class="line-head">
      <span class="line-badge" style="background:${background}; color:${foreground};">
        ${escapeHtml(line.indicative)}
      </span>
      <h2>Linia ${escapeHtml(line.indicative)}</h2>
      ${subtitle ? `<span class="line-sub">${escapeHtml(subtitle)}</span>` : ""}
    </div>
  `;
}


function tabsHtml(id, items, selected, attribute) {

  return `
    <div class="vehicle-tabs day-tabs" id="${id}" role="tablist">
      ${items.map(item => `
        <button type="button"
                class="vehicle-tab${item.key === selected ? " selected" : ""}"
                ${attribute}="${item.key}" role="tab"
                aria-selected="${item.key === selected}">
          ${item.label}
        </button>
      `).join("")}
    </div>
  `;
}


function bindTabs(id, attribute, onSelect) {

  document.getElementById(id).addEventListener("click", event => {

    const tab = event.target.closest(".vehicle-tab");

    if (!tab) {
      return;
    }

    document.querySelectorAll(`#${id} .vehicle-tab`).forEach(item => {
      const selected = item === tab;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });

    onSelect(tab.getAttribute(attribute));
  });
}


// Perioada speciala (ex. Targul de Craciun) in care se afla data data
function specialPeriodFor(date, periodKey) {

  const period = MANUAL_INFO.specialPeriods?.[periodKey];

  if (!period) {
    return null;
  }

  const active = (period.ranges ?? []).some(
    ([from, to]) => date >= from && date <= to
  );

  return { ...period, active };
}


// ---- Linii urbane: data/orare.json
function renderManual(line, def) {

  const content = document.getElementById("content");
  const now = bucharestParts(Date.now());

  const special = def.special ? specialPeriodFor(now.date, def.special.period) : null;

  const days = [...MANUAL_DAYS];

  if (special) {
    days.push({ key: "special", label: special.label ?? "Program special" });
  }

  let day = special?.active ? "special" : manualDayType(now.date, now.weekday);
  let program = programOf(now.date);

  content.innerHTML = `
    ${lineHeader(line, lineSubtitle(line))}
    ${def.lineNote ? `<p class="orare-note" style="margin:0 0 12px;">${escapeHtml(def.lineNote)}</p>` : ""}
    ${tabsHtml("dayTabs", days, day, "data-day")}
    <div id="programWrap">
      ${tabsHtml("programTabs", PROGRAMS, program, "data-program")}
    </div>
    <div id="orarCallout"></div>
    <div class="orar-grid" id="orarGrid"></div>
    <div id="orarInfo"></div>
    <p class="orare-note" id="orarNote"></p>
  `;

  function draw() {

    document.getElementById("programWrap").hidden =
      day === "holiday" || day === "special";

    const schedule = day === "special"
      ? def.special
      : day === "holiday"
        ? def.schedules?.holiday
        : def.schedules?.[day]?.[program];

    const grid = document.getElementById("orarGrid");
    const info = document.getElementById("orarInfo");
    const note = document.getElementById("orarNote");

    const holidayText =
      "Program valabil în zilele de 1 ianuarie, 25 decembrie și la Paștele " +
      "ortodox (duminică și luni). La celelalte sărbători legale se folosește " +
      "programul de sâmbătă sau duminică.";

    const notes = [];

    if (day === "holiday") {
      notes.push(holidayText);
    }

    if (day === "special" && special) {

      const ranges = (special.ranges ?? [])
        .map(([from, to]) => `${formatDate(from)} – ${formatDate(to)}`)
        .join(", ");

      notes.push(
        `Valabil în perioada ${ranges}` +
        `${special.active ? "" : " (în prezent în afara perioadei)"}.`
      );
    }

    if (schedule?.note) {
      notes.push(schedule.note);
    }

    note.textContent = notes.join(" ");

    const callout = document.getElementById("orarCallout");

    callout.innerHTML = schedule?.star
      ? `<div class="orar-callout"><span class="orar-star">*</span> ${escapeHtml(schedule.star.text.replace(/^\*\s*/, ""))}</div>`
      : "";

    const ranges = (schedule?.star?.ranges ?? [])
      .map(([from, to]) => [parseClock(from), parseClock(to)]);

    const starred = ranges.length > 0
      ? total => ranges.some(([from, to]) => total >= from && total <= to)
      : null;

    if (!schedule || schedule.service === false) {

      grid.innerHTML =
        `<div class="orare-error">Nu circulă în acest tip de zi.${def.note ? ` ${escapeHtml(def.note)}` : ""}</div>`;
      info.innerHTML = "";
      return;
    }

    const ends = schedule.ends ?? def.ends;

    grid.innerHTML = ends.map((end, index) => sectionHtml(
      `Plecări din ${end}`,
      ends.length === 2 ? `spre ${ends[1 - index]}` : "linie circulară",
      parseTimes(schedule.times?.[index]),
      schedule.explicit ? "orar din documentul de program" : "orar calculat din intervale",
      starred
    )).join("");

    info.innerHTML = schedule.bands
      ? `
        <div class="orar-section orar-bands">
          <div class="orar-section-head">Intervale de succedare</div>
          <table class="orar-table">
            <thead><tr><th>Interval orar</th><th>Succedare</th><th>Vehicule</th></tr></thead>
            <tbody>
              ${schedule.bands.map(band => `
                <tr>
                  <td>${escapeHtml(band.from)} – ${escapeHtml(band.to)}</td>
                  <td>${band.interval ? `${band.interval} min` : "fără curse"}</td>
                  <td>${band.vehicles ?? "–"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `
      : "";
  }

  bindTabs("dayTabs", "data-day", value => { day = value; draw(); });
  bindTabs("programTabs", "data-program", value => { program = value; draw(); });

  draw();
  setStatus(`Linia ${line.indicative}`);
}


// ---- Linii metropolitane: data/extra.json
function renderExtra(line) {

  const content = document.getElementById("content");
  const sections = buildSections(line);
  const now = bucharestParts(Date.now());

  const types = [
    { key: "weekday", label: "Luni – Vineri" },
    { key: "saturday", label: "Sâmbătă" },
    { key: "sunday", label: "Duminică" },
    { key: "holiday", label: "Sărbători" }
  ];

  let day = HOLIDAYS.includes(now.date)
    ? "holiday"
    : now.weekday === "Sat" ? "saturday"
    : now.weekday === "Sun" ? "sunday"
    : "weekday";

  content.innerHTML = `
    ${lineHeader(line, lineSubtitle(line))}
    ${tabsHtml("dayTabs", types, day, "data-day")}
    <div class="orar-grid" id="orarGrid"></div>
  `;

  function minutesFor(section) {

    const all = new Set();

    section.schedules.forEach(schedule => {

      const list =
        schedule[day] ??
        (day === "holiday" ? schedule.sunday : undefined) ??
        schedule.daily ??
        [];

      list.forEach(text => {

        const value = parseClock(text);

        if (value !== null) {
          all.add(value);
        }
      });
    });

    return [...all].sort((a, b) => a - b);
  }

  function draw() {

    document.getElementById("orarGrid").innerHTML = sections.map(section =>
      sectionHtml(
        `Plecări din ${stopName(section.fromId)}`,
        `spre ${section.headsign || stopName(section.toId)}`,
        minutesFor(section),
        ""
      )
    ).join("");
  }

  bindTabs("dayTabs", "data-day", value => { day = value; draw(); });

  draw();
  setStatus(`Linia ${line.indicative}`);
}


function renderLine() {

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

  const manual = MANUAL[line.indicative];

  if (manual) {
    renderManual(line, manual);
  } else if (line.extra) {
    renderExtra(line);
  } else {

    content.innerHTML = `
      ${lineHeader(line, lineSubtitle(line))}
      <div class="orare-error">${MANUAL_LOADED
        ? "Orarul acestei linii nu este disponibil încă."
        : "Nu s-a putut încărca fișierul <b>data/orare.json</b>. Verifică dacă există în folderul <b>data</b>, cu exact acest nume, și că este servit de site."}</div>
    `;

    setStatus(`Linia ${line.indicative}`);
  }
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

      renderLine();

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
