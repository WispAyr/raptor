/**
 * Axis VAPIX PTZ Controller
 * Uses the Axis VAPIX HTTP API (CGI). Supports Axis PTZ cameras with digest auth.
 * Provides the same interface as ONVIFController.
 */
const axios = require('axios');

class VAPIXController {
  constructor({ host, port = 80, username, password, snapshot_url }) {
    this.baseUrl = `http://${host}:${port}`;
    this.auth = { username, password };
    this.snapshotUrl = snapshot_url || `http://${host}:${port}/axis-cgi/jpg/image.cgi`;
  }

  async _get(path, params = {}) {
    const res = await axios.get(`${this.baseUrl}${path}`, {
      params,
      auth: this.auth,
      timeout: 8000,
    });
    return res.data;
  }

  /**
   * Continuous move using VAPIX PTZ move CGI.
   * pan/tilt/zoom: -1.0 to +1.0 normalised → mapped to VAPIX -100..100
   */
  async continuousMove(pan, tilt, zoom) {
    const rpan = Math.round(pan * 100);
    const rtilt = Math.round(tilt * 100);
    const rzoom = Math.round(zoom * 100);
    await this._get('/axis-cgi/com/ptz.cgi', {
      continuouspantiltmove: `${rpan},${rtilt}`,
      continuouszoommove: rzoom,
    });
  }

  /**
   * Absolute move using VAPIX PTZ position CGI.
   * pan: -180..180 degrees, tilt: -90..90, zoom: 1..9999
   */
  async absoluteMove(pan, tilt, zoom = 0) {
    await this._get('/axis-cgi/com/ptz.cgi', {
      pan: pan * 180,   // Normalise -1..1 → -180..180
      tilt: tilt * 90,  // Normalise -1..1 → -90..90
      zoom: zoom > 0 ? Math.round(zoom * 9999) : undefined,
    });
  }

  async relativeMove(pan, tilt, zoom = 0) {
    await this._get('/axis-cgi/com/ptz.cgi', {
      rpan: pan * 180,
      rtilt: tilt * 90,
      rzoom: zoom > 0 ? Math.round(zoom * 100) : undefined,
    });
  }

  async stop() {
    await this._get('/axis-cgi/com/ptz.cgi', {
      continuouspantiltmove: '0,0',
      continuouszoommove: 0,
    });
  }

  async getPresets() {
    const data = await this._get('/axis-cgi/com/ptz.cgi', { query: 'presetposall' });
    // Parse VAPIX response: "presetposno1=name1\npresetposno2=name2\n..."
    const presets = [];
    const lines = String(data).split('\n');
    for (const line of lines) {
      const match = line.match(/presetposno(\d+)=(.+)/);
      if (match) presets.push({ token: match[1], name: match[2].trim() });
    }
    return presets;
  }

  async gotoPreset(presetToken) {
    await this._get('/axis-cgi/com/ptz.cgi', { gotopresetpos: presetToken });
  }

  async getStatus() {
    const data = await this._get('/axis-cgi/com/ptz.cgi', { query: 'position' });
    const parse = (key) => {
      const m = String(data).match(new RegExp(`${key}=([\\d.-]+)`));
      return m ? parseFloat(m[1]) : null;
    };
    return {
      pan: parse('pan'),
      tilt: parse('tilt'),
      zoom: parse('zoom'),
    };
  }

  async snapshot() {
    const res = await axios.get(this.snapshotUrl, {
      responseType: 'arraybuffer',
      auth: this.auth,
      timeout: 8000,
    });
    return Buffer.from(res.data);
  }
}

module.exports = VAPIXController;
