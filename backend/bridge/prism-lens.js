/**
 * Prism Intelligence Lens
 * ========================
 * Formats RAPTOR detection events as Prism sensor inputs and POSTs them
 * to the Prism intelligence hub for SITREP generation.
 *
 * RAPTOR events appear in Prism SITREPs as:
 *   "Aerial contact detected at az 047.3° el 23.1° — class: unknown,
 *    confidence: 87%, duration: 12s, anomaly flag: true [RAPTOR]"
 *
 * Schema follows WispAyr Prism sensor_input format.
 */
const axios = require('axios');
const EventEmitter = require('events');

class PrismLens extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.prismUrl         - Prism hub base URL
   * @param {string} [opts.stationId]      - This station's ID
   * @param {number} [opts.minAlertLevel]  - Minimum alert level to forward: 0=LOW,1=MED,2=HIGH,3=CRIT
   */
  constructor({ prismUrl, stationId = 'raptor-1', minAlertLevel = 1 } = {}) {
    super();
    this.prismUrl      = prismUrl;
    this.stationId     = stationId;
    this.minAlertLevel = minAlertLevel;
    this._enabled      = !!prismUrl;
  }

  _levelIndex(level) {
    return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(level);
  }

  /**
   * Send a RAPTOR fusion event to Prism as a sensor input.
   */
  async send(fusionEvent) {
    if (!this._enabled) return;
    if (this._levelIndex(fusionEvent.alert_level) < this.minAlertLevel) return;

    const v = fusionEvent.visual;
    if (!v) return;

    const payload = {
      source:     'RAPTOR',
      station_id: this.stationId,
      type:       'aerial_contact',
      severity:   fusionEvent.alert_level,
      data: {
        track_id:         fusionEvent.track_id,
        class:            v.class,
        confidence:       v.confidence,
        az:               v.az,
        el:               v.el,
        bearing:          v.bearing,
        velocity_px:      v.velocity_px,
        anomaly_flag:     v.anomaly_flag,
        trajectory_score: v.trajectory_score,
        adsb_corroborated:v.adsb_corroborated,
        adsb_callsign:    v.adsb?.callsign,
        fusion_score:     fusionEvent.score,
        rf_detected:      !!fusionEvent.rf,
        magnetic_anomaly: !!fusionEvent.magnetic,
        weather:          fusionEvent.weather,
      },
      summary: this._buildSummary(fusionEvent, v),
      ts: Date.now(),
    };

    try {
      await axios.post(`${this.prismUrl}/api/sensor-inputs`, payload, { timeout: 5000 });
      this.emit('sent', payload);
    } catch (err) {
      console.warn('[Prism] Failed to send event:', err.message);
    }
  }

  _buildSummary(fev, v) {
    const parts = [
      `Aerial contact at az ${v.az ?? '?'}° el ${v.el ?? '?'}°`,
      `class: ${v.class}`,
      `confidence: ${Math.round((v.confidence || 0) * 100)}%`,
    ];
    if (v.anomaly_flag) parts.push('⚠ anomalous trajectory');
    if (v.adsb_corroborated) parts.push(`ADS-B: ${v.adsb?.callsign || 'corroborated'}`);
    if (fev.rf) parts.push('RF anomaly correlated');
    parts.push(`[RAPTOR/${fev.track_id}]`);
    return parts.join(' · ');
  }
}

module.exports = PrismLens;
