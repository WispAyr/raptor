/**
 * Weather Service
 * ================
 * Fetches local weather conditions from Open-Meteo (no API key required).
 * Updates on a configurable interval and provides false-positive risk factors
 * for the sensor fusion engine.
 *
 * Open-Meteo docs: https://open-meteo.com/en/docs
 */
const axios = require('axios');
const EventEmitter = require('events');

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class WeatherService extends EventEmitter {
  constructor({ lat, lon, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super();
    this.lat        = lat;
    this.lon        = lon;
    this.intervalMs = intervalMs;
    this._data      = null;
    this._timer     = null;
  }

  async start() {
    if (!this.lat || !this.lon) {
      console.log('[Weather] No station coordinates — weather disabled');
      return;
    }
    await this._fetch();
    this._timer = setInterval(() => this._fetch(), this.intervalMs);
    console.log(`[Weather] Started — lat: ${this.lat}, lon: ${this.lon}`);
  }

  stop() { clearInterval(this._timer); }

  get current() { return this._data; }

  async _fetch() {
    try {
      const { data } = await axios.get(OPEN_METEO_URL, {
        params: {
          latitude:   this.lat,
          longitude:  this.lon,
          current_weather: true,
          hourly: 'visibility,cloudcover,precipitation',
          forecast_days: 1,
          timezone: 'auto',
        },
        timeout: 8000,
      });

      const cw = data.current_weather || {};
      // Get current hour's visibility and cloud cover
      const hourIdx = new Date().getHours();
      const hourly  = data.hourly || {};

      this._data = {
        temperature_c:  cw.temperature,
        windspeed:       cw.windspeed,       // km/h
        winddirection:   cw.winddirection,   // degrees
        weathercode:     cw.weathercode,
        visibility_m:    hourly.visibility?.[hourIdx],
        cloudcover_pct:  hourly.cloudcover?.[hourIdx],
        precipitation_mm:hourly.precipitation?.[hourIdx],
        is_daytime:      cw.is_day === 1,
        fp_risk:         this._fpRisk(cw, hourly, hourIdx),
        fetched_at:      new Date().toISOString(),
      };

      this.emit('update', this._data);
    } catch (err) {
      console.warn('[Weather] Fetch failed:', err.message);
    }
  }

  /** Estimate false-positive risk from weather: 0=low, 1=high. */
  _fpRisk(cw, hourly, hourIdx) {
    let risk = 0;
    if ((cw.windspeed || 0) > 40)                            risk += 0.3;
    if ((hourly.precipitation?.[hourIdx] || 0) > 0.5)        risk += 0.3;
    if ((hourly.visibility?.[hourIdx] || 10000) < 2000)      risk += 0.2;
    if ((hourly.cloudcover?.[hourIdx] || 0) > 80)            risk += 0.1;
    return Math.min(1, parseFloat(risk.toFixed(2)));
  }
}

module.exports = WeatherService;
