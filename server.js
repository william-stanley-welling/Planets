/**
 * @fileoverview HTTPS/SSE + WSS server for the heliocentric simulation.
 *
 * Responsibilities:
 *  - Serves the Angular dist bundle and static resources over HTTPS (port 3000).
 *  - Broadcasts orbital true-anomaly state + meteor positions to all WebSocket clients every 80 ms.
 *  - Accepts `setSpeed`, `triggerFlare`, `resetSimulation`, `meteorImpact` messages from clients.
 *  - Streams the initial solar-system hierarchy (including persisted meteors & density map) to SSE.
 *  - Persists full simulation state (orbits, meteors, density map, ring particle counts) to universe.json.
 *
 * Solar Flare Physics (server-authoritative):
 *  - A flare deducts particles from the asteroid belt ring and spawns Meteor objects with world positions
 *    and velocities derived from outer-belt Keplerian orbits plus a radial/tangential kick.
 *  - Each tick the server integrates meteor positions under solar gravity (simple Euler + drag).
 *  - When a meteor's distance falls inside the star radius it is treated as an impact:
 *      · A density blob (lat/lon/density) is appended to star.densityMap.
 *      · A `meteorImpact` broadcast is sent to all clients for visual surface effects.
 *      · If the 30-second rolling density sum exceeds FLARE_DENSITY_THRESHOLD an auto-flare fires.
 *  - Meteors that drift beyond MAX_METEOR_DIST are quietly removed.
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

// ---------------------------------------------------------------------------
// Physics constants
// ---------------------------------------------------------------------------
/** Maximum distance (scene units) before a meteor is culled. */
const MAX_METEOR_DIST = 80_000;
/** Solar gravitational parameter (scene units³/s²) — tuned for dramatic arcs. */
const SOLAR_GM = 6e6;
/** Drag coefficient applied every tick to slow escape-velocity meteors. */
const METEOR_DRAG = 0.9985;
/** Accumulated 30-s impact density that triggers an automatic solar flare. */
const FLARE_DENSITY_THRESHOLD = 4.0;
/** Minimum milliseconds between auto-flares triggered by impact density. */
const AUTO_FLARE_COOLDOWN_MS = 12_000;
/** Maximum impacts retained in the densityMap (ring-buffer). */
const MAX_DENSITY_ENTRIES = 300;

const EPOCH_DATE = new Date('2000-01-01T12:00:00Z').getTime();
const MS_PER_DAY = 86_400_000;
const BASE_RATE = MS_PER_DAY;

let simulationTime = Date.now();
let simulationSpeed = 1.0;
let lastUpdateMs = Date.now();
let lastAutoFlareTime = 0;

/** Map of body name → current true anomaly (radians). */
let bodiesTrueAnomaly = {};

/** In-memory universe hierarchy (stars → planets → moons → meteors). */
let universeStates = { stars: [] };

// ---------------------------------------------------------------------------
// Moon semi-major axes (unchanged)
// ---------------------------------------------------------------------------
const MOON_SEMIMAJOR_X = {
  /* Earth */
  Moon: 3.844,
  /* Mars */
  Phobos: 0.094, Deimos: 0.234,
  /* Jupiter */
  Io: 4.218, Europa: 6.711, Ganymede: 10.704, Callisto: 18.827,
  /* Saturn */
  Titan: 12.219, Rhea: 5.271, Dione: 3.774, Tethys: 2.946, Enceladus: 2.379, Iapetus: 35.608,
  /* Uranus */
  Titania: 4.359, Oberon: 5.835, Umbriel: 2.663, Ariel: 1.910, Miranda: 1.294, Cordelia: 0.497, Ophelia: 0.537, Bianca: 0.591, Cressida: 0.617, Desdemona: 0.626, Juliet: 0.643, Portia: 0.661, Rosalind: 0.699, Cupid: 0.743, Belinda: 0.752, Perdita: 0.764, Puck: 0.860, Mab: 0.977, Miranda: 1.294, Ariel: 1.910, Umbriel: 2.663, Titania: 4.359, Oberon: 5.835, Francisco: 42.75, Caliban: 72.31, Stephano: 79.51, Trinculo: 85.04, Sycorax: 121.79, Margaret: 143.45, Prospero: 162.56, Setebos: 174.18, Ferdinand: 209.01, S2023U1: 79.76,
  /* Neptune */
  Triton: 3.548
};

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function logAdded(type, name, meta) {
  const pad = (s, n = 7) => (s + ' '.repeat(Math.max(0, n - s.length)));
  console.info(`[universe][ADD] ${pad(type)} • ${name}${meta ? ` (${meta})` : ''}`);
}

const stripBOM = (str) => str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;

function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 10; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

function computeInitialTrueAnomalies(star, startMs) {
  const days = (startMs - EPOCH_DATE) / 86_400_000;
  const angles = {};
  const compute = (body) => {
    // Standard orbital calculation
    if (body.period > 0) {
      const M = ((body.M0 ?? 0) + 2 * Math.PI * days / body.period) % (2 * Math.PI);
      angles[body.name] = solveKepler(M < 0 ? M + 2 * Math.PI : M, body.eccentricity ?? 0);
    } else {
      angles[body.name] = 0;
    }

    // --- NEW: Initialize Ring/Belt Rotation ---
    if (Array.isArray(body.rings)) {
      body.rings.forEach(ring => {
        if (ring.name && (ring.period > 0 || ring.keplerianRotation)) {
          const rPeriod = ring.period || 1680; // Default ~4.6 years for a main-belt asteroid
          angles[ring.name] = (2 * Math.PI * days / rPeriod) % (2 * Math.PI);
        }
      });
    }

    if (body.planets) body.planets.forEach(compute);
    if (body.moons) body.moons.forEach(compute);
  };
  compute(star);
  return angles;
}

function readJSON(filename) {
  return JSON.parse(stripBOM(fs.readFileSync(filename, 'utf8')));
}

function basenameFromPath(pathStr) {
  return pathStr.split('/').pop();
}

function readJsonFilesSync(dirPath) {
  const result = {};
  for (const entry of fs.readdirSync(dirPath)) {
    if (path.extname(entry).toLowerCase() !== '.json') continue;
    const fullPath = path.join(dirPath, entry);
    try {
      if (!fs.statSync(fullPath).isFile()) continue;
      result[entry] = readJSON(fullPath);
    } catch { /* skip malformed files */ }
  }
  return result;
}

function textureExists(texturePath) {
  if (!texturePath || typeof texturePath !== 'string' || !texturePath.trim()) return false;
  const rel = texturePath.replace(/^\/images\//, '');
  return fs.existsSync(path.join(__dirname, 'resources', 'images', rel));
}

function resourceExists(resourcePath) {
  if (!resourcePath || typeof resourcePath !== 'string') return false;
  return fs.existsSync(path.join(__dirname, 'resources', resourcePath.replace(/^\//, '')));
}

function buildPlanetOrbitsConfig(moons) {
  const REFERENCE_PERIOD = 27.3;
  const speeds = {};
  for (const moon of moons) speeds[moon.name] = REFERENCE_PERIOD / moon.period;
  return { updateIntervalMs: 80, baseSpeed: 0.00667, speeds };
}

// ---------------------------------------------------------------------------
// Universe hierarchy builder
// ---------------------------------------------------------------------------
function buildUniverseHierarchy(starMap, planetMap, moonMap, existingState = null) {
  const TEXTURE_FIELDS = ['map', 'bumpMap', 'specMap', 'cloudMap', 'alphaMap'];
  const starsArray = [];

  for (const [starFile, starData] of Object.entries(starMap)) {
    const starCopy = JSON.parse(JSON.stringify(starData));
    starCopy.resource = `/stars/${starFile}`;
    if (!resourceExists(starCopy.resource)) console.warn(`[universe] Missing star resource: ${starCopy.resource}`);

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


          p.moons = (() => {
            let moonEntries = [];

            // 1. Convert CSV string to an array of objects if necessary
            if (typeof p.moons === 'string' && p.moons.includes(';')) {
              moonEntries = p.moons.split(';').map(row => {
                const col = row.split(',');
                return {
                  name: col[0],
                  map: col[1],
                  diameter: parseFloat(col[2]),
                  atmosphere: parseFloat(col[3]),
                  widthSegments: parseInt(col[4]),
                  heightSegments: parseInt(col[5]),
                  mass: parseFloat(col[6]),
                  pow: parseInt(col[7]),
                  color: col[8],
                  period: parseFloat(col[9]),
                  tilt: parseFloat(col[10]),
                  spin: parseFloat(col[11]),
                  eccentricity: parseFloat(col[12]),
                  inclination: parseFloat(col[13]),
                  semiMajorAxis: parseFloat(col[14])
                };
              });
            } else if (Array.isArray(p.moons)) {
              moonEntries = p.moons;
            } else {
              return [];
            }

            // 2. Process the entries
            return moonEntries.map(moonEntry => {
              let m;

              if (typeof moonEntry === 'string') {
                const mKey = basenameFromPath(moonEntry);
                const mData = moonMap[mKey];
                if (!mData) { console.warn(`[universe] Missing moon: ${mKey}`); return null; }
                m = JSON.parse(JSON.stringify(mData));
                m.resource = `/moons/${mKey}`;
              } else if (moonEntry && typeof moonEntry === 'object') {
                m = JSON.parse(JSON.stringify(moonEntry));
                const mKey = basenameFromPath(m.resource || m.name || m.map || '');
                if (mKey) m.resource = m.resource || `/moons/${mKey}`;
              } else {
                console.warn(`[universe] Invalid moon entry for planet "${p.name}"`);
                return null;
              }

              // Apply texture safety checks
              for (const field of TEXTURE_FIELDS) {
                if (m[field] && !textureExists(m[field])) m[field] = '';
              }

              // Handle Semi-Major Axis Assignment
              if (m.semiMajorAxis != null) {
                m.x = m.semiMajorAxis;
                console.info(`[universe] Using moon-provided semi-major axis for "${m.name}": ${m.x}`);

                if (MOON_SEMIMAJOR_X[m.name] != null && m.semiMajorAxis != MOON_SEMIMAJOR_X[m.name]) {
                  console.warn(`[universe] Mismatch constant with moon-provided semi-major axis for "${m.name}": ${m.x}`);
                }
              } else if (MOON_SEMIMAJOR_X[m.name] != null) {
                m.x = MOON_SEMIMAJOR_X[m.name];
                console.info(`[universe] Using constant semi-major axis for moon "${m.name}": ${m.x}`);
              } else {
                m.x = 2.0;
                console.warn(`[universe] No semi-major axis for moon "${m.name}" — using default: ${m.x}`);
              }

              logAdded('Moon', m.name, `planet=${p.name}`);
              return m;
            }).filter(Boolean);
          })();



          p.orbits = p.moons.length > 0 ? buildPlanetOrbitsConfig(p.moons) : null;
          p.rings = Array.isArray(p.rings)
            ? p.rings.map(r => {
              const rCopy = JSON.parse(JSON.stringify(r));
              if (rCopy.texture && !textureExists(rCopy.texture)) { rCopy.texture = ''; }
              rCopy.inner = Number(rCopy.inner ?? 0);
              rCopy.outer = Number(rCopy.outer ?? 0);
              rCopy.thickness = Number(rCopy.thickness ?? 0.01);
              logAdded('Ring', rCopy.name ?? '(unnamed)', `owner=${p.name}`);
              return rCopy;
            }).filter(Boolean)
            : [];
          logAdded('Planet', p.name, `star=${starCopy.name}`);
          return p;
        })
        .filter(Boolean);
    } else {
      starCopy.planets = [];
    }

    starCopy.rings = Array.isArray(starCopy.rings)
      ? starCopy.rings.map(r => {
        const rCopy = JSON.parse(JSON.stringify(r));
        if (rCopy.texture && !textureExists(rCopy.texture)) rCopy.texture = '';
        rCopy.inner = Number(rCopy.inner ?? 0);
        rCopy.outer = Number(rCopy.outer ?? 0);
        rCopy.thickness = Number(rCopy.thickness ?? 0.01);
        logAdded('Ring', rCopy.name ?? '(unnamed)', `owner=${starCopy.name}`);
        return rCopy;
      }).filter(Boolean)
      : [];

    // ── Restore persisted dynamic state (meteors, densityMap) ─────────────────
    const prevStar = existingState?.stars?.find(s => s.name === starCopy.name);
    starCopy.meteors = Array.isArray(prevStar?.meteors) ? prevStar.meteors : [];
    starCopy.densityMap = Array.isArray(prevStar?.densityMap) ? prevStar.densityMap : [];

    starsArray.push(starCopy);
    logAdded('Star', starCopy.name);
  }

  return { stars: starsArray };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadUniverse() {
  if (fs.existsSync(STATE_FILE)) {
    const data = JSON.parse(stripBOM(fs.readFileSync(STATE_FILE, 'utf8')));
    simulationTime = data.simulationTime ?? Date.now();
    bodiesTrueAnomaly = data.trueAnomalies ?? {};

    // Load stars preserving meteors + densityMap
    const starMap = readJsonFilesSync(STARS_DIR);
    const planetMap = readJsonFilesSync(PLANETS_DIR);
    const moonMap = readJsonFilesSync(MOONS_DIR);
    universeStates = buildUniverseHierarchy(starMap, planetMap, moonMap, { stars: data.stars ?? [] });

    // Re-hydrate ring particleCounts from saved universe
    if (data.stars && data.stars[0] && universeStates.stars[0]) {
      const savedStar = data.stars[0];
      const liveStar = universeStates.stars[0];
      if (Array.isArray(savedStar.rings)) {
        for (const savedRing of savedStar.rings) {
          const liveRing = liveStar.rings?.find(r => r.name === savedRing.name);
          if (liveRing && typeof savedRing.particleCount === 'number') {
            liveRing.particleCount = savedRing.particleCount;
          }
        }
      }
    }

    console.log(`[universe] Loaded from state file — ${universeStates.stars[0]?.meteors?.length ?? 0} active meteors.`);
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

// ---------------------------------------------------------------------------
// Meteor physics (server-authoritative)
// ---------------------------------------------------------------------------

/**
 * Returns a serialisable snapshot of all active meteors for WS broadcast.
 */
function getMeteorSnapshots() {
  const star = universeStates.stars[0];
  if (!Array.isArray(star?.meteors)) return [];
  return star.meteors.map(m => ({
    name: m.name,
    x: m.x, y: m.y, z: m.z,
    vx: m.vx, vy: m.vy, vz: m.vz,
  }));
}

/**
 * Integrate meteor positions under solar gravity for one server tick.
 * Detects sun-surface collisions and triggers density accumulation.
 *
 * @param {number} deltaSec - Elapsed seconds since last tick.
 */
function updateMeteors(deltaSec) {
  const star = universeStates.stars[0];
  if (!star || !Array.isArray(star.meteors) || star.meteors.length === 0) return;

  // Star radius in scene units (diameter is stored in star.diameter, no VISUAL_SCALE here — server uses raw AU-scaled units)
  const starRadius = (star.diameter ?? 139.2) * 0.5;
  const impacted = [];
  const tooFar = [];

  for (const m of star.meteors) {
    const r = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z);

    if (r < 0.001) { impacted.push(m); continue; }

    // Solar gravity acceleration
    const grav = SOLAR_GM / (r * r);
    const nx = m.x / r;
    const ny = m.y / r;
    const nz = m.z / r;

    // Euler integration (60 sub-steps per server tick for stability)
    const subSteps = 4;
    const subDt = deltaSec / subSteps;
    for (let s = 0; s < subSteps; s++) {
      m.vx += (-nx * grav) * subDt;
      m.vy += (-ny * grav) * subDt;
      m.vz += (-nz * grav) * subDt;
      m.vx *= METEOR_DRAG;
      m.vy *= METEOR_DRAG;
      m.vz *= METEOR_DRAG;
      m.x += m.vx * subDt * 60;
      m.y += m.vy * subDt * 60;
      m.z += m.vz * subDt * 60;
    }

    const rNew = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z);

    if (rNew <= starRadius * 1.05) {
      impacted.push(m);
    } else if (rNew > MAX_METEOR_DIST) {
      tooFar.push(m);
    }
  }

  // Process impacts
  for (const m of impacted) {
    const r = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z) || 1;
    const lat = Math.asin(Math.max(-1, Math.min(1, m.y / r)));
    const lon = Math.atan2(m.z, m.x);
    const density = Math.min(1.0, 0.08 + Math.random() * 0.35);

    if (!Array.isArray(star.densityMap)) star.densityMap = [];
    star.densityMap.push({ lat, lon, density, t: Date.now() });
    if (star.densityMap.length > MAX_DENSITY_ENTRIES) star.densityMap.shift();

    broadcastMeteorImpact(m.name, lat, lon, density, star.densityMap);

    // Check rolling 30-second density for auto-flare
    const now = Date.now();
    const rollingDensity = star.densityMap
      .filter(d => now - d.t < 30_000)
      .reduce((acc, d) => acc + d.density, 0);

    if (rollingDensity >= FLARE_DENSITY_THRESHOLD && now - lastAutoFlareTime > AUTO_FLARE_COOLDOWN_MS) {
      lastAutoFlareTime = now;
      const autoVolatility = Math.min(1.0, 0.5 + rollingDensity * 0.08);
      console.log(`[flare] 🌞 Auto-flare from density accumulation — volatility ${autoVolatility.toFixed(2)}`);
      triggerFlareInternal(autoVolatility);
    }
  }

  // Remove impacted + escaped meteors
  const removeNames = new Set([...impacted.map(m => m.name), ...tooFar.map(m => m.name)]);
  if (removeNames.size > 0) {
    star.meteors = star.meteors.filter(m => !removeNames.has(m.name));
    for (const name of removeNames) delete bodiesTrueAnomaly[name];
    if (tooFar.length > 0) console.log(`[meteor] ${tooFar.length} meteor(s) escaped solar system.`);
  }
}

// ---------------------------------------------------------------------------
// Solar Flare — internal trigger
// ---------------------------------------------------------------------------

/**
 * Ejects particles from the asteroid belt and spawns server-side meteors.
 * Broadcasts `flareEvent` to all connected clients and saves state.
 *
 * @param {number} volatility - 0.0–1.0 intensity multiplier.
 */
function triggerFlareInternal(volatility = 0.7) {
  const star = universeStates.stars[0];
  if (!star) return;

  // Find the primary asteroid belt ring (keplerianRotation === true)
  const beltRing = Array.isArray(star.rings)
    ? star.rings.find(r => r.keplerianRotation === true)
    : null;

  const inner = beltRing ? Number(beltRing.inner) : 2992;
  const outer = beltRing ? Number(beltRing.outer) : 4787;
  const numToEject = Math.max(4, Math.floor(8 + 16 * volatility));

  // Reduce belt particle count (minimum 200)
  if (beltRing) {
    beltRing.particleCount = Math.max(200, (beltRing.particleCount ?? 15000) - numToEject);
  }

  if (!Array.isArray(star.meteors)) star.meteors = [];

  const spawnedMeteors = [];

  for (let i = 0; i < numToEject; i++) {
    // Random position in the outer 40% of the belt
    const angle = Math.random() * 2 * Math.PI;
    const minR = inner + 0.6 * (outer - inner);
    const r = minR + Math.random() * (outer - minR);
    const tiltFrac = (Math.random() - 0.5) * 0.15; // slight vertical scatter

    const x = r * Math.cos(angle);
    const z = r * Math.sin(angle);
    const y = r * tiltFrac;

    // Keplerian orbital speed at radius r (approximate: v ∝ 1/√r)
    // Use a simplified speed proportional to inverse-sqrt of radius
    const orbitalSpeedBase = Math.sqrt(SOLAR_GM / r) * 0.35;
    const tangentX = -Math.sin(angle);
    const tangentZ = Math.cos(angle);

    // Radial outward kick + tangential orbital component + vertical jitter
    const radialKick = (12 + Math.random() * 20) * volatility;
    const tangentialBias = orbitalSpeedBase * (0.6 + Math.random() * 0.8);
    const verticalJitter = (Math.random() - 0.5) * 8;

    const vx = tangentX * tangentialBias + (x / r) * radialKick;
    const vy = verticalJitter;
    const vz = tangentZ * tangentialBias + (z / r) * radialKick;

    const name = `Meteor-${Date.now()}-${i}`;
    const meteor = { name, x, y, z, vx, vy, vz, mass: 1.0 + Math.random() * 2.0 };
    star.meteors.push(meteor);
    spawnedMeteors.push({ name, x, y, z, vx, vy, vz });
  }

  // Broadcast flare event with spawned meteor positions to all clients
  broadcastFlareEvent(volatility, spawnedMeteors, beltRing?.particleCount ?? 0);

  console.log(`[flare] 🔥 Flare — volatility=${volatility.toFixed(2)}, ejected=${numToEject}, belt remaining=${beltRing?.particleCount ?? '?'}`);
  saveUniverse();
}

// ---------------------------------------------------------------------------
// WebSocket broadcast helpers
// ---------------------------------------------------------------------------

function broadcastOrbitUpdate() {
  const msg = JSON.stringify({
    type: 'orbitUpdate',
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly,
    meteors: getMeteorSnapshots(),
    beltParticleCount: universeStates.stars[0]?.rings?.find(r => r.keplerianRotation)?.particleCount ?? null,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastRingUpdate() {
  const msg = JSON.stringify({ type: 'ringUpdate', simulationTime });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastFlareEvent(volatility, meteors, beltParticleCount) {
  const msg = JSON.stringify({
    type: 'flareEvent',
    volatility,
    meteors,
    beltParticleCount,
    simulationTime,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastMeteorImpact(meteorName, lat, lon, density, densityMap) {
  const msg = JSON.stringify({
    type: 'meteorImpact',
    meteorName,
    lat,
    lon,
    density,
    densityMap: densityMap?.slice(-50) ?? [], // only send recent 50 for bandwidth
    simulationTime,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  console.log(`[impact] ☄️  Meteor "${meteorName}" hit sun at (lat=${(lat * 180 / Math.PI).toFixed(1)}°, lon=${(lon * 180 / Math.PI).toFixed(1)}°)`);
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wsServer = https.createServer(httpsOptions);
const wss = new WebSocketServer({ server: wsServer });

wss.on('connection', (ws) => {
  const star = universeStates.stars[0];

  // Full state sync on connect — includes active meteors and density map
  ws.send(JSON.stringify({
    type: 'orbitSync',
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly,
    meteors: getMeteorSnapshots(),
    densityMap: star?.densityMap ?? [],
    beltParticleCount: star?.rings?.find(r => r.keplerianRotation)?.particleCount ?? null,
  }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // ── Set simulation speed ──────────────────────────────────────────────
      if (data.type === 'setSpeed') {
        const speed = parseFloat(data.speed);
        if (!isNaN(speed)) {
          simulationSpeed = Math.max(0, speed);
          console.log(`[ws] Simulation speed → ${simulationSpeed}×`);
        }
      }

      // ── Reset simulation ──────────────────────────────────────────────────
      else if (data.type === 'resetSimulation') {
        simulationTime = Date.now();
        simulationSpeed = 1.0;
        lastUpdateMs = Date.now();
        bodiesTrueAnomaly = {};
        universeStates = { stars: [] };

        const starMap = readJsonFilesSync(STARS_DIR);
        const planetMap = readJsonFilesSync(PLANETS_DIR);
        const moonMap = readJsonFilesSync(MOONS_DIR);
        universeStates = buildUniverseHierarchy(starMap, planetMap, moonMap);

        if (universeStates.stars[0]) {
          bodiesTrueAnomaly = computeInitialTrueAnomalies(universeStates.stars[0], Date.now());
          simulationTime = Date.now();
          universeStates.stars[0].meteors = [];
          universeStates.stars[0].densityMap = [];
        }

        saveUniverse();
        startMainLoop();

        // Notify all clients of the reset
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'orbitSync',
              simulationTime,
              trueAnomalies: bodiesTrueAnomaly,
              meteors: [],
              densityMap: [],
              beltParticleCount: universeStates.stars[0]?.rings?.find(r => r.keplerianRotation)?.particleCount ?? null,
            }));
          }
        }
        console.log('[ws] Simulation reset complete.');
      }

      // ── Trigger solar flare ───────────────────────────────────────────────
      else if (data.type === 'triggerFlare') {
        const volatility = Math.max(0.1, Math.min(1.0, parseFloat(data.volatility ?? data.change?.volatility ?? 0.7)));
        triggerFlareInternal(volatility);
      }

      // ── Client-side meteor impact confirmation (client detected collision) ─
      // Note: server also detects independently — this is for clients that want
      // to report visual confirmation before server tick confirms it.
      else if (data.type === 'clientMeteorImpact') {
        console.log(`[ws] Client confirmed impact: ${data.meteorName}`);
        // No action needed — server physics is authoritative.
      }

    } catch (err) {
      console.warn(`[ws] Error handling message:`, err.message);
    }
  });

  ws.on('error', (err) => console.error('[ws] Client error:', err.message));
});

wsServer.listen(wsPort, () => console.log(`WSS: wss://localhost:${wsPort}`));

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let mainLoop;

function startMainLoop() {
  if (mainLoop) clearInterval(mainLoop);
  mainLoop = setInterval(() => {
    const now = Date.now();
    const deltaSec = (now - lastUpdateMs) / 1000;
    lastUpdateMs = now;

    simulationTime += deltaSec * BASE_RATE * simulationSpeed;

    const update = (body) => {
      if (body.period !== 0) {  // handle both directions
        const days = (simulationTime - EPOCH_DATE) / MS_PER_DAY;
        const M = ((body.M0 ?? 0) + 2 * Math.PI * days / body.period) % (2 * Math.PI);
        const Mnorm = M < 0 ? M + 2 * Math.PI : M;
        bodiesTrueAnomaly[body.name] = solveKepler(Mnorm, body.eccentricity ?? 0);
      }

      if (Array.isArray(body.rings)) {
        body.rings.forEach(ring => {
          if (ring.name && (ring.period > 0 || ring.keplerianRotation)) {
            const days = (simulationTime - EPOCH_DATE) / MS_PER_DAY;
            const ringPeriod = ring.period || 1680;
            // Store rotation in the anomaly map so the client can bind to it
            bodiesTrueAnomaly[ring.name] = (2 * Math.PI * days / ringPeriod) % (2 * Math.PI);
          }
        });
      }

      if (body.planets) body.planets.forEach(update);
      if (body.moons) body.moons.forEach(update);
    };

    if (universeStates.stars[0]) update(universeStates.stars[0]);

    // Physics integration for server-authoritative meteors
    updateMeteors(deltaSec);

    broadcastOrbitUpdate();
    broadcastRingUpdate();
  }, 80);
}

startMainLoop();
setInterval(saveUniverse, 500);

// ---------------------------------------------------------------------------
// Express middleware + static serving
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

app.use(compression({ strategy: zlib.constants.Z_RLE, level: 9, filter: (req) => req.url !== '/event' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist/planets/browser')));
app.use('/resources', express.static(path.join(__dirname, 'resources')));
app.use('/stars', express.static(path.join(__dirname, 'resources/stars')));
app.use('/planets', express.static(path.join(__dirname, 'resources/planets')));
app.use('/moons', express.static(path.join(__dirname, 'resources/moons')));

// ---------------------------------------------------------------------------
// SSE endpoint — delivers full hierarchy + dynamic state on connect
// ---------------------------------------------------------------------------
app.get('/event', (req, res) => {
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const snapshot = JSON.parse(JSON.stringify(universeStates));
  const star = snapshot.stars[0];

  const allBodies = [
    ...(star?.planets ?? []),
    star,
  ].filter(Boolean);

  // Send initial state including meteors and density map
  res.write(`event: planets\ndata: ${JSON.stringify({
    planets: allBodies,
    simulationTime,
    simulationSpeed,
    meteors: star?.meteors ?? [],
    densityMap: star?.densityMap ?? [],
    beltParticleCount: star?.rings?.find(r => r.keplerianRotation)?.particleCount ?? null,
  })}\n\n`);

  const glyphInterval = setInterval(() => {
    try {
      const icons = fs.readdirSync(GLYPH_ROOT);
      const glyph = icons[Math.floor(Math.random() * icons.length)] || 'circle.svg';
      res.write(`event: update\ndata: ${JSON.stringify({
        id: `${Math.floor(Math.random() * 128)},${Math.floor(Math.random() * 64)}`,
        glyph: fs.readFileSync(path.resolve(GLYPH_ROOT, glyph), 'utf8'),
      })}\n\n`);
    } catch { /* icon dir missing */ }
  }, 200);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  req.on('close', () => { clearInterval(glyphInterval); clearInterval(keepAlive); res.end(); });
});

// SPA catch-all
app.get(/^((?!\.).)*$/, (req, res) => {
  const distIndex = path.resolve(__dirname, 'dist/planets/browser/index.html');
  const viewIndex = path.resolve(__dirname, 'view/index.html');
  res.sendFile(fs.existsSync(distIndex) ? distIndex : viewIndex);
});

// HTTPS server
https.createServer(httpsOptions, app).listen(port, () => {
  console.log(`HTTPS/SSE: https://localhost:${port}`);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`[server] ${signal} — saving universe state…`);
  saveUniverse();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loadUniverse();
