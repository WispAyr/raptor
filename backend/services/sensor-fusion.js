/**
 * Sensor Fusion Service
 * ======================
 * Aggregates events from visual detection, ADS-B, weather, GPS, and
 * (if available) SDR/magnetometer into correlated "fusion events".
 *
 * Time-window correlation: if multiple sensor types fire within FUSION_WINDOW_MS,
 * they are grouped into a single fusion event with an elevated alert level.
 *
 * Alert levels:
 *   LOW    — single sensor, high confidence
 *   MEDIUM — two correlated sensors OR anomalous trajectory
 *   HIGH   — three+ sensors OR optical+RF correlation
 *   CRITICAL — unknown class + optical + RF within 500ms
 */
const EventEmitter = require('events');

const FUSION_WINDOW_MS = 1000;  // Time window for correlation

const ALERT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

class SensorFusionService extends EventEmitter {
  constructor({ broadcast } = {}) {
    super();
    this.broadcast = broadcast || (() => {});
    this._pending  = new Map();  // correlationKey → fusionEvent
    this._weather  = null;
    this._position = null;       // Current GPS fix
  }

  /** Update weather cache (called periodically from weather service). */
  setWeather(data) { this._weather = data; }

  /** Update GPS position. */
  setPosition({ lat, lon, alt }) { this._position = { lat, lon, alt }; }

  /**
   * Primary entry point: called when a detection event arrives from ZMQ bridge.
   * May be enriched with ADS-B before calling this.
   */
  onDetection(event) {
    const fev = this._getOrCreate(event.track_id);

    fev.visual = {
      class: event.class,
      confidence: event.confidence,
      centroid_x: event.centroid_x,
      centroid_y: event.centroid_y,
      az: event.az,
      el: event.el,
      velocity_px: event.velocity_px,
      anomaly_flag: event.anomaly_flag,
      trajectory_score: event.trajectory_score,
      adsb_corroborated: event.adsb_corroborated || false,
      adsb: event.adsb || null,
    };
    fev.ts_visual = Date.now();

    this._score(fev);
    this._emit(fev);
  }

  /** Called when SDR RF anomaly is detected. */
  onRFAnomaly({ frequency_mhz, power_db, bandwidth_mhz }) {
    // Correlate with any active visual tracks
    for (const [, fev] of this._pending) {
      if (Date.now() - fev.ts_visual < FUSION_WINDOW_MS) {
        fev.rf = { frequency_mhz, power_db, bandwidth_mhz };
        fev.ts_rf = Date.now();
        this._score(fev);
        this._emit(fev);
      }
    }
  }

  /** Called when a magnetic anomaly is detected. */
  onMagneticAnomaly({ x, y, z, delta }) {
    for (const [, fev] of this._pending) {
      if (Date.now() - fev.ts_visual < FUSION_WINDOW_MS) {
        fev.magnetic = { x, y, z, delta };
        this._score(fev);
        this._emit(fev);
      }
    }
  }

  _getOrCreate(trackId) {
    if (!this._pending.has(trackId)) {
      this._pending.set(trackId, {
        track_id: trackId,
        visual: null,
        rf: null,
        magnetic: null,
        alert_level: 'LOW',
        score: 0,
        ts_visual: 0,
        ts_rf: 0,
        weather: this._weather,
        position: this._position,
        created_at: Date.now(),
      });
    }
    return this._pending.get(trackId);
  }

  _score(fev) {
    let score = 0;
    const v = fev.visual;

    if (!v) return;

    // Base score from visual confidence
    score += v.confidence * 2;

    // Unknown class bonus
    if (v.class === 'unknown' || v.class === 'uap_candidate') score += 3;

    // Anomalous trajectory
    if (v.anomaly_flag) score += 3;
    if (v.trajectory_score < 0.5) score += 2;

    // RF correlation
    if (fev.rf) score += 4;

    // Magnetic correlation
    if (fev.magnetic) score += 3;

    // ADS-B corroboration REDUCES score (it's a known aircraft)
    if (v.adsb_corroborated) score = Math.max(0, score - 8);

    // Weather penalty (high wind → more false positives)
    if (fev.weather?.windspeed > 30) score = Math.max(0, score - 1);

    fev.score = parseFloat(score.toFixed(2));

    // Map score to alert level
    if (score >= 10)      fev.alert_level = 'CRITICAL';
    else if (score >= 7)  fev.alert_level = 'HIGH';
    else if (score >= 4)  fev.alert_level = 'MEDIUM';
    else                  fev.alert_level = 'LOW';
  }

  _emit(fev) {
    const payload = { type: 'fusion', ...fev };
    this.broadcast(payload);
    this.emit('fusion', fev);
  }

  onTrackLost(trackId) {
    this._pending.delete(trackId);
  }

  getActiveFusions() {
    return Array.from(this._pending.values());
  }
}

module.exports = SensorFusionService;
