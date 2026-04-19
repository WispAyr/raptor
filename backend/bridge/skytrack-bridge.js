/**
 * SKYTRACK Bridge
 * ================
 * Subscribes to SKYTRACK's DroneVoxelServer WebSocket and converts 3D voxel
 * positions (lat/lon/alt) into az/el commands for RAPTOR PTZ cameras.
 * SKYTRACK becomes RAPTOR's detection input — a fully integrated spotter/tracker pipeline.
 *
 * SKYTRACK WebSocket event schema (expected):
 * {
 *   type: 'detection' | 'track_update' | 'track_lost',
 *   track_id: string,
 *   lat: number, lon: number, alt: number,  // metres
 *   velocity: { x, y, z },
 *   class: string,
 *   confidence: number,
 *   ts: number
 * }
 */
const EventEmitter = require('events');
const CoordinateMapper = require('../controllers/coordinate-mapper');

class SKYTRACKBridge extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string}   opts.wsUrl           - SKYTRACK WebSocket URL
   * @param {Object}   opts.stationConfig   - { lat, lon, alt, hfov, vfov, homeAz }
   * @param {Function} opts.onDetection     - Callback with RAPTOR-format detection event
   * @param {Function} opts.onTrackLost     - Callback with track_id
   */
  constructor({ wsUrl, stationConfig, onDetection, onTrackLost } = {}) {
    super();
    this.wsUrl        = wsUrl;
    this.mapper       = new CoordinateMapper(stationConfig || { lat: 0, lon: 0, hfov: 60, vfov: 34 });
    this.onDetection  = onDetection || (() => {});
    this.onTrackLost  = onTrackLost || (() => {});
    this._ws          = null;
    this._reconnTimer = null;
    this._running     = false;
  }

  start() {
    if (!this.wsUrl) {
      console.log('[SKYTRACK] No WS URL configured — bridge inactive');
      return;
    }
    this._running = true;
    this._connect();
    console.log(`[SKYTRACK] Connecting to ${this.wsUrl}`);
  }

  _connect() {
    try {
      const WebSocket = require('ws');
      this._ws = new WebSocket(this.wsUrl);

      this._ws.on('open', () => {
        console.log('[SKYTRACK] Connected');
        this.emit('connected');
      });

      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) {
          console.error('[SKYTRACK] Parse error:', e.message);
        }
      });

      this._ws.on('close', () => {
        console.warn('[SKYTRACK] Disconnected — reconnecting in 5s');
        if (this._running) this._reconnTimer = setTimeout(() => this._connect(), 5000);
      });

      this._ws.on('error', (err) => {
        console.error('[SKYTRACK] WS error:', err.message);
      });
    } catch (err) {
      console.error('[SKYTRACK] Failed to connect:', err.message);
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'track_lost') {
      this.onTrackLost(msg.track_id);
      this.emit('track_lost', msg.track_id);
      return;
    }

    if (msg.type !== 'detection' && msg.type !== 'track_update') return;
    if (msg.lat == null || msg.lon == null) return;

    // Convert 3D lat/lon/alt → az/el relative to this station
    const dist = CoordinateMapper.haversine(this.mapper.lat, this.mapper.lon, msg.lat, msg.lon);
    const az   = CoordinateMapper.bearing(this.mapper.lat, this.mapper.lon, msg.lat, msg.lon);
    const el   = Math.atan2((msg.alt || 0) - this.mapper.alt, dist) * 180 / Math.PI;

    // Build RAPTOR-compatible detection event
    const raptorEvent = {
      track_id:    msg.track_id,
      class:       msg.class || 'unknown',
      confidence:  msg.confidence || 1.0,
      az:          parseFloat(az.toFixed(2)),
      el:          parseFloat(Math.max(0, el).toFixed(2)),
      bearing:     this.mapper._bearing(az),
      // Synthetic centroid (frame centre since we're getting real coordinates)
      centroid_x:  640,
      centroid_y:  360,
      frame_w:     1280,
      frame_h:     720,
      source:      'SKYTRACK',
      skytrack:    { lat: msg.lat, lon: msg.lon, alt: msg.alt, dist_m: Math.round(dist) },
      ts:          msg.ts || Date.now(),
    };

    this.onDetection(raptorEvent);
    this.emit('detection', raptorEvent);
  }

  stop() {
    this._running = false;
    clearTimeout(this._reconnTimer);
    this._ws?.close();
  }
}

module.exports = SKYTRACKBridge;
