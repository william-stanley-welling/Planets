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
const PLANET_DIR = path.resolve(__dirname, './resources/planets');
const STATE_FILE = path.resolve(__dirname, './resources/planetStates.json');

const PLANET_NAMES = [
  'sun', 'mercury', 'venus', 'earth', 'mars',
  'jupiter', 'saturn', 'uranus', 'neptune'
];

const SCALE_UNITS_PER_AU = 1496;

const ORBIT_CONFIG = {
  updateIntervalMs: 80,
  baseSpeed: 0.00667,
  speeds: {
    'Sun': 0,
    'Mercury': 4.15,
    'Venus': 1.62,
    'Earth': 1.0,
    'Mars': 0.53,
    'Jupiter': 0.084,
    'Saturn': 0.034,
    'Uranus': 0.012,
    'Neptune': 0.006
  }
};

let planetStates = {};

const httpsOptions = {
  cert: fs.readFileSync(path.resolve(CERTS_ROOT, 'cert.pem')),
  key: fs.readFileSync(path.resolve(CERTS_ROOT, 'key.pem')),
};

function stripBOM(str) {
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

const normalizeName = (name) =>
  name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

function loadPlanetStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      planetStates = JSON.parse(stripBOM(raw));
      console.log(`Loaded ${Object.keys(planetStates).length} planets from persisted state`);
      return;
    }
  } catch (err) {
    console.warn('No persisted state or error loading:', err.message);
  }

  console.log('Initializing planetStates from JSON files...');
  PLANET_NAMES.forEach((name) => {
    const filePath = path.resolve(PLANET_DIR, `${name}.json`);
    let rawData = fs.readFileSync(filePath, 'utf8');
    rawData = stripBOM(rawData);
    const p = JSON.parse(rawData);
    const au = p.au || (p.x ? p.x / SCALE_UNITS_PER_AU : 1.0);
    const normName = normalizeName(p.name);

    planetStates[normName] = {
      angle: Math.random() * Math.PI * 2,
      au,
      x: p.x || au * SCALE_UNITS_PER_AU,
      y: 0,
      z: 0
    };
  });
}

function savePlanetStates() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(planetStates, null, 2));
    console.log('Saved planetStates to file');
  } catch (e) {
    console.error('Failed to save planetStates:', e);
  }
}

loadPlanetStates();

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

app.get('/event', (req, res) => {
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`event: init\ndata: ${JSON.stringify({ columns: 128, rows: 64, size: 16 })}\n\n`);

  try {
    const initialPlanets = PLANET_NAMES.map((name) => {
      const filePath = path.resolve(PLANET_DIR, `${name}.json`);
      let rawData = fs.readFileSync(filePath, 'utf8');
      rawData = stripBOM(rawData);
      return JSON.parse(rawData);
    });
    res.write(`event: planets\ndata: ${JSON.stringify({ planets: initialPlanets })}\n\n`);
    console.log(`SSE: Sent ${initialPlanets.length} planets`);
  } catch (err) {
    console.error('Failed to load initial planets:', err);
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Failed to load planets' })}\n\n`);
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

function getSunPosition() {
  try {
    const filePath = path.resolve(PLANET_DIR, 'sun.json');
    let raw = fs.readFileSync(filePath, 'utf8');
    raw = stripBOM(raw);
    const sun = JSON.parse(raw);
    return { x: sun.x || 0, y: sun.y || 0, z: sun.z || 0 };
  } catch (err) {
    console.error('Failed to read Sun position:', err);
    return { x: 0, y: 0, z: 0 };
  }
}

function broadcastOrbitUpdate() {
  const sunPos = getSunPosition();

  const update = {
    type: 'orbitUpdate',
    timestamp: Date.now(),
    planets: Object.keys(planetStates).map(name => {
      const state = planetStates[name];

      if (normalizeName(name) !== 'Sun') {
        const speed = ORBIT_CONFIG.speeds[normalizeName(name)] || 1.0;
        state.angle += ORBIT_CONFIG.baseSpeed * speed;
        state.x = sunPos.x + state.au * Math.cos(state.angle) * SCALE_UNITS_PER_AU;
        state.z = sunPos.z + state.au * Math.sin(state.angle) * SCALE_UNITS_PER_AU;
      }

      return {
        name,
        x: Math.round(state.x),
        y: Math.round(state.y),
        z: Math.round(state.z),
        angle: state.angle % (Math.PI * 2)
      };
    })
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(update));
    }
  });
}

setInterval(broadcastOrbitUpdate, ORBIT_CONFIG.updateIntervalMs);

wss.on('connection', (ws) => {
  console.log('Client connected to WSS');
  ws.send(JSON.stringify({
    type: 'orbitSync',
    planets: Object.entries(planetStates).map(([name, s]) => ({
      name,
      x: Math.round(s.x),
      y: 0,
      z: Math.round(s.z)
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

process.on('SIGINT', () => { savePlanetStates(); process.exit(0); });
process.on('SIGTERM', () => { savePlanetStates(); process.exit(0); });

app.get(/^((?!\.).)*$/, (req, res) => {
  const distIndex = path.resolve(__dirname, 'dist/planets/browser/index.html');
  const viewIndex = path.resolve(__dirname, 'view/index.html');
  res.sendFile(fs.existsSync(distIndex) ? distIndex : viewIndex);
});

https.createServer(httpsOptions, app).listen(port, () => {
  console.log(`HTTPS/SSE: https://localhost:${port}`);
  console.log(`WSS:       wss://localhost:${wsPort}`);
});
