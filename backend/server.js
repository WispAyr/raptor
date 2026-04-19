require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const ONVIFController = require('./controllers/onvif');
const VAPIXController = require('./controllers/vapix');
const PIDController = require('./controllers/pid');
const PatrolManager = require('./services/patrol');
const EventRecorder = require('./services/recorder');
const ZMQBridge = require('./bridge/zmq-bridge');

// ── Directories ──────────────────────────────────────────────────────────────
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './recordings';
const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR || './snapshots';
[RECORDINGS_DIR, SNAPSHOTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('./raptor.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'onvif',
    host TEXT NOT NULL,
    port INTEGER DEFAULT 80,
    username TEXT DEFAULT 'admin',
    password TEXT DEFAULT 'password',
    stream_url TEXT,
    snapshot_url TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER,
    track_id TEXT,
    class TEXT,
    confidence REAL,
    centroid_x REAL,
    centroid_y REAL,
    pan REAL,
    tilt REAL,
    zoom REAL,
    time_visible_ms INTEGER,
    clip_path TEXT,
    snapshot_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER,
    name TEXT,
    pan REAL,
    tilt REAL,
    zoom REAL,
    dwell_ms INTEGER DEFAULT 5000,
    sort_order INTEGER DEFAULT 0
  );
`);

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => handleClientMessage(ws, JSON.parse(raw)));
  // Send initial state
  ws.send(JSON.stringify({ type: 'state', cameras: getCameras(), tracking: trackingState }));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Camera registry ───────────────────────────────────────────────────────────
const controllers = new Map(); // camera_id → controller instance

function getCameras() {
  return db.prepare('SELECT * FROM cameras WHERE active = 1').all();
}

function getController(cameraId) {
  if (!controllers.has(cameraId)) {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);
    const ctrl = cam.protocol === 'vapix'
      ? new VAPIXController(cam)
      : new ONVIFController(cam);
    controllers.set(cameraId, ctrl);
  }
  return controllers.get(cameraId);
}

// ── Tracking state ────────────────────────────────────────────────────────────
const trackingState = {
  active: false,
  cameraId: null,
  trackId: null,
  targetClass: null,
  confidence: 0,
  centroid: { x: 0, y: 0 },
  pan: 0, tilt: 0, zoom: 1,
  mode: 'patrol', // 'tracking' | 'patrol' | 'manual'
};

const panPID = new PIDController(
  parseFloat(process.env.PID_PAN_KP) || 0.4,
  parseFloat(process.env.PID_PAN_KI) || 0.01,
  parseFloat(process.env.PID_PAN_KD) || 0.08
);
const tiltPID = new PIDController(
  parseFloat(process.env.PID_TILT_KP) || 0.4,
  parseFloat(process.env.PID_TILT_KI) || 0.01,
  parseFloat(process.env.PID_TILT_KD) || 0.08
);

// ── Detection bridge ──────────────────────────────────────────────────────────
const recorder = new EventRecorder({ recordingsDir: RECORDINGS_DIR, snapshotsDir: SNAPSHOTS_DIR, db });
const patrol = new PatrolManager({ db, getController, broadcast });

const bridge = new ZMQBridge(process.env.ZMQ_DETECTION_ENDPOINT || 'tcp://127.0.0.1:5556');

bridge.on('detection', async (event) => {
  const { track_id, class: cls, confidence, centroid_x, centroid_y, frame_w, frame_h, camera_id } = event;

  broadcast({ type: 'detection', ...event });

  // Only track if a camera is selected
  const activeCameraId = camera_id || trackingState.cameraId;
  if (!activeCameraId) return;

  const ctrl = getController(activeCameraId);

  // Pixel error from centre of frame
  const dx = centroid_x - (frame_w / 2);
  const dy = centroid_y - (frame_h / 2);
  const normalDx = dx / (frame_w / 2);  // -1..+1
  const normalDy = dy / (frame_h / 2);  // -1..+1

  const now = Date.now();
  const dt = 0.033; // ~30fps assumed
  const panVel = panPID.compute(normalDx, dt);
  const tiltVel = tiltPID.compute(normalDy, dt);

  try {
    await ctrl.continuousMove(panVel, -tiltVel, 0);
  } catch (err) {
    console.error('[PTZ] continuousMove failed:', err.message);
  }

  // Update tracking state
  Object.assign(trackingState, {
    active: true,
    cameraId: activeCameraId,
    trackId: track_id,
    targetClass: cls,
    confidence,
    centroid: { x: centroid_x, y: centroid_y },
    mode: 'tracking',
  });

  patrol.pause();
  broadcast({ type: 'tracking', state: trackingState });

  // Record event
  recorder.onDetection({ camera_id: activeCameraId, track_id, cls, confidence, centroid_x, centroid_y });
});

bridge.on('lost', () => {
  panPID.reset();
  tiltPID.reset();
  trackingState.active = false;
  trackingState.mode = 'patrol';
  broadcast({ type: 'tracking', state: trackingState });

  const activeCameraId = trackingState.cameraId;
  if (activeCameraId) {
    try { getController(activeCameraId).stop(); } catch (_) {}
  }

  patrol.resume(parseInt(process.env.PATROL_RESUME_DELAY_MS) || 5000);
});

bridge.start();

// ── WebSocket message handler ─────────────────────────────────────────────────
async function handleClientMessage(ws, msg) {
  const { type, cameraId, ...payload } = msg;

  try {
    switch (type) {
      case 'ptz:move': {
        const ctrl = getController(cameraId);
        await ctrl.continuousMove(payload.pan, payload.tilt, payload.zoom);
        break;
      }
      case 'ptz:stop': {
        const ctrl = getController(cameraId);
        await ctrl.stop();
        break;
      }
      case 'ptz:preset': {
        const ctrl = getController(cameraId);
        await ctrl.gotoPreset(payload.presetToken);
        break;
      }
      case 'mode:set': {
        trackingState.mode = payload.mode;
        if (payload.mode === 'patrol') patrol.resume(0);
        if (payload.mode === 'manual') patrol.pause();
        broadcast({ type: 'tracking', state: trackingState });
        break;
      }
      case 'camera:select': {
        trackingState.cameraId = cameraId;
        broadcast({ type: 'tracking', state: trackingState });
        break;
      }
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Cameras
app.get('/api/cameras', (req, res) => res.json(getCameras()));

app.post('/api/cameras', (req, res) => {
  const { name, protocol = 'onvif', host, port = 80, username = 'admin', password, stream_url, snapshot_url } = req.body;
  const result = db.prepare(
    'INSERT INTO cameras (name, protocol, host, port, username, password, stream_url, snapshot_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, protocol, host, port, username, password, stream_url, snapshot_url);
  res.json(db.prepare('SELECT * FROM cameras WHERE id = ?').get(result.lastInsertRowid));
});

app.delete('/api/cameras/:id', (req, res) => {
  db.prepare('UPDATE cameras SET active = 0 WHERE id = ?').run(req.params.id);
  controllers.delete(parseInt(req.params.id));
  res.json({ ok: true });
});

// Camera status / snapshot
app.get('/api/cameras/:id/snapshot', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    const data = await ctrl.snapshot();
    res.set('Content-Type', 'image/jpeg');
    res.send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cameras/:id/status', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    const status = await ctrl.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PTZ REST (for testing)
app.post('/api/cameras/:id/ptz/move', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    await ctrl.continuousMove(req.body.pan || 0, req.body.tilt || 0, req.body.zoom || 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras/:id/ptz/stop', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    await ctrl.stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras/:id/ptz/absolute', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    await ctrl.absoluteMove(req.body.pan, req.body.tilt, req.body.zoom);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Presets
app.get('/api/cameras/:id/presets', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    const presets = await ctrl.getPresets();
    res.json(presets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cameras/:id/presets/:token/goto', async (req, res) => {
  try {
    const ctrl = getController(parseInt(req.params.id));
    await ctrl.gotoPreset(req.params.token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Patrol
app.get('/api/patrol', (req, res) => res.json(patrol.getState()));
app.post('/api/patrol/start', (req, res) => { patrol.resume(0); res.json({ ok: true }); });
app.post('/api/patrol/stop', (req, res) => { patrol.pause(); res.json({ ok: true }); });
app.put('/api/patrol/presets', (req, res) => {
  patrol.setPresets(req.body.presets);
  res.json({ ok: true });
});

// Events log
app.get('/api/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit));
});

// Tracking state
app.get('/api/tracking', (req, res) => res.json(trackingState));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`🦅 RAPTOR backend running on http://localhost:${PORT}`);
});

module.exports = { app, broadcast };
