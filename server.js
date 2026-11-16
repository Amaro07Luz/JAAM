// Stevens Parking prototype server
// - Serves the web pages in /public
// - Keeps the garage state (how many cars are inside, holds, history)
// - Receives "car passed" events from camera phones over WebSocket
// - Pushes the updated state to every open app screen instantly

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- Garage setup (from the mockup: 436 spaces, 4 levels) ----------
const GARAGE_NAME = "Babbio Center Garage";
const LEVEL_CAPACITY = [109, 109, 109, 109]; // must add up to 436
const LOW_ALERT = 20; // "Alert me if the garage drops below 20 open"
const MAX_NO_SHOWS = 3; // "Repeated no-shows pause holds"
const CAMERA_TIMEOUT_MS = 15000; // camera counts as offline after 15 s of silence

// Where a counting camera can stand
const LOCATIONS = {
  entrance: { label: "Garage entrance" },
  r12: { label: "Ramp Level 1 ↔ 2", lower: 0, upper: 1 },
  r23: { label: "Ramp Level 2 ↔ 3", lower: 1, upper: 2 },
  r34: { label: "Ramp Level 3 ↔ 4", lower: 2, upper: 3 },
};

function freshState() {
  return {
    occupied: 0, // cars inside the whole garage
    levelOcc: LEVEL_CAPACITY.map(() => 0), // cars on each level
    rampsSeen: {}, // which ramps have ever had a camera (needed for per-level counts)
    holds: [], // { id, userId, userName, level, createdAt, expiresAt }
    noShows: {}, // userId -> count
    history: [], // { t, open, levelOpen: [..] }
    events: [], // last events, newest first
    carLog: [], // { t, d: +1/-1 } entrance movements, for the fill rate
  };
}

let state = freshState();
try {
  if (fs.existsSync(DATA_FILE)) {
    state = { ...freshState(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    console.log("Loaded saved state from data.json");
  }
} catch (e) {
  console.warn("Could not read data.json, starting fresh:", e.message);
}

const cameras = {}; // cameraId -> { name, location, lastSeen, inCount, outCount }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state), () => {});
  }, 500);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const capacity = () => LEVEL_CAPACITY.reduce((a, b) => a + b, 0);

function activeHolds() {
  const now = Date.now();
  return state.holds.filter((h) => h.expiresAt > now);
}

function openSpaces() {
  return Math.max(0, capacity() - state.occupied - activeHolds().length);
}

function levelOpen(i) {
  const held = activeHolds().filter((h) => h.level === i + 1).length;
  return Math.max(0, LEVEL_CAPACITY[i] - state.levelOcc[i] - held);
}

function levelsTracked() {
  return ["r12", "r23", "r34"].every((r) => state.rampsSeen[r]);
}

function recordHistory() {
  state.history.push({
    t: Date.now(),
    open: openSpaces(),
    levelOpen: LEVEL_CAPACITY.map((_, i) => levelOpen(i)),
  });
  if (state.history.length > 3000) state.history = state.history.slice(-3000);
}

function logEvent(text) {
  state.events.unshift({ t: Date.now(), text });
  state.events = state.events.slice(0, 40);
}

// Net cars per minute over the last 15 minutes (positive = filling up).
// Only real car movements at the entrance count, not manual calibrations.
function fillRate() {
  const since = Date.now() - 15 * 60 * 1000;
  state.carLog = (state.carLog || []).filter((c) => c.t >= since);
  const net = state.carLog.reduce((a, c) => a + c.d, 0);
  return net / 15;
}

// ---------- Holds ----------
function expireHolds() {
  const now = Date.now();
  let changed = false;
  state.holds = state.holds.filter((h) => {
    if (h.expiresAt <= now) {
      state.noShows[h.userId] = (state.noShows[h.userId] || 0) + 1;
      logEvent(`Hold for ${h.userName} expired (no car arrived) — space released`);
      changed = true;
      return false;
    }
    return true;
  });
  if (changed) {
    recordHistory();
    save();
  }
  return changed;
}

function createHold({ userId, userName, level, minutes }) {
  expireHolds();
  if (!userId) return { ok: false, error: "Not signed in." };
  if ((state.noShows[userId] || 0) >= MAX_NO_SHOWS)
    return { ok: false, error: "Holds are paused for your account after repeated no-shows." };
  if (state.holds.some((h) => h.userId === userId))
    return { ok: false, error: "You already have a hold. One hold at a time." };
  minutes = [10, 15, 20].includes(Number(minutes)) ? Number(minutes) : 15;
  level = Number(level) || 0; // 0 = any level
  if (level && levelsTracked() && levelOpen(level - 1) <= 0)
    return { ok: false, error: `Level ${level} is full.` };
  if (openSpaces() <= 0) return { ok: false, error: "The garage is full." };
  const hold = {
    id: Math.random().toString(36).slice(2, 10),
    userId,
    userName: userName || "Student",
    level,
    createdAt: Date.now(),
    expiresAt: Date.now() + minutes * 60000,
  };
  state.holds.push(hold);
  logEvent(`${hold.userName} is holding a space${level ? " on Level " + level : ""} for ${minutes} min`);
  recordHistory();
  save();
  return { ok: true, hold };
}

// ---------- Car events from cameras ----------
// dir "in"  = entering the garage (entrance) or driving UP a ramp
// dir "out" = leaving the garage (entrance) or driving DOWN a ramp
function handleCar(location, dir, cameraName) {
  const loc = LOCATIONS[location];
  if (!loc || !["in", "out"].includes(dir)) return;
  const cap = capacity();

  if (location === "entrance") {
    (state.carLog ||= []).push({ t: Date.now(), d: dir === "in" ? 1 : -1 });
    if (dir === "in") {
      state.occupied = clamp(state.occupied + 1, 0, cap);
      state.levelOcc[0] = clamp(state.levelOcc[0] + 1, 0, LEVEL_CAPACITY[0]);
      // A car arrived: if someone was holding a space, assume it's them and close the hold.
      if (state.holds.length) {
        state.holds.sort((a, b) => a.createdAt - b.createdAt);
        const h = state.holds.shift();
        state.noShows[h.userId] = 0;
        logEvent(`Car entered — ${h.userName}'s hold used`);
      } else logEvent(`Car entered (${cameraName})`);
    } else {
      state.occupied = clamp(state.occupied - 1, 0, cap);
      state.levelOcc[0] = clamp(state.levelOcc[0] - 1, 0, LEVEL_CAPACITY[0]);
      logEvent(`Car left (${cameraName})`);
    }
  } else {
    state.rampsSeen[location] = true;
    const from = dir === "in" ? loc.lower : loc.upper;
    const to = dir === "in" ? loc.upper : loc.lower;
    state.levelOcc[from] = clamp(state.levelOcc[from] - 1, 0, LEVEL_CAPACITY[from]);
    state.levelOcc[to] = clamp(state.levelOcc[to] + 1, 0, LEVEL_CAPACITY[to]);
    logEvent(`Car went ${dir === "in" ? "up" : "down"} to Level ${to + 1} (${cameraName})`);
  }
  recordHistory();
  save();
}

function publicState() {
  const now = Date.now();
  const open = openSpaces();
  const rate = fillRate();
  const cams = Object.entries(cameras).map(([id, c]) => ({
    id,
    name: c.name,
    location: c.location,
    locationLabel: (LOCATIONS[c.location] || {}).label || c.location,
    online: now - c.lastSeen < CAMERA_TIMEOUT_MS,
    lastSeen: c.lastSeen,
    inCount: c.inCount,
    outCount: c.outCount,
  }));
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return {
    garageName: GARAGE_NAME,
    capacity: capacity(),
    occupied: state.occupied,
    open,
    lowAlert: LOW_ALERT,
    fillRatePerMin: rate,
    minutesToFull: rate > 0.05 ? Math.round(open / rate) : null,
    levelsTracked: levelsTracked(),
    rampsSeen: state.rampsSeen,
    levels: LEVEL_CAPACITY.map((cap, i) => ({
      n: i + 1,
      capacity: cap,
      occupied: state.levelOcc[i],
      open: levelOpen(i),
    })),
    holds: activeHolds(),
    noShows: state.noShows,
    maxNoShows: MAX_NO_SHOWS,
    cameras: cams,
    events: state.events.slice(0, 15),
    history: state.history.filter((h) => h.t >= dayStart.getTime()),
    locations: Object.fromEntries(Object.entries(LOCATIONS).map(([k, v]) => [k, v.label])),
    serverTime: now,
  };
}

// ---------- Admin actions (calibration + demo tools) ----------
function handleAdmin(msg) {
  const cap = capacity();
  switch (msg.action) {
    case "setOccupied": {
      // Calibrate: "right now there are N cars inside"
      const n = clamp(Math.round(Number(msg.value) || 0), 0, cap);
      state.occupied = n;
      if (!levelsTracked()) {
        // Without ramp cameras we can't know levels; spread evenly so nothing looks broken
        let left = n;
        state.levelOcc = LEVEL_CAPACITY.map((c, i) => {
          const share = i === LEVEL_CAPACITY.length - 1 ? left : Math.min(c, Math.round(n / LEVEL_CAPACITY.length));
          left -= share;
          return clamp(share, 0, c);
        });
      }
      logEvent(`Count calibrated: ${n} cars inside`);
      break;
    }
    case "setLevel": {
      const i = Number(msg.level) - 1;
      if (i < 0 || i >= LEVEL_CAPACITY.length) return;
      state.levelOcc[i] = clamp(Math.round(Number(msg.value) || 0), 0, LEVEL_CAPACITY[i]);
      state.occupied = state.levelOcc.reduce((a, b) => a + b, 0);
      logEvent(`Level ${i + 1} calibrated: ${state.levelOcc[i]} cars`);
      break;
    }
    case "simulate":
      handleCar(msg.location || "entrance", msg.dir === "out" ? "out" : "in", "manual button");
      return;
    case "clearHolds":
      state.holds = [];
      state.noShows = {};
      logEvent("All holds cleared");
      break;
    case "resetRamps":
      state.rampsSeen = {};
      logEvent("Ramp cameras forgotten (levels back to 'not counted')");
      break;
    case "reset":
      state = freshState();
      logEvent("Everything reset");
      break;
    default:
      return;
  }
  recordHistory();
  save();
}

// ---------- Static file server ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(publicState()));
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  if (file === "/camera") file = "/camera.html";
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

// ---------- WebSocket (live updates) ----------
const wss = new WebSocketServer({ server });

function broadcast() {
  const msg = JSON.stringify({ type: "state", state: publicState() });
  for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", state: publicState() }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "camera_hello" || msg.type === "heartbeat") {
      const c = (cameras[msg.cameraId] ||= { inCount: 0, outCount: 0 });
      c.name = msg.name || "Camera";
      c.location = LOCATIONS[msg.location] ? msg.location : "entrance";
      c.lastSeen = Date.now();
      if (msg.type === "camera_hello") broadcast();
      return;
    }

    if (msg.type === "count") {
      const c = (cameras[msg.cameraId] ||= { inCount: 0, outCount: 0, name: msg.name || "Camera" });
      c.lastSeen = Date.now();
      c.location = LOCATIONS[msg.location] ? msg.location : c.location || "entrance";
      if (msg.dir === "in") c.inCount++;
      else c.outCount++;
      handleCar(c.location, msg.dir, c.name || "Camera");
      ws.send(JSON.stringify({ type: "count_ack", id: msg.id }));
      broadcast();
      return;
    }

    if (msg.type === "hold") {
      const result = createHold(msg);
      ws.send(JSON.stringify({ type: "hold_result", ...result }));
      broadcast();
      return;
    }

    if (msg.type === "cancel_hold") {
      const before = state.holds.length;
      state.holds = state.holds.filter((h) => h.userId !== msg.userId);
      if (state.holds.length !== before) {
        logEvent("A hold was cancelled");
        recordHistory();
        save();
      }
      broadcast();
      return;
    }

    if (msg.type === "admin") {
      handleAdmin(msg);
      broadcast();
    }
  });
});

// Expire holds and refresh camera online/offline status every few seconds
setInterval(() => {
  expireHolds();
  broadcast();
}, 5000);

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    const nets = require("os").networkInterfaces();
    const ips = Object.values(nets).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
    console.log(`\nStevens Parking prototype running`);
    console.log(`  App (this computer):     http://localhost:${PORT}`);
    console.log(`  Camera (this computer):  http://localhost:${PORT}/camera`);
    ips.forEach((ip) => console.log(`  Same Wi-Fi:              http://${ip}:${PORT}   (camera needs HTTPS on phones, see README)`));
    console.log("");
  });
}

module.exports = { server, handleCar, createHold, publicState, handleAdmin, _state: () => state };
