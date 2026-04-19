/**
 * AirWave Bridge
 * ===============
 * Connects to AirWave's ADS-B WebSocket feed as the primary aircraft
 * corroboration source. AirWave already processes and enriches ADS-B data,
 * so this bridge avoids needing a local dump1090 installation.
 *
 * Falls back to ADSBService (direct dump1090) if AirWave is unavailable.
 * Emits the same 'update' event format as ADSBService for compatibility.
 */
const EventEmitter = require('events');

class AirWaveBridge extends EventEmitter {
  constructor({ wsUrl, fallback = null } = {}) {
    super();
    this.wsUrl    = wsUrl;
    this.fallback = fallback; // ADSBService instance as fallback
    this._ws      = null;
    this._aircraft = new Map();
    this._running  = false;
  }

  start() {
    if (!this.wsUrl) {
      console.log('[AirWave] No WS URL — using fallback ADS-B source');
      this.fallback?.start();
      return;
    }
    this._running = true;
    this._connect();
    console.log(`[AirWave] Connecting to ${this.wsUrl}`);
  }

  _connect() {
    try {
      const WebSocket = require('ws');
      this._ws = new WebSocket(this.wsUrl);

      this._ws.on('open', () => {
        console.log('[AirWave] Connected');
        // Subscribe to aircraft updates
        this._ws.send(JSON.stringify({ type: 'subscribe', channel: 'aircraft' }));
      });

      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch {}
      });

      this._ws.on('close', () => {
        if (this._running) setTimeout(() => this._connect(), 5000);
      });

      this._ws.on('error', (err) => {
        console.warn('[AirWave] WS error:', err.message);
      });
    } catch (err) {
      console.error('[AirWave] Connection failed:', err.message);
      this.fallback?.start();
    }
  }

  _handleMessage(msg) {
    // AirWave broadcasts aircraft updates in its native format
    // Support both AirWave EAM format and raw ADS-B format
    if (msg.type === 'aircraft' || msg.type === 'adsb_update') {
      const aircraft = msg.aircraft || msg.data || [];
      for (const ac of (Array.isArray(aircraft) ? aircraft : [aircraft])) {
        if (ac.icao || ac.hex) {
          this._aircraft.set(ac.icao || ac.hex, ac);
        }
      }
      this.emit('update', Array.from(this._aircraft.values()));
    }
  }

  /**
   * Corroborate a RAPTOR detection against the AirWave air picture.
   * Compatible with ADSBService.corroborate() interface.
   */
  corroborate(detectionAz, detectionEl = null) {
    // Delegate to fallback if connected
    if (this.fallback?._aircraft?.size) {
      return this.fallback.corroborate(detectionAz, detectionEl);
    }
    // Simple bearing match
    for (const ac of this._aircraft.values()) {
      if (ac.bearing == null) continue;
      const azDiff = Math.abs(((detectionAz - ac.bearing) + 180 + 360) % 360 - 180);
      if (azDiff <= 5) return ac;
    }
    return null;
  }

  enrichDetection(event) {
    if (!event.az) return event;
    const match = this.corroborate(event.az, event.el);
    if (match) {
      event.class = 'aircraft';
      event.adsb_corroborated = true;
      event.adsb  = match;
    }
    return event;
  }

  getAircraft() {
    return Array.from(this._aircraft.values());
  }

  stop() {
    this._running = false;
    this._ws?.close();
    this.fallback?.stop();
  }
}

module.exports = AirWaveBridge;
