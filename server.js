/**
 * @fileoverview HTTPS/SSE + WSS server for the heliocentric simulation.
 *
 * Responsibilities:
 *  - Serves the Angular dist bundle and static resources over HTTPS (port 3000).
 *  - Broadcasts orbital true-anomaly state to all WebSocket clients every 80 ms (port 3001).
 *  - Accepts `setSpeed` messages from clients to adjust simulation speed.
 *  - Streams the initial solar-system hierarchy to new SSE subscribers.
 *  - Persists simulation state to `universe.json` periodically and on shutdown.
 *
 * @module server
 */

import compression from 'compression';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/** HTTPS server port for Angular SPA + SSE. */
const port = 3000;

/** Dedicated WSS port for high-frequency orbit broadcasts. */
const wsPort = 3001;

const CERTS_ROOT = './certs';
const GLYPH_ROOT = './node_modules/bootstrap-icons/icons';

const STARS_DIR = path.resolve(__dirname, './resources/stars');
const PLANETS_DIR = path.resolve(__dirname, './resources/planets');
const MOONS_DIR = path.resolve(__dirname, './resources/moons');

const STATE_FILE = path.resolve(__dirname, './resources/universe.json');

/**
 * J2000.0 epoch used as the zero-point for mean-anomaly calculations.
 * All body mean anomalies are measured relative to this date.
 */
const EPOCH_DATE = new Date('2000-01-01T12:00:00Z').getTime();

/** Simulation wall-clock time in milliseconds (advances with simulationSpeed). */
let simulationTime = Date.now();

/**
 * Real-time multiplier applied to the simulation clock.
 * 1.0 = real-time (very slow for planetary motion).
 * Typical UI values: 1–1000.
 * Receives live updates via WebSocket `setSpeed` messages.
 */
let simulationSpeed = 1.0;

let lastUpdateMs = Date.now();

/** Map of body name → current true anomaly (radians). */
let bodiesTrueAnomaly = {};

/** In-memory universe hierarchy (stars → planets → moons). */
let universeStates = { stars: [] };

// ---------------------------------------------------------------------------
// Known moon semi-major axes in units of 10^5 km (same scale as planet `x`).
// Injected server-side so clients never receive moon configs without distances.
// Source: NASA Planetary Fact Sheets.
// ---------------------------------------------------------------------------

/**
 * Semi-major axes for known moons, in 10^5 km (the same unit as the planet `x` field).
 * Injected into each moon config during universe hierarchy construction.
 *
 * @type {Record<string, number>}
 */
const MOON_SEMIMAJOR_X = {
  // Earth
  Moon: 3.844,
  // Mars
  Phobos: 0.094,
  Deimos: 0.234,
  // Jupiter (Galilean)
  Io: 4.218,
  Europa: 6.711,
  Ganymede: 10.704,
  Callisto: 18.827,
  // Saturn
  Titan: 12.219,
  Rhea: 5.271,
  Dione: 3.774,
  Tethys: 2.946,
  Enceladus: 2.379,
  Iapetus: 35.608,
  // Uranus
  Titania: 4.359,
  Oberon: 5.835,
  Umbriel: 2.663,
  Ariel: 1.910,
  Miranda: 1.294,
  // Neptune
  Triton: 3.548,
};

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Logging helper for added bodies
// ---------------------------------------------------------------------------
function logAdded(type, name, meta) {
  const pad = (s, n = 7) => (s + ' '.repeat(Math.max(0, n - s.length)));
  const metaStr = meta ? ` (${meta})` : '';
  console.info(`[universe][ADD] ${pad(type)} • ${name}${metaStr}`);
}

/**
 * Strips a UTF-8 BOM character from the start of a string if present.
 *
 * @param {string} str - Raw file content.
 * @returns {string} String without a leading BOM.
 */
const stripBOM = (str) => str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;

/**
 * Solves Kepler's equation M = E − e·sin(E) for the eccentric anomaly E
 * using Newton-Raphson iteration, then converts E to the true anomaly ν.
 *
 * @param {number} M - Mean anomaly in radians.
 * @param {number} e - Orbital eccentricity (0 ≤ e < 1).
 * @returns {number} True anomaly ν in radians.
 */
function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 10; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
}

/**
 * Computes the initial true anomaly for every body in the hierarchy
 * for a given epoch, using mean-anomaly integration from J2000.
 *
 * @param {object} star      - Root star config (with nested planets/moons).
 * @param {number} startMs   - Epoch timestamp in milliseconds.
 * @returns {Record<string, number>} Map of body name → true anomaly (radians).
 */
function computeInitialTrueAnomalies(star, startMs) {
  const days = (startMs - EPOCH_DATE) / 86_400_000;
  const angles = {};
  const compute = (body) => {
    if (body.period > 0) {
      const M = ((body.M0 ?? 0) + 2 * Math.PI * days / body.period) % (2 * Math.PI);
      angles[body.name] = solveKepler(M < 0 ? M + 2 * Math.PI : M, body.eccentricity ?? 0);
    } else {
      angles[body.name] = 0;
    }
    if (body.planets) body.planets.forEach(compute);
    if (body.moons) body.moons.forEach(compute);
  };
  compute(star);
  return angles;
}

/**
 * Reads and JSON-parses a file, stripping any BOM.
 *
 * @param {string} filename - Absolute path to the JSON file.
 * @returns {any} Parsed JSON value.
 */
function readJSON(filename) {
  return JSON.parse(stripBOM(fs.readFileSync(filename, 'utf8')));
}

/**
 * Extracts the final path component (filename) from a POSIX-style path string.
 *
 * @param {string} pathStr - Path string, e.g. `/planets/earth.json`.
 * @returns {string} Filename, e.g. `earth.json`.
 */
function basenameFromPath(pathStr) {
  return pathStr.split('/').pop();
}

/**
 * Reads every `.json` file in a directory synchronously.
 *
 * @param {string} dirPath - Absolute directory path.
 * @returns {Record<string, any>} Map of filename → parsed JSON object.
 */
function readJsonFilesSync(dirPath) {
  const result = {};
  for (const entry of fs.readdirSync(dirPath)) {
    if (path.extname(entry).toLowerCase() !== '.json') continue;
    const fullPath = path.join(dirPath, entry);
    try {
      if (!fs.statSync(fullPath).isFile()) continue;
      result[entry] = JSON.parse(stripBOM(fs.readFileSync(fullPath, 'utf8')));
    } catch { /* skip malformed files */ }
  }
  return result;
}

/**
 * Checks whether a texture image path resolves to an existing file.
 *
 * @param {string|null|undefined} texturePath - Server-relative path beginning with `/images/`.
 * @returns {boolean} `true` if the file exists on disk.
 */
function textureExists(texturePath) {
  if (!texturePath || typeof texturePath !== 'string' || !texturePath.trim()) return false;
  const rel = texturePath.replace(/^\/images\//, '');
  const full = path.join(__dirname, 'resources', 'images', rel);
  return fs.existsSync(full);
}

/**
 * Checks whether a JSON resource path resolves to an existing file.
 *
 * @param {string|null|undefined} resourcePath - Server-relative path, e.g. `/planets/earth.json`.
 * @returns {boolean} `true` if the file exists on disk.
 */
function resourceExists(resourcePath) {
  if (!resourcePath || typeof resourcePath !== 'string') return false;
  return fs.existsSync(path.join(__dirname, 'resources', resourcePath.replace(/^\//, '')));
}

/**
 * Derives the `orbits` speed-multiplier block for a planet's moon array.
 * Each moon's speed is expressed relative to Earth's Moon (period 27.3 days).
 *
 * @param {object[]} moons - Array of moon config objects, each with a `period` field.
 * @returns {{ updateIntervalMs: number, baseSpeed: number, speeds: Record<string, number> }}
 */
function buildPlanetOrbitsConfig(moons) {
  const REFERENCE_PERIOD = 27.3; // Earth's Moon
  const speeds = {};
  for (const moon of moons) {
    speeds[moon.name] = REFERENCE_PERIOD / moon.period;
  }
  return { updateIntervalMs: 80, baseSpeed: 0.00667, speeds };
}

// ---------------------------------------------------------------------------
// Universe hierarchy builder
// ---------------------------------------------------------------------------

/**
 * Assembles the full star → planet → moon hierarchy from raw JSON maps.
 * Validates texture/resource paths and injects moon orbital distances.
 *
 * @param {Record<string, object>} starMap   - Map of star JSON filename → config.
 * @param {Record<string, object>} planetMap - Map of planet JSON filename → config.
 * @param {Record<string, object>} moonMap   - Map of moon JSON filename → config.
 * @returns {{ stars: object[] }} Assembled universe state.
 */
function buildUniverseHierarchy(starMap, planetMap, moonMap) {
  const TEXTURE_FIELDS = ['map', 'bumpMap', 'specMap', 'cloudMap', 'alphaMap'];
  const starsArray = [];

  // console.log(starMap, planetMap, moonMap);

  for (const [starFile, starData] of Object.entries(starMap)) {
    const starCopy = JSON.parse(JSON.stringify(starData));
    starCopy.resource = `/stars/${starFile}`;
    if (!resourceExists(starCopy.resource)) {
      console.warn(`[universe] Missing star resource: ${starCopy.resource}`);
    }

    for (const field of TEXTURE_FIELDS) {
      if (starCopy[field] && !textureExists(starCopy[field])) starCopy[field] = '';
    }

    if (Array.isArray(starCopy.planets)) {
      starCopy.planets = starCopy.planets
        .map(planetPath => {
          const key = basenameFromPath(planetPath);
          const data = planetMap[key];
          if (!data) { console.warn(`[universe] Missing planet: ${key}`); return null; }

          const p = JSON.parse(JSON.stringify(data));
          p.resource = `/planets/${key}`;
          for (const field of TEXTURE_FIELDS) {
            if (p[field] && !textureExists(p[field])) p[field] = '';
          }

          p.moons = Array.isArray(p.moons)
            ? p.moons.map(moonPath => {
              const mKey = basenameFromPath(moonPath);
              const mData = moonMap[mKey];
              if (!mData) { console.warn(`[universe] Missing moon: ${mKey}`); return null; }

              const m = JSON.parse(JSON.stringify(mData));
              m.resource = `/moons/${mKey}`;
              for (const field of TEXTURE_FIELDS) {
                if (m[field] && !textureExists(m[field])) m[field] = '';
              }

              // ── FIX: Inject semi-major axis so clients can compute visual orbits ──
              if (MOON_SEMIMAJOR_X[m.name] !== undefined) {
                m.x = MOON_SEMIMAJOR_X[m.name];
              } else {
                console.warn(`[universe] No semi-major axis for moon "${m.name}" — using 2.0`);
                m.x = 2.0;
              }

              // Log moon added (include parent planet)
              logAdded('Moon', m.name, `planet=${p.name}`);

              return m;
            }).filter(Boolean)
            : [];

          p.orbits = p.moons.length > 0 ? buildPlanetOrbitsConfig(p.moons) : null;



          // --- preserve and sanitize rings if present ---
          p.rings = Array.isArray(p.rings)
            ? p.rings.map(r => {
              const rCopy = JSON.parse(JSON.stringify(r));
              if (rCopy.texture && !textureExists(rCopy.texture)) {
                console.warn(`[universe] Missing ring texture for ${p.name}: ${rCopy.texture} — clearing`);
                rCopy.texture = '';
              }
              rCopy.inner = Number(rCopy.inner ?? 0);
              rCopy.outer = Number(rCopy.outer ?? 0);
              rCopy.thickness = Number(rCopy.thickness ?? 0.01);
              // Log ring added for this planet
              logAdded('Ring', rCopy.name ?? '(unnamed)', `owner=${p.name}`);
              return rCopy;
            }).filter(Boolean)
            : [];


          // Log planet added (include star name for context)
          logAdded('Planet', p.name, `star=${starCopy.name}`);

          return p;
        })
        .filter(Boolean);
    } else {
      starCopy.planets = [];
    }

    // sanitize star-level rings (e.g. asteroid belt)
    starCopy.rings = Array.isArray(starCopy.rings)
      ? starCopy.rings.map(r => {
        const rCopy = JSON.parse(JSON.stringify(r));
        if (rCopy.texture && !textureExists(rCopy.texture)) rCopy.texture = '';
        rCopy.inner = Number(rCopy.inner ?? 0);
        rCopy.outer = Number(rCopy.outer ?? 0);
        rCopy.thickness = Number(rCopy.thickness ?? 0.01);
        // Log each ring added at star level
        logAdded('Ring', rCopy.name ?? '(unnamed)', `owner=${starCopy.name}`);
        return rCopy;
      }).filter(Boolean)
      : [];


    starsArray.push(starCopy);
    logAdded('Star', starCopy.name);
  }

  return { stars: starsArray };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Loads universe state from `universe.json` if it exists, otherwise
 * rebuilds it from individual resource JSON files and writes an initial snapshot.
 */
function loadUniverse() {
  if (fs.existsSync(STATE_FILE)) {
    const data = JSON.parse(stripBOM(fs.readFileSync(STATE_FILE, 'utf8')));
    simulationTime = data.simulationTime ?? Date.now();
    bodiesTrueAnomaly = data.trueAnomalies ?? {};
    universeStates = { stars: data.stars ?? [] };
    console.log('[universe] Loaded from state file.');
  } else {
    const starMap = readJsonFilesSync(STARS_DIR);
    const planetMap = readJsonFilesSync(PLANETS_DIR);
    const moonMap = readJsonFilesSync(MOONS_DIR);
    universeStates = buildUniverseHierarchy(starMap, planetMap, moonMap);
    if (universeStates.stars[0]) {
      bodiesTrueAnomaly = computeInitialTrueAnomalies(universeStates.stars[0], Date.now());
      simulationTime = Date.now();
    }
    saveUniverse();
    console.log('[universe] Built fresh from resource files.');
  }
}

/**
 * Atomically writes the current simulation state (time, anomalies, hierarchy)
 * to `universe.json`.  Uses a temp-file swap to avoid corruption on crash.
 */
function saveUniverse() {
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      simulationTime,
      trueAnomalies: bodiesTrueAnomaly,
      stars: universeStates.stars,
    }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[universe] Save failed:', err.message);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

loadUniverse();

// ---------------------------------------------------------------------------
// Simulation loop — 80 ms tick, Keplerian true-anomaly integration
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  const delta = Math.min(100, now - lastUpdateMs); // cap at 100 ms to avoid jumps
  if (delta > 0) simulationTime += delta * simulationSpeed;
  lastUpdateMs = now;

  // Advance every body's true anomaly via the correct mean-anomaly pipeline.
  const update = (body) => {
    if (body.period > 0) {
      const days = (simulationTime - EPOCH_DATE) / 86_400_000;
      const M = ((body.M0 ?? 0) + 2 * Math.PI * days / body.period) % (2 * Math.PI);
      bodiesTrueAnomaly[body.name] = solveKepler(
        M < 0 ? M + 2 * Math.PI : M,
        body.eccentricity ?? 0,
      );
    }
    if (body.planets) body.planets.forEach(update);
    if (body.moons) body.moons.forEach(update);
  };
  if (universeStates.stars[0]) update(universeStates.stars[0]);

  broadcastOrbitUpdate();
}, 80);

// Periodic state persistence — every half a second.
setInterval(saveUniverse, 500);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/**
 * Broadcasts the current orbital state to every connected WebSocket client.
 */
function broadcastOrbitUpdate() {
  const msg = JSON.stringify({
    type: 'orbitUpdate',
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly,
  });
  // console.log('UPDATE', msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

const wsServer = https.createServer(httpsOptions);
const wss = new WebSocketServer({ server: wsServer });

wss.on('connection', (ws) => {
  // Send the full state snapshot immediately on connect.
  ws.send(JSON.stringify({
    type: 'orbitSync',
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly,
  }));

  // ── FIX: Handle inbound messages (setSpeed, etc.) ──
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'setSpeed') {
        const speed = parseFloat(msg.speed);
        if (!isNaN(speed)) {
          simulationSpeed = Math.max(0, Math.min(10_000, speed));
          console.log(`[ws] Simulation speed → ${simulationSpeed}×`);
        }
      }
    } catch (err) {
      console.warn('[ws] Unparseable message:', err.message);
    }
  });

  ws.on('error', (err) => console.error('[ws] Client error:', err.message));
});

wsServer.listen(wsPort, () => {
  console.log(`WSS: wss://localhost:${wsPort}`);
});

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

app.use(cors());

app.use((req, res, next) => {
  if (req.url === '/event') {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }
  next();
});

app.use(compression({
  strategy: zlib.constants.Z_RLE,
  level: 9,
  filter: (req) => req.url !== '/event',
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist/planets/browser')));
app.use('/resources', express.static(path.join(__dirname, 'resources')));
app.use('/stars', express.static(path.join(__dirname, 'resources/stars')));
app.use('/planets', express.static(path.join(__dirname, 'resources/planets')));
app.use('/moons', express.static(path.join(__dirname, 'resources/moons')));

// ---------------------------------------------------------------------------
// SSE endpoint — delivers full hierarchy once then streams glyph overlays
// ---------------------------------------------------------------------------

/**
 * Server-Sent Events endpoint.
 * Fires one `planets` event with the complete solar-system hierarchy,
 * then streams random bootstrap-icon glyph overlays at 200 ms intervals.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
app.get('/event', (req, res) => {
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Full hierarchy snapshot on connect.
  const snapshot = JSON.parse(JSON.stringify(universeStates));

  console.log('[SSE] Sending initial snapshot to new subscriber…', snapshot);
  const allBodies = [
    ...snapshot.stars[0].planets,
    snapshot.stars[0],
  ];
  res.write(`event: planets\ndata: ${JSON.stringify({ planets: allBodies, simulationTime })}\n\n`);

  // Send the full universe snapshot (same shape as resources/universe.json)
  // try {
  //   const snapshot = JSON.parse(JSON.stringify(universeStates));
  //   res.write(`event: universe\ndata: ${JSON.stringify({ universe: snapshot, simulationTime })}\n\n`);
  // } catch (err) {
  //   // Fallback: send minimal payload if serialization fails
  //   res.write(`event: universe\ndata: ${JSON.stringify({ universe: { stars: [] }, simulationTime })}\n\n`);
  // }

  // Glyph overlay stream.
  const glyphInterval = setInterval(() => {
    try {
      const icons = fs.readdirSync(GLYPH_ROOT);
      const glyph = icons[Math.floor(Math.random() * icons.length)] || 'circle.svg';
      res.write(`event: update\ndata: ${JSON.stringify({
        id: `${Math.floor(Math.random() * 128)},${Math.floor(Math.random() * 64)}`,
        glyph: fs.readFileSync(path.resolve(GLYPH_ROOT, glyph), 'utf8'),
      })}\n\n`);
    } catch { /* icon dir missing in some environments */ }
  }, 200);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(glyphInterval);
    clearInterval(keepAlive);
    res.end();
  });
});

// ---------------------------------------------------------------------------
// SPA catch-all
// ---------------------------------------------------------------------------

app.get(/^((?!\.).)*$/, (req, res) => {
  const distIndex = path.resolve(__dirname, 'dist/planets/browser/index.html');
  const viewIndex = path.resolve(__dirname, 'view/index.html');
  res.sendFile(fs.existsSync(distIndex) ? distIndex : viewIndex);
});

// ---------------------------------------------------------------------------
// HTTPS server
// ---------------------------------------------------------------------------

https.createServer(httpsOptions, app).listen(port, () => {
  console.log(`HTTPS/SSE: https://localhost:${port}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = (signal) => {
  console.log(`[server] ${signal} received — saving universe state…`);
  saveUniverse();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
