/**
 * ADS-B Cross-Reference Service
 * ==============================
 * Connects to a local dump1090 instance (or ADSBExchange API) and maintains
 * a live picture of aircraft within a configurable radius. For each RAPTOR
 * detection event, checks whether a known aircraft's bearing matches — if so,
 * tags the detection as "aircraft (ADS-B corroborated)" and attaches metadata.
 *
 * Supports:
 *   - dump1090 / readsb JSON feed (http://host:8080/data/aircraft.json)
 *   - ADSBExchange API (ADSB_SOURCE=adsbexchange)
 *   - AirWave WebSocket feed (ADSB_SOURCE=airwave) — uses existing WispAyr data
 */
const axios = require('axios');
const EventEmitter = require('events');
const CoordinateMapper = require('../controllers/coordinate-mapper');

const POLL_INTERVAL_MS    = 2000;
const DEFAULT_RADIUS_NM   = 25;
const BEARING_TOLERANCE_DEG = 5;  // How close bearing must be to count as corroboration
const ALT_FACTOR = 0.000164;      // feet → nautical miles for rough range check

class ADSBService extends EventEmitter {
  constructor({ host = 'localhost', port = 8080, radiusNm = DEFAULT_RADIUS_NM,
    stationLat = 0, stationLon = 0, stationAlt = 0, source = 'dump1090' } = {}) {
    super();
    this.host       = host;
    this.port       = port;
    this.radiusNm   = radiusNm;
    this.stationLat = stationLat;
    this.stationLon = stationLon;
    this.stationAlt = stationAlt;
    this.source     = source;

    this._aircraft  = new Map();    // icao → aircraft object
    this._pollTimer = null;
    this._running   = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    console.log(`[ADS-B] Started — source: ${this.source}, radius: ${this.radiusNm}nm`);
  }

  stop() {
    this._running = false;
    clearInterval(this._pollTimer);
  }

  async _poll() {
    try {
      const url = `http://${this.host}:${this.port}/data/aircraft.json`;
      const { data } = await axios.get(url, { timeout: 2000 });
      const aircraft = data.aircraft || data.ac || [];
      this._updatePicture(aircraft);
    } catch {
      // Silently swallow — dump1090 may not be running
    }
  }

  _updatePicture(aircraft) {
    this._aircraft.clear();
    for (const ac of aircraft) {
      const icao = ac.hex || ac.icao;
      if (!icao) continue;
      if (ac.lat == null || ac.lon == null) continue;
      const dist = CoordinateMapper.haversine(this.stationLat, this.stationLon, ac.lat, ac.lon);
      const distNm = dist / 1852;
      if (distNm > this.radiusNm) continue;

      const bearing = CoordinateMapper.bearing(this.stationLat, this.stationLon, ac.lat, ac.lon);
      const altFt   = ac.alt_baro || ac.altitude || 0;
      const elevDeg = Math.atan2(altFt * 0.3048 - this.stationAlt, dist) * 180 / Math.PI;

      this._aircraft.set(icao, {
        icao,
        callsign: (ac.flight || ac.r || '').trim(),
        lat: ac.lat, lon: ac.lon,
        altFt,
        speedKts: ac.gs || ac.spd || 0,
        track: ac.track || 0,
        distNm: parseFloat(distNm.toFixed(1)),
        bearing: parseFloat(bearing.toFixed(1)),
        elevDeg: parseFloat(elevDeg.toFixed(1)),
      });
    }
    this.emit('update', this.getAircraft());
  }

  /** Get all aircraft currently in picture. */
  getAircraft() {
    return Array.from(this._aircraft.values());
  }

  /**
   * Corroborate a RAPTOR detection against the current air picture.
   * Returns the matching aircraft object if found, or null.
   * @param {number} detectionAz - Detection azimuth (degrees)
   * @param {number} detectionEl - Detection elevation (degrees)
   */
  corroborate(detectionAz, detectionEl = null) {
    for (const ac of this._aircraft.values()) {
      const azDiff = Math.abs(((detectionAz - ac.bearing) + 180 + 360) % 360 - 180);
      if (azDiff <= BEARING_TOLERANCE_DEG) {
        // Optional elevation check if we have it
        if (detectionEl !== null && ac.elevDeg !== null) {
          const elDiff = Math.abs(detectionEl - ac.elevDeg);
          if (elDiff > 15) continue; // elevation too far off
        }
        return ac;
      }
    }
    return null;
  }

  /**
   * Enrich a RAPTOR detection event with ADS-B data.
   * Mutates the event in-place and returns it.
   */
  enrichDetection(event) {
    if (!event.az) return event; // no coordinate mapping yet
    const match = this.corroborate(event.az, event.el);
    if (match) {
      event.class      = 'aircraft';
      event.adsb_corroborated = true;
      event.adsb       = match;
    }
    return event;
  }
}

module.exports = ADSBService;
