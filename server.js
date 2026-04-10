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

const port = 3000;
const wsPort = 3001;

const CERTS_ROOT = './certs';
const GLYPH_ROOT = './node_modules/bootstrap-icons/icons';

const STARS_DIR = path.resolve(__dirname, './resources/stars');
const PLANETS_DIR = path.resolve(__dirname, './resources/planets');
const MOONS_DIR = path.resolve(__dirname, './resources/moons');

const STATE_FILE = path.resolve(__dirname, './resources/universe.json');

const SCALE_UNITS_PER_AU = 1496;

// Simulation state
let simulationTime = Date.now();      // milliseconds since epoch
let simulationSpeed = 1.0;            // multiplier (1 = real time)
let lastUpdateMs = Date.now();
let bodiesAngles = {};                // key: body name → true anomaly (radians)
let universeStates = { stars: [] };

// Throttle persistence: save every 30 seconds (or on exit)
let savePending = false;
let saveTimer = null;

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

const stripBOM = (str) => (str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str);
const normalizeName = (filename) => {
  const nameWithoutExt = filename.replace(/\.json$/i, '');
  return nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1).toLowerCase();
};

function readJSON(filename) {
  const raw = fs.readFileSync(filename, 'utf8');
  return JSON.parse(stripBOM(raw));
}

function basenameFromPath(pathStr) {
  return pathStr.split('/').pop();
}

function readJsonFilesSync(dirPath) {
  const result = {};
  const entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    if (path.extname(entry).toLowerCase() !== '.json') continue;
    const fullPath = path.join(dirPath, entry);
    let stat;
    try { stat = fs.statSync(fullPath); if (!stat.isFile()) continue; } catch { continue; }
    try {
      let content = fs.readFileSync(fullPath, 'utf8');
      content = stripBOM(content);
      result[entry] = JSON.parse(content);
    } catch { }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Orbital angle helpers
// ──────────────────────────────────────────────────────────────────────────
function getPeriod(body) {
  return body.period || (body.name === 'Sun' ? 0 : 1);
}

function angularSpeedRadPerMs(periodDays) {
  if (periodDays <= 0) return 0;
  return (2 * Math.PI) / (periodDays * 86400000);
}

function updateBodyAngles(body, deltaMs) {
  const period = getPeriod(body);
  const speed = angularSpeedRadPerMs(period);
  const key = body.name;
  if (bodiesAngles[key] === undefined) bodiesAngles[key] = 0;
  bodiesAngles[key] = (bodiesAngles[key] + speed * deltaMs * simulationSpeed) % (2 * Math.PI);
  if (body.planets) body.planets.forEach(planet => updateBodyAngles(planet, deltaMs));
  if (body.moons) body.moons.forEach(moon => updateBodyAngles(moon, deltaMs));
}

function updateSimulation() {
  const now = Date.now();
  const delta = Math.min(100, now - lastUpdateMs);
  if (delta > 0 && simulationSpeed !== 0) {
    simulationTime += delta * simulationSpeed;
    if (universeStates.stars[0]) updateBodyAngles(universeStates.stars[0], delta);
    lastUpdateMs = now;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Persistence (throttled)
// ──────────────────────────────────────────────────────────────────────────
function saveUniverse() {
  const fullState = {
    simulationTime,
    angles: bodiesAngles,
    stars: universeStates.stars
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(fullState, null, 2));
    console.log('Universe state saved');
  } catch (err) {
    console.error('Failed to save universe:', err);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveUniverse();
    saveTimer = null;
  }, 30000); // save at most every 30 seconds
}

function loadUniverseStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = readJSON(STATE_FILE);
      simulationTime = data.simulationTime || Date.now();
      bodiesAngles = data.angles || {};
      universeStates = { stars: data.stars };
      console.log(`Loaded simulation time: ${new Date(simulationTime)}`);
      return true;
    }
  } catch (err) { console.warn(err); }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Initial angle from real date (mean anomaly approx)
// ──────────────────────────────────────────────────────────────────────────
function computeInitialAnglesFromDate(star, dateMs) {
  const date = new Date(dateMs);
  const J2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
  const daysSinceJ2000 = (date - J2000) / 86400000;
  const angles = {};

  function setAngle(body) {
    const period = getPeriod(body);
    if (period > 0) {
      const n = 2 * Math.PI / period;
      const M0 = (body.M0 !== undefined) ? body.M0 : 0;
      let M = M0 + n * daysSinceJ2000;
      let nu = M % (2 * Math.PI);
      angles[body.name] = nu;
    } else {
      angles[body.name] = 0;
    }
    if (body.planets) body.planets.forEach(p => setAngle(p));
    if (body.moons) body.moons.forEach(m => setAngle(m));
  }
  setAngle(star);
  return angles;
}

// ──────────────────────────────────────────────────────────────────────────
// Universe hierarchy builder
// ──────────────────────────────────────────────────────────────────────────
function textureExists(texturePath) {
  if (!texturePath || typeof texturePath !== 'string' || texturePath.trim() === '') return false;
  const relativePath = texturePath.replace(/^\/images\//, '');
  const fullPath = path.join(__dirname, 'resources', 'images', relativePath);
  return fs.existsSync(fullPath);
}

function resourceExists(resourcePath) {
  if (!resourcePath || typeof resourcePath !== 'string') return false;
  const relativePath = resourcePath.replace(/^\//, '');
  const fullPath = path.join(__dirname, 'resources', relativePath);
  return fs.existsSync(fullPath);
}

function buildPlanetOrbitsConfig(moons) {
  const REFERENCE_PERIOD = 27.3;
  const speeds = {};
  for (const moon of moons) {
    const period = moon.period;
    const speed = REFERENCE_PERIOD / period;
    speeds[moon.name] = speed;
  }
  return { updateIntervalMs: 80, baseSpeed: 0.00667, speeds };
}

function buildUniverseHierarchy(starMap, planetMap, moonMap) {
  const starsArray = [];

  for (const [starFile, starData] of Object.entries(starMap)) {
    const starCopy = JSON.parse(JSON.stringify(starData));
    starCopy.resource = `/stars/${starFile}`;
    if (!resourceExists(starCopy.resource)) console.warn(`Missing star resource: ${starCopy.resource}`);

    const textureFields = ['map', 'bumpMap', 'specMap', 'cloudMap', 'alphaMap'];
    for (const field of textureFields) {
      if (starCopy[field] && !textureExists(starCopy[field])) starCopy[field] = "";
    }

    if (Array.isArray(starCopy.planets)) {
      starCopy.planets = starCopy.planets
        .map(planetPath => {
          const planetKey = basenameFromPath(planetPath);
          const planetData = planetMap[planetKey];
          if (!planetData) return null;
          const planetCopy = JSON.parse(JSON.stringify(planetData));
          planetCopy.resource = `/planets/${planetKey}`;
          for (const field of textureFields) {
            if (planetCopy[field] && !textureExists(planetCopy[field])) planetCopy[field] = "";
          }
          if (Array.isArray(planetCopy.moons)) {
            planetCopy.moons = planetCopy.moons
              .map(moonPath => {
                const moonKey = basenameFromPath(moonPath);
                const moonData = moonMap[moonKey];
                if (!moonData) return null;
                const moonCopy = JSON.parse(JSON.stringify(moonData));
                moonCopy.resource = `/moons/${moonKey}`;
                for (const field of textureFields) {
                  if (moonCopy[field] && !textureExists(moonCopy[field])) moonCopy[field] = "";
                }
                return moonCopy;
              })
              .filter(m => m !== null);
          } else {
            planetCopy.moons = [];
          }
          if (planetCopy.moons.length > 0) {
            planetCopy.orbits = buildPlanetOrbitsConfig(planetCopy.moons);
          } else {
            planetCopy.orbits = null;
          }
          return planetCopy;
        })
        .filter(p => p !== null);
    } else {
      starCopy.planets = [];
    }
    starsArray.push(starCopy);
  }

  return { stars: starsArray };
}

function loadUniverse() {
  const universeExists = loadUniverseStates();
  if (!universeExists) {
    console.log('Initializing universe state from default JSON files...');
    try {
      const starMap = readJsonFilesSync(STARS_DIR);
      const planetMap = readJsonFilesSync(PLANETS_DIR);
      const moonMap = readJsonFilesSync(MOONS_DIR);
      universeStates = buildUniverseHierarchy(starMap, planetMap, moonMap);
      if (universeStates.stars[0]) {
        bodiesAngles = computeInitialAnglesFromDate(universeStates.stars[0], Date.now());
        simulationTime = Date.now();
      }
      saveUniverse(); // initial save
    } catch (err) {
      console.warn('Error building universe:', err.message);
    }
  }
}
loadUniverse();

// ──────────────────────────────────────────────────────────────────────────
// Express & SSE
// ──────────────────────────────────────────────────────────────────────────
app.use(cors());
app.use((req, res, next) => {
  if (req.url === '/event') {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    return next();
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

app.get('/event', (req, res) => {
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`event: init\ndata: ${JSON.stringify({
    simulationTime,
    angles: bodiesAngles,
    columns: 128,
    rows: 64,
    size: 16
  })}\n\n`);

  try {
    const fullUniverse = JSON.parse(JSON.stringify(universeStates));
    res.write(`event: planets\ndata: ${JSON.stringify({ planets: fullUniverse.stars[0].planets.concat([fullUniverse.stars[0]]) })}\n\n`);
  } catch (err) { console.error('Failed to send universe:', err); }

  const interval = setInterval(() => {
    try {
      const glyphIcons = fs.readdirSync(GLYPH_ROOT);
      const x = Math.floor(Math.random() * 128);
      const y = Math.floor(Math.random() * 64);
      const glyph = glyphIcons[Math.floor(Math.random() * glyphIcons.length)] || 'circle.svg';
      const glyphData = fs.readFileSync(path.resolve(GLYPH_ROOT, glyph), 'utf8');
      res.write(`event: update\ndata: ${JSON.stringify({ id: `${x},${y}`, glyph: glyphData })}\n\n`);
    } catch (e) { }
  }, 200);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => { clearInterval(interval); clearInterval(keepAlive); res.end(); });
});

// ──────────────────────────────────────────────────────────────────────────
// WebSocket server
// ──────────────────────────────────────────────────────────────────────────
const wsServer = https.createServer(httpsOptions);
const wss = new WebSocketServer({ server: wsServer });

function getStar(name) {
  const filePath = path.resolve(STARS_DIR, `${name}.json`);
  let raw = fs.readFileSync(filePath, 'utf8');
  raw = stripBOM(raw);
  return JSON.parse(raw);
}

function broadcastOrbitUpdate() {
  const update = {
    type: 'orbitUpdate',
    simulationTime,
    angles: bodiesAngles
  };
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(update));
  });
}

// Update simulation every 80ms, broadcast, but do NOT save on every tick
setInterval(() => {
  updateSimulation();
  broadcastOrbitUpdate();
  scheduleSave(); // throttled save (max once per 30 sec)
}, 80);

wss.on('connection', (ws) => {
  console.log('Client connected to WSS');
  ws.send(JSON.stringify({
    type: 'orbitSync',
    simulationTime,
    angles: bodiesAngles
  }));

  ws.on('message', async (data) => {
    try {
      const input = data.toString();
      const absolutePath = path.resolve(__dirname, input);
      const content = await import(`file://${absolutePath}`, { with: { type: 'json' } });
      ws.send(JSON.stringify({ file: input, content: content.default }));
    } catch (e) {
      ws.send(JSON.stringify({ error: e.message }));
    }
  });
});

wsServer.listen(wsPort);

process.on('SIGINT', () => { saveUniverse(); process.exit(0); });
process.on('SIGTERM', () => { saveUniverse(); process.exit(0); });

app.get(/^((?!\.).)*$/, (req, res) => {
  const distIndex = path.resolve(__dirname, 'dist/planets/browser/index.html');
  const viewIndex = path.resolve(__dirname, 'view/index.html');
  res.sendFile(fs.existsSync(distIndex) ? distIndex : viewIndex);
});

https.createServer(httpsOptions, app).listen(port, () => {
  console.log(`HTTPS/SSE: https://localhost:${port}`);
  console.log(`WSS:       wss://localhost:${wsPort}`);
});
