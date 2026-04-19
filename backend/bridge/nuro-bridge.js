/**
 * Nuro Bridge
 * ============
 * Sends high-priority RAPTOR detection events to Nuro as alert events.
 * Bidirectional: Nuro can also command RAPTOR to slew to a bearing.
 *
 * Outbound: POST /api/alerts on CRITICAL or HIGH detections
 * Inbound:  Nuro sends { type: 'raptor:slew', az, el, cameraId } commands
 */
const axios       = require('axios');
const EventEmitter = require('events');

class NuroBridge extends EventEmitter {
  constructor({ webhookUrl, listenForCommands = true } = {}) {
    super();
    this.webhookUrl = webhookUrl;
    this._enabled   = !!webhookUrl;
  }

  /**
   * Send an alert to Nuro. Only fires for HIGH and CRITICAL alerts.
   */
  async sendAlert(fusionEvent) {
    if (!this._enabled) return;
    const level = fusionEvent.alert_level;
    if (level !== 'HIGH' && level !== 'CRITICAL') return;

    const v = fusionEvent.visual;
    const payload = {
      source:   'RAPTOR',
      type:     'aerial_contact',
      severity: level,
      title:    `RAPTOR: ${v?.class ?? 'Unknown'} aerial contact (${level})`,
      body:     `Track #${fusionEvent.track_id} · az ${v?.az ?? '?'}° el ${v?.el ?? '?'}° · ${v?.adsb_corroborated ? 'ADS-B corroborated' : 'UNIDENTIFIED'}`,
      data:     fusionEvent,
      ts:       Date.now(),
    };

    try {
      await axios.post(this.webhookUrl, payload, { timeout: 4000 });
      this.emit('alert_sent', payload);
    } catch (err) {
      console.warn('[Nuro] Alert failed:', err.message);
    }
  }

  /**
   * Handle an inbound command from Nuro.
   * Call this when a Nuro command WebSocket message arrives.
   * Returns a RAPTOR action object if actionable, otherwise null.
   */
  handleNuroCommand(msg) {
    if (!msg || msg.source !== 'NURO') return null;

    switch (msg.type) {
      case 'raptor:slew':
        // Nuro wants RAPTOR to look at a specific bearing
        this.emit('command:slew', { az: msg.az, el: msg.el, cameraId: msg.cameraId });
        return { action: 'slew', az: msg.az, el: msg.el, cameraId: msg.cameraId };

      case 'raptor:patrol':
        this.emit('command:patrol', { action: msg.action }); // start/stop
        return { action: 'patrol', state: msg.action };

      case 'raptor:mode':
        this.emit('command:mode', { mode: msg.mode });
        return { action: 'mode', mode: msg.mode };

      default:
        return null;
    }
  }
}

module.exports = NuroBridge;
