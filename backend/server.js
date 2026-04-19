require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const Database   = require('better-sqlite3');
const fs         = require('fs');

const { loadConfig }       = require('../raptor.config');
const cfg                  = loadConfig();

const ONVIFController      = require('./controllers/onvif');
const VAPIXController      = require('./controllers/vapix');
const VISCAController      = require('./controllers/visca');
const PIDController        = require('./controllers/pid');
const CoordinateMapper     = require('./controllers/coordinate-mapper');
const AutoZoom             = require('./controllers/auto-zoom');

const PatrolManager        = require('./services/patrol');
const EventRecorder        = require('./services/recorder');
const DualCameraService    = require('./services/dual-camera');
const ADSBService          = require('./services/adsb');
const SensorFusionService  = require('./services/sensor-fusion');
const WeatherService       = require('./services/weather');
const HLSStreamer           = require('./services/hls-streamer');

const ZMQBridge            = require('./bridge/zmq-bridge');
const SKYTRACKBridge       = require('./bridge/skytrack-bridge');
const AirWaveBridge        = require('./bridge/airwave-bridge');
const PrismLens            = require('./bridge/prism-lens');
const NuroBridge           = require('./bridge/nuro-bridge');

const createExportRouter   = require('./routes/export');

// ── Dirs ──────────────────────────────────────────────────────────────────────
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './recordings';
const SNAPSHOTS_DIR  = process.env.SNAPSHOTS_DIR  || './snapshots';
const STREAMS_DIR    = process.env.HLS_OUTPUT_DIR  || './streams';
[RECORDINGS_DIR, SNAPSHOTS_DIR, STREAMS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './raptor.db');
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
    az REAL,
    el REAL,
    bearing TEXT,
    velocity_px REAL,
    anomaly_flag INTEGER DEFAULT 0,
    trajectory_score REAL,
    alert_level TEXT DEFAULT 'LOW',
    adsb_corroborated INTEGER DEFAULT 0,
    adsb_callsign TEXT,
    pan REAL,
    tilt REAL,
    zoom REAL,
    time_visible_ms INTEGER,
    clip_path TEXT,
    snapshot_path TEXT,
    source TEXT DEFAULT 'detector',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER,
    name TEXT,
    token TEXT,
    pan REAL,
    tilt REAL,
    zoom REAL,
    dwell_ms INTEGER DEFAULT 5000,
    sort_order INTEGER DEFAULT 0
  );
`);

// ── Express + WebSocket ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const clients = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/dist')));

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Camera registry ───────────────────────────────────────────────────────────
const controllers = new Map();

function getCameras() {
  return db.prepare('SELECT * FROM cameras WHERE active = 1').all();
}

function getController(cameraId) {
  if (!controllers.has(cameraId)) {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);
    let ctrl;
    if (cam.protocol === 'vapix')       ctrl = new VAPIXController(cam);
    else if (cam.protocol === 'visca')  ctrl = new VISCAController({ host: cam.host, port: cam.port || 5678 });
    else                                ctrl = new ONVIFController(cam);
    controllers.set(cameraId, ctrl);
  }
  return controllers.get(cameraId);
}

// ── Coordinate mapper (one per station) ──────────────────────────────────────
const coordMapper = new CoordinateMapper({
  lat:     parseFloat(process.env.STATION_LAT  || '0'),
  lon:     parseFloat(process.env.STATION_LON  || '0'),
  alt:     parseFloat(process.env.STATION_ALT  || '0'),
  hfov:    parseFloat(process.env.CAMERA_HFOV  || '60'),
  vfov:    parseFloat(process.env.CAMERA_VFOV  || '34'),
  homeAz:  parseFloat(process.env.CAMERA_HOME_AZ || '0'),
});

// ── Tracking state ────────────────────────────────────────────────────────────
const trackingState = {
  active: false, cameraId: null, trackId: null,
  targetClass: null, confidence: 0,
  centroid: { x: 0, y: 0 },
  az: null, el: null, bearing: null,
  pan: 0, tilt: 0, zoom: 0,
  mode: 'patrol',
  alertLevel: 'LOW',
  fusionScore: 0,
};

const panPID  = new PIDController(
  parseFloat(process.env.PID_PAN_KP)  || 0.4,
  parseFloat(process.env.PID_PAN_KI)  || 0.01,
  parseFloat(process.env.PID_PAN_KD)  || 0.08
);
const tiltPID = new PIDController(
  parseFloat(process.env.PID_TILT_KP) || 0.4,
  parseFloat(process.env.PID_TILT_KI) || 0.01,
  parseFloat(process.env.PID_TILT_KD) || 0.08
);

// ── Auto-zoom ─────────────────────────────────────────────────────────────────
const autoZoom = new AutoZoom({
  centreThreshold: parseFloat(process.env.AUTO_ZOOM_CENTRE_THRESHOLD || '0.15'),
  edgeThreshold:   parseFloat(process.env.AUTO_ZOOM_EDGE_THRESHOLD   || '0.35'),
  dwellFrames:     parseInt(process.env.AUTO_ZOOM_DWELL_FRAMES       || '20'),
  zoomStep:        parseFloat(process.env.AUTO_ZOOM_STEP             || '0.05'),
  onZoom: (level) => {
    const cid = trackingState.cameraId;
    if (cid && cfg.tracking.autoZoom) {
      try { getController(cid).continuousMove(0, 0, level > 0 ? 0.3 : -0.3); } catch (_) {}
    }
  },
});
if (!cfg.tracking.autoZoom) autoZoom.disable();

// ── Core services ─────────────────────────────────────────────────────────────
const recorder = new EventRecorder({ recordingsDir: RECORDINGS_DIR, snapshotsDir: SNAPSHOTS_DIR, db });
const patrol   = new PatrolManager({ db, getController, broadcast });
const fusion   = new SensorFusionService({ broadcast });

// ── Weather ───────────────────────────────────────────────────────────────────
let weather = null;
if (cfg.sensors.weather) {
  weather = new WeatherService({
    lat: parseFloat(process.env.STATION_LAT || '0'),
    lon: parseFloat(process.env.STATION_LON || '0'),
  });
  weather.on('update', (data) => {
    fusion.setWeather(data);
    broadcast({ type: 'weather', data });
  });
  weather.start();
}

// ── ADS-B ─────────────────────────────────────────────────────────────────────
let adsbSource = null;
if (cfg.sensors.adsb) {
  const directAdsb = new ADSBService({
    host:       process.env.ADSB_HOST    || 'localhost',
    port:       parseInt(process.env.ADSB_PORT || '8080'),
    radiusNm:   parseInt(process.env.ADSB_RADIUS_NM || '25'),
    stationLat: parseFloat(process.env.STATION_LAT || '0'),
    stationLon: parseFloat(process.env.STATION_LON || '0'),
    stationAlt: parseFloat(process.env.STATION_ALT || '0'),
  });

  if (process.env.AIRWAVE_WS_URL) {
    adsbSource = new AirWaveBridge({ wsUrl: process.env.AIRWAVE_WS_URL, fallback: directAdsb });
  } else {
    adsbSource = directAdsb;
  }

  adsbSource.on('update', (aircraft) => broadcast({ type: 'adsb', aircraft }));
  adsbSource.start();
}

// ── HLS streaming ─────────────────────────────────────────────────────────────
let hls = null;
if (process.env.HLS_ENABLED === 'true') {
  hls = new HLSStreamer({ outputDir: STREAMS_DIR });
  getCameras().forEach(cam => cam.stream_url && hls.start(cam));
  app.use('/streams', express.static(STREAMS_DIR));
  app.get('/api/streams', (req, res) => res.json(hls.getStatus()));
}

// ── Ecosystem bridges ─────────────────────────────────────────────────────────
const prism = new PrismLens({
  prismUrl:      process.env.PRISM_URL,
  stationId:     process.env.STATION_ID || 'raptor-1',
  minAlertLevel: 1,
});

const nuro = new NuroBridge({ webhookUrl: process.env.NURO_WEBHOOK_URL });
nuro.on('command:slew',   ({ az, el, cameraId }) => slewToAzEl(az, el, cameraId));
nuro.on('command:patrol', ({ action }) => action === 'start' ? patrol.resume(0) : patrol.pause());
nuro.on('command:mode',   ({ mode }) => setMode(mode));

// ── Dual-camera ───────────────────────────────────────────────────────────────
let dualCam = null;
if (cfg.tracking.dualCamera) {
  dualCam = new DualCameraService({
    spotterConfig: {
      lat:    parseFloat(process.env.STATION_LAT  || '0'),
      lon:    parseFloat(process.env.STATION_LON  || '0'),
      alt:    parseFloat(process.env.STATION_ALT  || '0'),
      hfov:   parseFloat(process.env.SPOTTER_HFOV || '90'),
      vfov:   parseFloat(process.env.SPOTTER_VFOV || '60'),
      homeAz: parseFloat(process.env.SPOTTER_HOME_AZ || '0'),
    },
    trackerCameraId: parseInt(process.env.PTZ_CAMERA_ID || '1'),
    getController,
    broadcast,
    acquireTimeoutMs:  parseInt(process.env.ACQUIRE_TIMEOUT_MS  || '8000'),
    handoffCooldownMs: parseInt(process.env.HANDOFF_COOLDOWN_MS || '3000'),
  });
  dualCam.on('acquired', (trackId) => {
    trackingState.mode = 'tracking';
    broadcast({ type: 'tracking', state: trackingState });
  });
}

// ── SKYTRACK bridge ───────────────────────────────────────────────────────────
if (process.env.SKYTRACK_WS_URL) {
  const skytrack = new SKYTRACKBridge({
    wsUrl: process.env.SKYTRACK_WS_URL,
    stationConfig: {
      lat:    parseFloat(process.env.STATION_LAT || '0'),
      lon:    parseFloat(process.env.STATION_LON || '0'),
      alt:    parseFloat(process.env.STATION_ALT || '0'),
      hfov:   parseFloat(process.env.CAMERA_HFOV || '60'),
      vfov:   parseFloat(process.env.CAMERA_VFOV || '34'),
      homeAz: parseFloat(process.env.CAMERA_HOME_AZ || '0'),
    },
    onDetection: (ev) => processDetection(ev),
    onTrackLost: (id) => handleLost(id),
  });
  skytrack.start();
}

// ── ZMQ bridge ────────────────────────────────────────────────────────────────
const zmq = new ZMQBridge(process.env.ZMQ_DETECTION_ENDPOINT || 'tcp://127.0.0.1:5556');
zmq.on('detection', processDetection);
zmq.on('lost',      ({ track_id }) => handleLost(track_id));
zmq.start();

// ── Core detection handler ────────────────────────────────────────────────────
async function processDetection(event) {
  const { track_id, class: cls, confidence, centroid_x, centroid_y,
          frame_w = 1280, frame_h = 720, camera_id } = event;

  // Coordinate mapping
  const coords = coordMapper.pixelToAzEl(centroid_x, centroid_y, frame_w, frame_h);
  event.az      = coords.az;
  event.el      = coords.el;
  event.bearing = coords.bearing;

  // ADS-B corroboration
  if (adsbSource) adsbSource.enrichDetection(event);

  // Sensor fusion scoring
  fusion.onDetection(event);

  // Dual-camera spotter hand-off
  if (dualCam && trackingState.mode !== 'tracking') {
    dualCam.onSpotterDetection(event);
  }

  broadcast({ type: 'detection', ...event });

  const activeCameraId = camera_id || trackingState.cameraId;
  if (!activeCameraId || trackingState.mode === 'manual') return;

  // PID tracking
  const dx = centroid_x - frame_w / 2;
  const dy = centroid_y - frame_h / 2;
  const ndx = dx / (frame_w / 2);
  const ndy = dy / (frame_h / 2);

  const dt     = 0.033;
  const panVel  = panPID.compute(ndx, dt);
  const tiltVel = tiltPID.compute(ndy, dt);

  try {
    const ctrl = getController(activeCameraId);
    await ctrl.continuousMove(panVel, -tiltVel, 0);
    // Update encoder position for coordinate mapper
    coordMapper.updatePosition(
      (coordMapper.currentPan  || 0) + panVel  * 2,
      (coordMapper.currentTilt || 0) + tiltVel * 2
    );
  } catch (err) {
    console.error('[PTZ] move failed:', err.message);
  }

  // Auto-zoom
  autoZoom.update(ndx, ndy);

  // Persist event
  try {
    db.prepare(`INSERT INTO events
      (camera_id, track_id, class, confidence, centroid_x, centroid_y,
       az, el, bearing, velocity_px, anomaly_flag, trajectory_score,
       alert_level, adsb_corroborated, adsb_callsign, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      activeCameraId, track_id, cls, confidence,
      centroid_x, centroid_y,
      event.az, event.el, event.bearing,
      event.velocity_px ?? null,
      event.anomaly_flag ? 1 : 0,
      event.trajectory_score ?? null,
      event.alert_level || 'LOW',
      event.adsb_corroborated ? 1 : 0,
      event.adsb?.callsign || null,
      event.source || 'detector'
    );
  } catch (_) {}

  // Ecosystem forwarding
  fusion.once('fusion', async (fev) => {
    await prism.send(fev);
    await nuro.sendAlert(fev);
  });

  Object.assign(trackingState, {
    active: true, cameraId: activeCameraId,
    trackId: track_id, targetClass: cls, confidence,
    centroid: { x: centroid_x, y: centroid_y },
    az: event.az, el: event.el, bearing: event.bearing,
    mode: 'tracking',
    alertLevel: event.alert_level || 'LOW',
  });

  patrol.pause();
  recorder.onDetection({ camera_id: activeCameraId, track_id, cls, confidence, centroid_x, centroid_y });
  broadcast({ type: 'tracking', state: trackingState });
}

function handleLost(trackId) {
  panPID.reset(); tiltPID.reset(); autoZoom.reset();
  fusion.onTrackLost(trackId);
  if (dualCam) dualCam.onTrackerLost();
  recorder.onTrackLost(trackId);

  const cid = trackingState.cameraId;
  if (cid) { try { getController(cid).stop(); } catch (_) {} }

  Object.assign(trackingState, {
    active: false, trackId: null, targetClass: null,
    confidence: 0, az: null, el: null, bearing: null, mode: 'patrol',
  });

  broadcast({ type: 'tracking', state: trackingState });
  patrol.resume(parseInt(process.env.PATROL_RESUME_DELAY_MS) || 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function slewToAzEl(az, el, cameraId) {
  const cid = cameraId || trackingState.cameraId;
  if (!cid) return;
  const { pan, tilt } = coordMapper.azElToMove(az, el);
  try { await getController(cid).absoluteMove(pan, tilt, 0); } catch (err) {
    console.error('[Slew] failed:', err.message);
  }
}

function setMode(mode) {
  trackingState.mode = mode;
  if (mode === 'patrol') patrol.resume(0);
  if (mode === 'manual') { patrol.pause(); autoZoom.disable(); }
  if (mode === 'tracking') autoZoom.enable();
  broadcast({ type: 'tracking', state: trackingState });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', (raw) => {
    try { handleClientMessage(ws, JSON.parse(raw)); } catch (_) {}
  });
  ws.send(JSON.stringify({
    type: 'state',
    cameras: getCameras(),
    tracking: trackingState,
    patrol: patrol.getState(),
    config: { profile: process.env.RAPTOR_PROFILE || 'single', features: cfg },
    adsb: adsbSource?.getAircraft() || [],
    weather: weather?.current || null,
  }));
});

async function handleClientMessage(ws, msg) {
  const { type, cameraId, ...payload } = msg;
  try {
    switch (type) {
      case 'ptz:move':    await getController(cameraId).continuousMove(payload.pan, payload.tilt, payload.zoom); break;
      case 'ptz:stop':    await getController(cameraId).stop(); break;
      case 'ptz:preset':  await getController(cameraId).gotoPreset(payload.presetToken); break;
      case 'ptz:absolute':await getController(cameraId).absoluteMove(payload.pan, payload.tilt, payload.zoom); break;
      case 'ptz:slew':    await slewToAzEl(payload.az, payload.el, cameraId); break;
      case 'mode:set':    setMode(payload.mode); break;
      case 'camera:select':
        trackingState.cameraId = cameraId;
        coordMapper.updatePosition(0, 0);
        broadcast({ type: 'tracking', state: trackingState });
        break;
      case 'patrol:config':
        patrol.setPresets(payload.presets, cameraId);
        break;
      case 'nuro:command':
        nuro.handleNuroCommand(payload);
        break;
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/cameras', (req, res) => res.json(getCameras()));

app.post('/api/cameras', (req, res) => {
  const { name, protocol = 'onvif', host, port = 80, username = 'admin', password, stream_url, snapshot_url } = req.body;
  const r = db.prepare(
    'INSERT INTO cameras (name,protocol,host,port,username,password,stream_url,snapshot_url) VALUES (?,?,?,?,?,?,?,?)'
  ).run(name, protocol, host, port, username, password, stream_url, snapshot_url);
  const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(r.lastInsertRowid);
  if (cam.stream_url && hls) hls.start(cam);
  res.json(cam);
});

app.delete('/api/cameras/:id', (req, res) => {
  db.prepare('UPDATE cameras SET active = 0 WHERE id = ?').run(req.params.id);
  const id = parseInt(req.params.id);
  controllers.delete(id);
  hls?.stop(id);
  res.json({ ok: true });
});

app.get('/api/cameras/:id/snapshot', async (req, res) => {
  try {
    const data = await getController(parseInt(req.params.id)).snapshot();
    res.set('Content-Type', 'image/jpeg').send(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cameras/:id/status', async (req, res) => {
  try { res.json(await getController(parseInt(req.params.id)).getStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cameras/:id/ptz/move', async (req, res) => {
  try { await getController(parseInt(req.params.id)).continuousMove(req.body.pan||0, req.body.tilt||0, req.body.zoom||0); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cameras/:id/ptz/stop', async (req, res) => {
  try { await getController(parseInt(req.params.id)).stop(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cameras/:id/ptz/absolute', async (req, res) => {
  try { await getController(parseInt(req.params.id)).absoluteMove(req.body.pan, req.body.tilt, req.body.zoom); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cameras/:id/ptz/slew', async (req, res) => {
  try { await slewToAzEl(req.body.az, req.body.el, parseInt(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cameras/:id/presets', async (req, res) => {
  try { res.json(await getController(parseInt(req.params.id)).getPresets()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cameras/:id/presets/:token/goto', async (req, res) => {
  try { await getController(parseInt(req.params.id)).gotoPreset(req.params.token); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/patrol',        (req, res) => res.json(patrol.getState()));
app.post('/api/patrol/start', (req, res) => { patrol.resume(0); res.json({ ok: true }); });
app.post('/api/patrol/stop',  (req, res) => { patrol.pause();   res.json({ ok: true }); });
app.put('/api/patrol/presets',(req, res) => { patrol.setPresets(req.body.presets); res.json({ ok: true }); });

app.get('/api/tracking', (req, res) => res.json(trackingState));
app.get('/api/events',   (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit));
});

app.get('/api/adsb',     (req, res) => res.json(adsbSource?.getAircraft() || []));
app.get('/api/weather',  (req, res) => res.json(weather?.current || null));
app.get('/api/fusion',   (req, res) => res.json(fusion.getActiveFusions()));
app.get('/api/config',   (req, res) => res.json({ profile: process.env.RAPTOR_PROFILE || 'single', ...cfg }));

// Export routes
app.use('/api/export', createExportRouter(db));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/dist/index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`🦅 RAPTOR [${process.env.RAPTOR_PROFILE || 'single'}] → http://localhost:${PORT}`);
  console.log(`   Detection:  ${cfg.detection?.enabled ? 'ON' : 'OFF'} | Tracking: ${cfg.tracking?.enabled ? 'ON' : 'OFF'}`);
  console.log(`   ADS-B:      ${cfg.sensors?.adsb ? 'ON' : 'OFF'} | Weather: ${cfg.sensors?.weather ? 'ON' : 'OFF'}`);
  console.log(`   Dual-cam:   ${cfg.tracking?.dualCamera ? 'ON' : 'OFF'} | Auto-zoom: ${cfg.tracking?.autoZoom ? 'ON' : 'OFF'}`);
  console.log(`   SKYTRACK:   ${process.env.SKYTRACK_WS_URL ? process.env.SKYTRACK_WS_URL : 'OFF'}`);
  console.log(`   Prism:      ${process.env.PRISM_URL ? process.env.PRISM_URL : 'OFF'}`);
  console.log(`   Nuro:       ${process.env.NURO_WEBHOOK_URL ? 'ON' : 'OFF'}`);
  console.log(`   HLS:        ${hls ? STREAMS_DIR : 'OFF'}`);
});

module.exports = { app, broadcast };
