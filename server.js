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

const EPOCH_DATE = new Date("2025-01-01T00:00:00Z").getTime();

let simulationTime = Date.now();
let simulationSpeed = 1.0;
let lastUpdateMs = Date.now();
let bodiesTrueAnomaly = {};
let universeStates = { stars: [] };

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

const stripBOM = (str) => str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;

function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 8; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2)
  );
}

function computeInitialTrueAnomalies(star, startMs) {
  const days = (startMs - EPOCH_DATE) / 86400000;
  const angles = {};
  const compute = (body) => {
    if (body.period > 0) {
      const M = (body.M0 ?? 0) + 2 * Math.PI * days / body.period;
      angles[body.name] = solveKepler(M % (2 * Math.PI), body.eccentricity ?? 0);
    } else angles[body.name] = 0;
    if (body.planets) body.planets.forEach(compute);
    if (body.moons) body.moons.forEach(compute);
  };
  compute(star);
  return angles;
}

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
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      let content = fs.readFileSync(fullPath, 'utf8');
      content = stripBOM(content);
      result[entry] = JSON.parse(content);
    } catch { }
  }
  return result;
}

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
          } else planetCopy.moons = [];
          if (planetCopy.moons.length > 0) {
            planetCopy.orbits = buildPlanetOrbitsConfig(planetCopy.moons);
          } else planetCopy.orbits = null;
          return planetCopy;
        })
        .filter(p => p !== null);
    } else starCopy.planets = [];
    starsArray.push(starCopy);
  }
  return { stars: starsArray };
}

function loadUniverse() {
  if (fs.existsSync(STATE_FILE)) {
    const data = JSON.parse(stripBOM(fs.readFileSync(STATE_FILE, 'utf8')));
    simulationTime = data.simulationTime ?? Date.now();
    bodiesTrueAnomaly = data.trueAnomalies ?? {};
    universeStates = { stars: data.stars ?? [] };
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
  }
}

function saveUniverse() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly,
    stars: universeStates.stars
  }, null, 2));
}

loadUniverse();

setInterval(() => {
  const now = Date.now();
  const delta = Math.min(100, now - lastUpdateMs);
  if (delta > 0) simulationTime += delta * simulationSpeed;
  lastUpdateMs = now;

  const update = (body) => {
    if (body.period > 0) {
      const days = (simulationTime - EPOCH_DATE) / 86400000;
      const M = (body.M0 ?? 0) + 2 * Math.PI * days / body.period;
      bodiesTrueAnomaly[body.name] = solveKepler(M % (2 * Math.PI), body.eccentricity ?? 0);
    }
    if (body.planets) body.planets.forEach(update);
    if (body.moons) body.moons.forEach(update);
  };
  if (universeStates.stars[0]) update(universeStates.stars[0]);

  broadcastOrbitUpdate();
}, 80);

function broadcastOrbitUpdate() {
  const msg = JSON.stringify({ type: 'orbitUpdate', simulationTime, trueAnomalies: bodiesTrueAnomaly });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

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
  const fullUniverse = JSON.parse(JSON.stringify(universeStates));
  res.write(`event: planets\ndata: ${JSON.stringify({
    planets: fullUniverse.stars[0].planets.concat([fullUniverse.stars[0]]),
    simulationTime
  })}\n\n`);
  // keep the rest of your glyph interval and keep-alive unchanged
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

const wsServer = https.createServer(httpsOptions);
const wss = new WebSocketServer({ server: wsServer });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'orbitSync', simulationTime, trueAnomalies: bodiesTrueAnomaly }));
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
