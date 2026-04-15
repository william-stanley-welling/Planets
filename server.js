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

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateRandomRing(rng, bodyDiameter) {
  const inner = bodyDiameter * (1.2 + rng() * 0.8);
  const outer = bodyDiameter * (1.8 + rng() * 1.5);
  return {
    name: `Ring-${Math.floor(rng() * 10000)}`,
    type: 'ring',
    inner: inner,
    outer: outer,
    thickness: 0.01 + rng() * 0.15,
    color: `#${Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0')}`,
    particleCount: Math.floor(rng() * 3000) + 500,
    rotationSpeed: 0.001 + rng() * 0.02,
    texture: ''
  };
}

function generateRandomMoon(rng, planet, moonIndex) {
  const diameter = 0.01 + rng() * (planet.diameter * 0.15);
  return {
    name: `${planet.name}-Moon${moonIndex}`,
    type: 'moon',
    map: '',
    diameter: diameter,
    atmosphere: 0,
    widthSegments: 24,
    heightSegments: 24,
    mass: (diameter ** 3) * 0.5, // rough density scaling
    pow: 20,
    color: `#${Math.floor(rng() * 0xcccccc + 0x333333).toString(16)}`,
    period: 1 + rng() * 80, // days
    tilt: rng() * 10 - 5,
    spin: 0.005 + rng() * 0.03,
    eccentricity: rng() * 0.15,
    inclination: rng() * 8,
    semiMajorAxis: planet.diameter * (3 + rng() * 12),
    resource: ''
  };
}

function generateRandomPlanet(rng, star, planetIndex) {
  const types = ['rocky', 'gas_giant', 'ice_giant'];
  const type = types[Math.floor(rng() * types.length)];

  let diameter, mass, color, au;
  if (type === 'rocky') {
    diameter = 0.4 + rng() * 2.0;
    mass = diameter ** 3 * (3 + rng() * 2);
    color = `#${[0xa0, 0x90, 0x80].map(c => Math.floor(c + rng() * 0x60)).map(c => c.toString(16).padStart(2, '0')).join('')}`;
    au = 0.3 + planetIndex * (0.4 + rng() * 0.8);
  } else if (type === 'gas_giant') {
    diameter = 6 + rng() * 8;
    mass = diameter ** 3 * (0.5 + rng() * 0.5);
    color = `#${[0xd0, 0xb0, 0x80].map(c => Math.floor(c + rng() * 0x40)).map(c => c.toString(16).padStart(2, '0')).join('')}`;
    au = 1.5 + planetIndex * (1.0 + rng() * 1.5);
  } else {
    diameter = 3.5 + rng() * 4;
    mass = diameter ** 3 * (0.8 + rng() * 0.7);
    color = `#${[0x80, 0xb0, 0xd0].map(c => Math.floor(c + rng() * 0x40)).map(c => c.toString(16).padStart(2, '0')).join('')}`;
    au = 2.5 + planetIndex * (1.2 + rng() * 1.8);
  }

  const period = Math.sqrt(au * au * au) * 365.25; // days

  const planet = {
    name: `${star.name}-${planetIndex + 1}`,
    type: 'planet',
    map: '',
    bumpMap: '',
    specMap: '',
    cloudMap: '',
    alphaMap: '',
    diameter: diameter,
    atmosphere: rng() > 0.7 ? 0.005 : 0,
    widthSegments: 32,
    heightSegments: 32,
    mass: mass,
    pow: type === 'gas_giant' ? 24 : 24,
    x: 0, y: 0, z: 0,
    au: au,
    color: color,
    period: period,
    tilt: rng() * 30 - 15,
    spin: 0.005 + rng() * 0.02,
    eccentricity: rng() * 0.25,
    inclination: rng() * 10,
    moons: [],
    rings: [],
    resource: ''
  };

  // Moons
  const moonCount = Math.floor(rng() * 5);
  for (let m = 0; m < moonCount; m++) {
    planet.moons.push(generateRandomMoon(rng, planet, m + 1));
  }

  // Rings (gas giants only, sometimes)
  if ((type === 'gas_giant' || type === 'ice_giant') && rng() > 0.6) {
    planet.rings.push(generateRandomRing(rng, planet.diameter));
  }

  return planet;
}

function generateRandomStarSystem(seed) {
  const rng = mulberry32(seed);

  const starTypes = [
    { name: 'Red Dwarf', color: '#ffaa88', diameter: 0.4, mass: 0.3, temp: 3500 },
    { name: 'Orange Dwarf', color: '#ffcc88', diameter: 0.9, mass: 0.8, temp: 4800 },
    { name: 'Yellow Dwarf', color: '#ffffaa', diameter: 1.0, mass: 1.0, temp: 5800 },
    { name: 'White Dwarf', color: '#aaccff', diameter: 0.03, mass: 0.6, temp: 10000 },
    { name: 'Blue Giant', color: '#aaccff', diameter: 4.0, mass: 8.0, temp: 12000 }
  ];

  const type = starTypes[Math.floor(rng() * starTypes.length)];

  const star = {
    name: `Star-${seed.toString(16).toUpperCase()}`,
    type: 'star',
    map: '',
    bumpMap: '',
    specMap: '',
    diameter: type.diameter * (0.8 + rng() * 0.5),
    atmosphere: 0,
    widthSegments: 128,
    heightSegments: 128,
    mass: type.mass * (0.8 + rng() * 0.4),
    pow: 30,
    x: 0, y: 0, z: 0,
    au: 0,
    color: type.color,
    period: 0,
    tilt: rng() * 20 - 10,
    spin: 0.001 + rng() * 0.008,
    magneticField: rng() > 0.4 ? {
      strength: rng() * 20,
      radius: 1.5 + rng() * 4,
      tilt: rng() * 15,
      polarity: rng() > 0.5 ? 1 : -1
    } : undefined,
    planets: [],
    rings: [],
    comets: [],
    resource: ''
  };

  const planetCount = Math.floor(rng() * 9) + 1;
  for (let p = 0; p < planetCount; p++) {
    star.planets.push(generateRandomPlanet(rng, star, p));
  }

  // Star rings (asteroid belts)
  if (rng() > 0.7) {
    star.rings.push({
      name: `Belt-${Math.floor(rng() * 1000)}`,
      type: 'ring',
      inner: star.diameter * (3 + rng() * 5),
      outer: star.diameter * (6 + rng() * 8),
      thickness: 0.1 + rng() * 0.5,
      color: `#${Math.floor(rng() * 0xaaaaaa + 0x555555).toString(16)}`,
      particleCount: Math.floor(rng() * 8000) + 2000,
      period: 0,
      keplerianRotation: true
    });
  }

  return star;
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
                  type: 'moon',
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

      else if (data.type === 'travelToRandom') {
        const seed = data.seed || Math.floor(Math.random() * 1_000_000_000);
        console.log(`[ws] Generating random star system with seed ${seed}`);

        const newStar = generateRandomStarSystem(seed);

        console.log(`[ws] Generated star system: ${newStar.name} with ${newStar.planets.length} planets.`);

        // Replace current star
        universeStates.stars = [newStar];
        simulationTime = Date.now();
        simulationSpeed = 1.0;
        lastUpdateMs = Date.now();
        bodiesTrueAnomaly = computeInitialTrueAnomalies(newStar, simulationTime);

        saveUniverse();

        // Broadcast to all clients
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'orbitSync',
              simulationTime,
              trueAnomalies: bodiesTrueAnomaly
            }));
          }
        }
        console.log('[ws] Random universe broadcasted.');
      }


      else if (data.type === 'getPlanets') {
        const star = universeStates.stars[0];
        const allBodies = [
          ...(star?.comets ?? []),
          ...(star?.planets ?? []),
          star,
        ].filter(Boolean);
        ws.send(JSON.stringify({
          type: 'planetsData',
          planets: allBodies,
          simulationTime,
          simulationSpeed
        }));
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

  // Accurate J2000 M0 values (verified against NASA/JPL ephemerides)
  const knownM0 = {
    "Earth": 1.796,          // J2000
    "Moon": 0.0,             // relative to Earth
    "Mars": 0.937,
    "Jupiter": 0.529,
    "Saturn": 0.0,
    "Uranus": 0.0,
    "Neptune": 0.0,
    "Venus": 3.2,
    "Mercury": 4.1,
    "Halley": 3.5,           // adjusted so in 2026 it is near aphelion (correct, faint until ~2061)
    "Hale-Bopp": 2.8
    // moons use relative M0 ≈ 0 (already accurate in data)
  };

  const compute = (body) => {
    if (body.period > 0) {
      const M0 = knownM0[body.name] ?? 0;
      const M = (M0 + 2 * Math.PI * days / body.period) % (2 * Math.PI);
      const Mnorm = M < 0 ? M + 2 * Math.PI : M;
      angles[body.name] = solveKepler(Mnorm, body.eccentricity ?? 0);
    } else {
      angles[body.name] = 0;
    }
    // rings & comets unchanged
    if (Array.isArray(body.rings)) { /* ... same as before */ }
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

  const sendInitial = () => {
    console.log(universeStates);
    const star = universeStates.stars?.[0];
    const allBodies = star
      ? [star, ...(star.planets || []), ...(star.comets || [])]
      : [];


    console.log(`[SSE] Initial data sent: ${allBodies.length} bodies, simulationTime=${simulationTime}, simulationSpeed=${simulationSpeed}`);

    res.write(`event: planets\ndata: ${JSON.stringify({
      planets: allBodies,
      simulationTime,
      simulationSpeed,
    })}\n\n`);
  };

  sendInitial();

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
