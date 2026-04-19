/**
 * Export Routes
 * ==============
 * REST endpoints for exporting detection data in various formats.
 * Mounted at /api/export in server.js
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');

module.exports = function createExportRouter(db) {
  const router = express.Router();

  // ── CSV (UFODAP-compatible movement log) ────────────────────────────────────
  router.get('/csv', (req, res) => {
    const limit = parseInt(req.query.limit) || 5000;
    const since = req.query.since || '1970-01-01';

    const events = db.prepare(`
      SELECT e.*, c.name as camera_name, c.host as camera_host
      FROM events e
      LEFT JOIN cameras c ON c.id = e.camera_id
      WHERE e.created_at > ?
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(since, limit);

    const header = [
      'id', 'created_at', 'camera_id', 'camera_name', 'track_id', 'class',
      'confidence', 'centroid_x', 'centroid_y', 'az', 'el', 'bearing',
      'velocity_px', 'anomaly_flag', 'trajectory_score', 'alert_level',
      'adsb_corroborated', 'adsb_callsign', 'clip_path'
    ].join(',');

    const rows = events.map(e => [
      e.id, e.created_at, e.camera_id, e.camera_name || '', e.track_id,
      e.class, e.confidence, e.centroid_x, e.centroid_y,
      e.az ?? '', e.el ?? '', e.bearing ?? '',
      e.velocity_px ?? '', e.anomaly_flag ?? '', e.trajectory_score ?? '',
      e.alert_level ?? '', e.adsb_corroborated ?? '', e.adsb_callsign ?? '',
      e.clip_path ?? ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="raptor-events-${Date.now()}.csv"`);
    res.send([header, ...rows].join('\n'));
  });

  // ── GeoJSON (tracks as LineStrings) ─────────────────────────────────────────
  router.get('/geojson', (req, res) => {
    const events = db.prepare(`
      SELECT track_id, az, el, bearing, centroid_x, centroid_y, created_at, class, confidence
      FROM events
      WHERE az IS NOT NULL
      ORDER BY track_id, created_at
    `).all();

    // Group by track_id
    const tracks = {};
    for (const ev of events) {
      if (!tracks[ev.track_id]) tracks[ev.track_id] = { events: [], class: ev.class };
      tracks[ev.track_id].events.push(ev);
    }

    const features = Object.entries(tracks).map(([trackId, { events, class: cls }]) => ({
      type: 'Feature',
      properties: { track_id: trackId, class: cls, point_count: events.length },
      geometry: {
        type: 'LineString',
        // Use az/el as lon/lat proxy for mapping (proper projection needs range data)
        coordinates: events.map(e => [e.az, e.el, 0]),
      },
    }));

    res.json({ type: 'FeatureCollection', features });
  });

  // ── FITS-inspired JSON (astronomy-compatible metadata) ──────────────────────
  router.get('/fits/:eventId', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // FITS-style keyword-value structure
    const fits = {
      SIMPLE:   true,
      BITPIX:   8,
      NAXIS:    2,
      NAXIS1:   event.frame_w || 1280,
      NAXIS2:   event.frame_h || 720,
      DATE_OBS: event.created_at,
      OBJECT:   event.class?.toUpperCase() || 'UNKNOWN',
      TELESCOP: 'RAPTOR PTZ',
      INSTRUME: event.camera_protocol || 'ONVIF',
      CRVAL1:   event.az,       // Azimuth (proxy for RA)
      CRVAL2:   event.el,       // Elevation (proxy for Dec)
      EXPTIME:  (event.time_visible_ms || 0) / 1000,
      RAPTOR: {
        track_id:         event.track_id,
        confidence:       event.confidence,
        centroid_x:       event.centroid_x,
        centroid_y:       event.centroid_y,
        velocity_px:      event.velocity_px,
        anomaly_flag:     event.anomaly_flag,
        trajectory_score: event.trajectory_score,
        alert_level:      event.alert_level,
        adsb_callsign:    event.adsb_callsign,
      },
    };

    res.setHeader('Content-Disposition', `attachment; filename="raptor-event-${event.id}.json"`);
    res.json(fits);
  });

  // ── HTML Event Report ────────────────────────────────────────────────────────
  router.get('/report/:eventId', (req, res) => {
    const event = db.prepare('SELECT e.*, c.name as camera_name FROM events e LEFT JOIN cameras c ON c.id = e.camera_id WHERE e.id = ?').get(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const alertColour = {
      CRITICAL: '#ff3b5c', HIGH: '#e8531a', MEDIUM: '#f5a623', LOW: '#2adc8c'
    }[event.alert_level] || '#8892a4';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>RAPTOR Detection Report — Event #${event.id}</title>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; background: #050608; color: #f0f2f5; margin: 0; padding: 32px; }
    .header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 16px; }
    .logo { font-size: 28px; }
    h1 { font-size: 20px; margin: 0; }
    .badge { padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 700; background: ${alertColour}22; color: ${alertColour}; border: 1px solid ${alertColour}44; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .card { background: #10141c; border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 16px; }
    .card h3 { margin: 0 0 12px; font-size: 12px; color: #8892a4; text-transform: uppercase; letter-spacing: 0.08em; }
    .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
    .row:last-child { border-bottom: none; }
    .val { color: #e8531a; font-family: monospace; }
    .clip { margin-top: 16px; }
    video { width: 100%; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🦅</div>
    <div>
      <h1>RAPTOR Detection Report — Event #${event.id}</h1>
      <div style="font-size:12px;color:#8892a4;margin-top:4px">${event.created_at}</div>
    </div>
    <div class="badge" style="margin-left:auto">${event.alert_level || 'LOW'}</div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Classification</h3>
      <div class="row"><span>Class</span><span class="val">${event.class}</span></div>
      <div class="row"><span>Confidence</span><span class="val">${((event.confidence || 0) * 100).toFixed(1)}%</span></div>
      <div class="row"><span>Track ID</span><span class="val">#${event.track_id}</span></div>
      <div class="row"><span>Alert Level</span><span class="val" style="color:${alertColour}">${event.alert_level || 'LOW'}</span></div>
      ${event.adsb_callsign ? `<div class="row"><span>ADS-B Match</span><span class="val">${event.adsb_callsign}</span></div>` : ''}
    </div>
    <div class="card">
      <h3>Position</h3>
      <div class="row"><span>Azimuth</span><span class="val">${event.az ?? '—'}°</span></div>
      <div class="row"><span>Elevation</span><span class="val">${event.el ?? '—'}°</span></div>
      <div class="row"><span>Bearing</span><span class="val">${event.bearing ?? '—'}</span></div>
      <div class="row"><span>Centroid</span><span class="val">${event.centroid_x}, ${event.centroid_y}</span></div>
    </div>
    <div class="card">
      <h3>Kinematics</h3>
      <div class="row"><span>Velocity</span><span class="val">${event.velocity_px ?? '—'} px/f</span></div>
      <div class="row"><span>Anomaly Flag</span><span class="val">${event.anomaly_flag ? '⚠ YES' : 'No'}</span></div>
      <div class="row"><span>Trajectory Score</span><span class="val">${event.trajectory_score ?? '—'}</span></div>
      <div class="row"><span>Duration</span><span class="val">${event.time_visible_ms ? (event.time_visible_ms / 1000).toFixed(1) + 's' : '—'}</span></div>
    </div>
    <div class="card">
      <h3>Camera</h3>
      <div class="row"><span>Camera</span><span class="val">${event.camera_name || event.camera_id}</span></div>
    </div>
  </div>

  ${event.clip_path ? `<div class="clip card"><h3>Recorded Clip</h3><video controls src="${event.clip_path}"></video></div>` : ''}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // ── Event list JSON ──────────────────────────────────────────────────────────
  router.get('/events', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const cls   = req.query.class;
    const level = req.query.alert_level;

    let query = 'SELECT * FROM events';
    const params = [];
    const where = [];
    if (cls)   { where.push('class = ?');        params.push(cls); }
    if (level) { where.push('alert_level = ?');  params.push(level); }
    if (where.length) query += ' WHERE ' + where.join(' AND ');
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    res.json(db.prepare(query).all(...params));
  });

  return router;
};
