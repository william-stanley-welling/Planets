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

const EPOCH_DATE = new Date('2000-01-01T12:00:00Z').getTime();
const MS_PER_DAY = 86_400_000;
const BASE_RATE = MS_PER_DAY;

let simulationTime = Date.now();
let simulationSpeed = 1.0;
let lastUpdateMs = Date.now();

let bodiesTrueAnomaly = {};

let universeStates = { stars: [] };

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

function logAdded(type, name, meta) {
  const pad = (s, n = 7) => (s + ' '.repeat(Math.max(0, n - s.length)));
  console.info(`[universe][ADD] ${pad(type)} • ${name}${meta ? ` (${meta})` : ''}`);
}

const stripBOM = (str) => str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;

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

function buildUniverseHierarchy(starMap, planetMap, moonMap) {
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

    starCopy.comets = Array.isArray(starCopy.comets)
      ? starCopy.comets.map(c => {
        const cCopy = JSON.parse(JSON.stringify(c));

        logAdded('Comet', cCopy.name ?? '(unnamed)', `owner=${starCopy.name}`);
        return cCopy;
      }).filter(Boolean)
      : [];

    starsArray.push(starCopy);

    logAdded('Star', starCopy.name);
  }

  return { stars: starsArray };
}

function loadUniverse() {
  if (fs.existsSync(STATE_FILE)) {
    const states = JSON.parse(stripBOM(fs.readFileSync(STATE_FILE, 'utf8')));
    simulationTime = states.simulationTime ?? Date.now();
    bodiesTrueAnomaly = states.trueAnomalies ?? {};

    universeStates = {
      ...universeStates,
      ...states,
      simulationTime,
      trueAnomalies: bodiesTrueAnomaly,
    };

    console.log(`[universe] Loaded from state file.`);
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

function broadcastOrbitUpdate() {
  const msg = JSON.stringify({
    type: 'orbitUpdate',
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly
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

const wsServer = https.createServer(httpsOptions);
const wss = new WebSocketServer({ server: wsServer });

wss.on('connection', (ws) => {

  ws.send(JSON.stringify({
    type: 'orbitSync',
    simulationTime,
    trueAnomalies: bodiesTrueAnomaly
  }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'setSpeed') {
        const speed = parseFloat(data.speed);
        if (!isNaN(speed)) {
          simulationSpeed = Math.max(0, speed);
          console.log(`[ws] Simulation speed → ${simulationSpeed}×`);
        }
      }

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

        console.log(universeStates);

        if (universeStates.stars[0]) {
          bodiesTrueAnomaly = computeInitialTrueAnomalies(universeStates.stars[0], Date.now());
          simulationTime = Date.now();
        }

        console.log(bodiesTrueAnomaly);

        saveUniverse();
        startMainLoop();

        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'orbitSync',
              simulationTime,
              trueAnomalies: bodiesTrueAnomaly
            }));
          }
        }
        console.log('[ws] Simulation reset complete.');
      }

    } catch (err) {
      console.warn(`[ws] Error handling message:`, err.message);
    }
  });

  ws.on('error', (err) => console.error('[ws] Client error:', err.message));
});

wsServer.listen(wsPort, () => console.log(`WSS: wss://localhost:${wsPort}`));

function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 10; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }

  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

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
    if (body.comets) body.comets.forEach(compute);
  };
  compute(star);

  return angles;
}

let mainLoop;

function startMainLoop() {
  if (mainLoop) clearInterval(mainLoop);
  mainLoop = setInterval(() => {
    const now = Date.now();
    const deltaSec = (now - lastUpdateMs) / 1000;
    lastUpdateMs = now;

    simulationTime += deltaSec * BASE_RATE * simulationSpeed;

    const update = (body) => {
      if (body.period !== 0) {
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
            bodiesTrueAnomaly[ring.name] = (2 * Math.PI * days / ringPeriod) % (2 * Math.PI);
          }
        });
      }

      if (body.planets) body.planets.forEach(update);
      if (body.moons) body.moons.forEach(update);
      if (body.comets) body.comets.forEach(update);
    };

    if (universeStates.stars[0]) {
      update(universeStates.stars[0]);
    }

    broadcastOrbitUpdate();
    broadcastRingUpdate();
  }, 80);
}

startMainLoop();

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
    ...(star?.comets ?? []),
    ...(star?.planets ?? []),
    star,
  ].filter(Boolean);

  res.write(`event: planets\ndata: ${JSON.stringify({
    planets: allBodies,
    simulationTime,
    simulationSpeed,
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

  req.on('close', () => {
    clearInterval(glyphInterval);
    clearInterval(keepAlive);
    res.end();
  });
});

app.get(/^((?!\.).)*$/, (req, res) => {
  const distIndex = path.resolve(__dirname, 'dist/planets/browser/index.html');
  const viewIndex = path.resolve(__dirname, 'view/index.html');
  res.sendFile(fs.existsSync(distIndex) ? distIndex : viewIndex);
});

https.createServer(httpsOptions, app).listen(port, () => {
  console.log(`HTTPS/SSE: https://localhost:${port}`);
});

const shutdown = (signal) => {
  console.log(`[server] ${signal} — saving universe state…`);
  saveUniverse();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loadUniverse();

setInterval(saveUniverse, 15 * 1000);
