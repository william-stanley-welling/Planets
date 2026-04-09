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

// for sending cool encrypted messages over WebRTC
const CERTS_ROOT = './certs';
const GLYPH_ROOT = './node_modules/bootstrap-icons/icons';

// list of known stars and their corresponding JSON detailing all known properties
const STARS_DIR = path.resolve(__dirname, './resources/stars');
// list of known planets and their corresponding JSON detailing all known properties
const PLANETS_DIR = path.resolve(__dirname, './resources/planets');
// list of known moons and their corresponding JSON detailing all known properties
const MOONS_DIR = path.resolve(__dirname, './resources/moons');

const STATE_FILE = path.resolve(__dirname, './resources/universe.json');

const SCALE_UNITS_PER_AU = 1496;

let universeStates = {};

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

const stripBOM = (str) =>
  str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;

// const normalizeName = (name) =>
//   name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

const normalizeName = (filename) => {
  // Remove extension (e.g., .json)
  const nameWithoutExt = filename.replace(/\.json$/i, '');
  // Capitalize first letter, lower case the rest
  return nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1).toLowerCase();
};

// dont use without checking for file before calling
function readJSON(filename) {
  const raw = fs.readFileSync(filename, 'utf8');

  return JSON.parse(stripBOM(raw));
}

/**
 * Extracts the base filename from a path (e.g., '/planets/earth.json' → 'earth.json')
 */
function basenameFromPath(pathStr) {
  return pathStr.split('/').pop();
}

/**
 * Synchronously reads all .json files from a directory, strips BOM, and parses JSON.
 * @param {string} dirPath - Path to the directory.
 * @returns {Object} Map of filename → parsed JSON object.
 * @throws {Error} If directory cannot be read.
 */
function readJsonFilesSync(dirPath) {
  const result = {};
  const entries = fs.readdirSync(dirPath);

  for (const entry of entries) {
    if (path.extname(entry).toLowerCase() !== '.json') continue;

    const fullPath = path.join(dirPath, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
    } catch {
      continue; // skip entries that can't be stated
    }

    try {
      let content = fs.readFileSync(fullPath, 'utf8');
      content = stripBOM(content);
      result[entry] = JSON.parse(content);
    } catch (err) {
      // silently skip invalid JSON files; optionally log: console.warn(`Skipping ${entry}: ${err.message}`)
    }
  }

  return result;
}

function loadUniverseStates() {
  let results = false;

  console.log('Checking persisted universe state...');

  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.warn(`No state file`);
      return false;
    }

    console.log('Reading persisted universe state...');

    universeStates = readJSON(STATE_FILE);

    if (Object.keys(universeStates).length === 0) {
      console.warn(`Persisted state has no keys`);
      return false;
    }

    console.log(`Universe loaded from persisted state`);

    results = true;
  } catch (err) {
    console.warn('Error loading:', err.message);
  }

  return results;
}

function buildUniverseHierarchy(starMap, planetMap, moonMap) {
  const starsArray = [];

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

  for (const [starFile, starData] of Object.entries(starMap)) {
    const starCopy = JSON.parse(JSON.stringify(starData));

    starCopy.resource = `/stars/${starFile}`;

    if (!resourceExists(starCopy.resource)) {
      console.warn(`[Universe] Missing star resource: ${starCopy.resource}`);
    }

    const textureFields = ['map', 'bumpMap', 'specMap', 'cloudMap', 'alphaMap'];

    // Keep the property but set to "" if file missing (do NOT delete)
    for (const field of textureFields) {
      if (starCopy[field] && !textureExists(starCopy[field])) {
        starCopy[field] = "";   // important: set empty instead of delete
      }
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
            if (planetCopy[field] && !textureExists(planetCopy[field])) {
              planetCopy[field] = "";
            }
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
                  if (moonCopy[field] && !textureExists(moonCopy[field])) {
                    moonCopy[field] = "";
                  }
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

/**
 * Helper to build an orbits config for a planet's moons.
 * Uses the same updateIntervalMs and baseSpeed as the Sun,
 * but speeds are relative to Earth's Moon (period 27.3 days).
 * @param {Array} moons - Array of moon objects (each with a 'period' in days)
 * @returns {Object} Orbits configuration
 */
function buildPlanetOrbitsConfig(moons) {
  const REFERENCE_PERIOD = 27.3; // Earth's Moon period in days
  const speeds = {};
  for (const moon of moons) {
    const period = moon.period; // in days
    // speed = (reference_period / moon_period)  – faster for shorter period
    const speed = REFERENCE_PERIOD / period;
    speeds[moon.name] = speed;
  }
  return {
    updateIntervalMs: 80,      // same as Sun's orbit update interval
    baseSpeed: 0.00667,        // same base speed as Sun
    speeds: speeds
  };
}

// load universe as complete structure of available stars
function loadUniverse() {
  const universeExists = loadUniverseStates();

  if (!universeExists) {
    console.log('Initializing universe state from default JSON files...');
    try {
      const hasStarsDirectory = fs.existsSync(STARS_DIR);
      const hasPlanetsDirectory = fs.existsSync(PLANETS_DIR);
      const hasMoonsDirectory = fs.existsSync(MOONS_DIR);

      console.log(`Has stars directory: ${hasStarsDirectory}`);
      console.log(`Has planets directory: ${hasPlanetsDirectory}`);
      console.log(`Has moons directory: ${hasMoonsDirectory}`);

      const starMap = readJsonFilesSync(STARS_DIR);
      console.log(starMap);

      const planetMap = readJsonFilesSync(PLANETS_DIR);
      console.log(planetMap);

      const moonMap = readJsonFilesSync(MOONS_DIR);
      console.log(moonMap);

      universeStates = buildUniverseHierarchy(starMap, planetMap, moonMap);

      saveUniverse();
    } catch (err) {
      console.warn('Missing universe directories or error loading:', err.message);
    }

  }
}

function saveUniverse() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(universeStates, null, 2));
    console.log('Saved universe states to file');
  } catch (e) {
    console.error('Failed to save universe states:', e);
  }
}

loadUniverse();

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

app.use(compression({
  strategy: zlib.constants.Z_RLE,
  level: 9,
  filter: (req) => req.url !== '/event'
}));

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

  res.write(`event: init\ndata: ${JSON.stringify({ columns: 128, rows: 64, size: 16 })}\n\n`);

  try {
    const fullUniverse = JSON.parse(JSON.stringify(universeStates));
    res.write(`event: planets\ndata: ${JSON.stringify({ planets: fullUniverse.stars[0].planets.concat([fullUniverse.stars[0]]) })}\n\n`); // keep backward compat + include Sun
    console.log(`SSE: Sent full hierarchical universe`);
  } catch (err) {
    console.error('Failed to send universe:', err);
  }

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

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(keepAlive);
    res.end();
  });
});

const wsServer = https.createServer(httpsOptions);
const wss = new WebSocketServer({ server: wsServer });

function getStar(name) {
  try {
    const filePath = path.resolve(STARS_DIR, `${name}.json`);
    let raw = fs.readFileSync(filePath, 'utf8');
    raw = stripBOM(raw);
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to get start:', err);
    throw err;
  }
}

function getSunPosition() {
  try {
    const sun = getStar('sun');
    return { x: sun.x || 0, y: sun.y || 0, z: sun.z || 0 };
  } catch (err) {
    console.error('Failed to read Sun position:', err);
    return { x: 0, y: 0, z: 0 };
  }
}

function getSunOrbitConfig() {
  try {
    const sun = getStar('sun');
    // Return the orbits object directly (contains baseSpeed, speeds, etc.)
    return sun.orbits || { baseSpeed: 0.00667, speeds: {} };
  } catch (err) {
    console.error('Failed to read Sun orbit config:', err);
    // Return a sensible default so the simulation doesn't break
    return { baseSpeed: 0.00667, speeds: {} };
  }
}

function broadcastOrbitUpdate() {
  const update = {
    type: 'orbitUpdate',
    timestamp: Date.now(),
    // Very small payload: only name + current angle (client recomputes full Kepler position)
    bodies: universeStates.stars[0].planets.map(planet => ({
      name: planet.name,
      angle: (planet.angle || 0) % (Math.PI * 2),
      moons: (planet.moons || []).map(moon => ({
        name: moon.name,
        angle: (moon.angle || 0) % (Math.PI * 2)
      }))
    }))
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(update));
    }
  });
}

setInterval(broadcastOrbitUpdate, 80);

wss.on('connection', (ws) => {
  console.log('Client connected to WSS');
  ws.send(JSON.stringify({
    type: 'orbitSync',
    bodies: universeStates.stars[0].planets.map(planet => ({
      name: planet.name,
      angle: planet.angle || 0,
      moons: (planet.moons || []).map(moon => ({
        name: moon.name,
        angle: moon.angle || 0
      }))
    }))
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
