require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;

// --------------------
// In-memory stores
// --------------------
const liveFlights = new Map();   // callsign -> merged flight
const flightPlans = new Map();   // callsign -> plan
const controllers = new Map();   // key -> controller
const atis = new Map();          // airport -> atis
const missingCounts = new Map(); // callsign -> missed cycles

const stats = {
  flightsOnline: 0,
  airborne: 0,
  ground: 0,
  controllersOnline: 0,
  emergencies: 0,
  lastUpdate: null
};

// --------------------
// Helpers
// --------------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ATC24-Backend" }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

// --------------------
// REST Pollers
// --------------------
async function pollFlightPlans() {
  try {
    const data = await fetchJSON("https://24data.ptfs.app/flight-plans");
    flightPlans.clear();

    for (const plan of data) {
      flightPlans.set(plan.callsign, plan);
    }

    log("Flight plans:", flightPlans.size);
  } catch (err) {
    log("Flight plans error:", err.message);
  }
}

async function pollControllers() {
  try {
    const data = await fetchJSON("https://24data.ptfs.app/controllers");
    controllers.clear();

    for (const c of data) {
      const key = `${c.airport}-${c.position}`;
      controllers.set(key, c);
    }

    stats.controllersOnline =
      data.filter(x => x.holder !== null).length;

    log("Controllers:", stats.controllersOnline);
  } catch (err) {
    log("Controllers error:", err.message);
  }
}

async function pollATIS() {
  try {
    const data = await fetchJSON("https://24data.ptfs.app/atis");
    atis.clear();

    for (const a of data) {
      atis.set(a.airport, a);
    }

    log("ATIS:", atis.size);
  } catch (err) {
    log("ATIS error:", err.message);
  }
}

// --------------------
// Flight merge logic
// --------------------
function processAircraftPayload(payload) {
  const currentSeen = new Set();

  for (const callsign of Object.keys(payload)) {
    const ac = payload[callsign];
    currentSeen.add(callsign);

   const plan = null;

    const merged = {
      callsign,
      pilot: ac.playerName,
      aircraft: ac.aircraftType,
      origin: plan?.departing || null,
      destination: plan?.arriving || null,
      altitude: ac.altitude,
      speed: ac.speed,
      heading: ac.heading,
      x: ac.position?.x ?? null,
      y: ac.position?.y ?? null,
      onGround: ac.isOnGround ?? false,
      emergency: ac.isEmergencyOccuring ?? false
    };

    const old = liveFlights.get(callsign);

    // New flight
    if (!old) {
      log("NEW FLIGHT:", callsign);
    } else {
      // Takeoff
      if (old.onGround === true && merged.onGround === false) {
        log("TAKEOFF:", callsign);
      }

      // Landing
      if (old.onGround === false && merged.onGround === true) {
        log("LANDING:", callsign);
      }

      // Emergency
      if (!old.emergency && merged.emergency) {
        log("EMERGENCY:", callsign);
      }
    }

    liveFlights.set(callsign, merged);
    missingCounts.set(callsign, 0);
  }

  // Detect ended flights
  for (const callsign of Array.from(liveFlights.keys())) {
    if (!currentSeen.has(callsign)) {
      const misses = (missingCounts.get(callsign) || 0) + 1;
      missingCounts.set(callsign, misses);

      if (misses >= 3) {
        log("FLIGHT ENDED:", callsign);
        liveFlights.delete(callsign);
        missingCounts.delete(callsign);
      }
    }
  }

  recalcStats();
}

function recalcStats() {
  let airborne = 0;
  let ground = 0;
  let emergencies = 0;

  for (const f of liveFlights.values()) {
    if (f.onGround) ground++;
    else airborne++;

    if (f.emergency) emergencies++;
  }

  stats.flightsOnline = liveFlights.size;
  stats.airborne = airborne;
  stats.ground = ground;
  stats.emergencies = emergencies;
  stats.lastUpdate = new Date().toISOString();
}

// --------------------
// WebSocket
// --------------------
function connectWS() {
  log("Connecting WS...");

  const ws = new WebSocket("wss://24data.ptfs.app/wss");

  ws.on("open", () => {
    log("WS connected");
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
console.log("RAW WS:", data);

    if (data.t === "ACFT_DATA" && data.d) {
  processAircraftPayload(data.d);
}

    } catch (err) {
      log("WS parse error:", err.message);
    }
  });

  ws.on("close", () => {
    log("WS closed, reconnecting in 5s");
    setTimeout(connectWS, 5000);
  });

  ws.on("error", (err) => {
    log("WS error:", err.message);
  });
}

// --------------------
// Routes
// --------------------
app.get("/", (req, res) => {
  res.send("ATC24 Backend Running");
});

app.get("/stats", (req, res) => {
  res.json(stats);
});

app.get("/flights", (req, res) => {
  res.json(Array.from(liveFlights.values()));
});

app.get("/controllers", (req, res) => {
  res.json(Array.from(controllers.values()));
});

app.get("/atis", (req, res) => {
  res.json(Array.from(atis.values()));
});

// --------------------
// Start
// --------------------
app.listen(PORT, () => {
  log(`Server on ${PORT}`);

  connectWS();

 //  pollFlightPlans();
  pollControllers();
  pollATIS();

  //setInterval(pollFlightPlans, 10000);
  setInterval(pollControllers, 6000);
  setInterval(pollATIS, 15000);
});