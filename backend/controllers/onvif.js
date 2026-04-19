/**
 * ONVIF PTZ Controller
 * Uses the `onvif` npm package (agsh/onvif) for ONVIF Profile S compliant cameras.
 * Provides a unified interface matching VAPIXController.
 */
const { Cam } = require('onvif');

class ONVIFController {
  constructor({ host, port, username, password }) {
    this.config = { host, port, username, password };
    this.cam = null;
    this.profileToken = null;
    this._connecting = null;
  }

  async connect() {
    if (this.cam) return this.cam;
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      this.cam = new Cam(
        {
          hostname: this.config.host,
          port: this.config.port,
          username: this.config.username,
          password: this.config.password,
          timeout: 10000,
        },
        (err) => {
          if (err) {
            this.cam = null;
            this._connecting = null;
            return reject(new Error(`ONVIF connect failed: ${err.message}`));
          }
          // Use first profile with PTZ support
          const profiles = this.cam.profile ? [this.cam.profile] : this.cam.profiles || [];
          const ptzProfile = profiles.find(p => p.PTZConfiguration) || profiles[0];
          this.profileToken = ptzProfile?.$.token || null;
          this._connecting = null;
          resolve(this.cam);
        }
      );
    });

    return this._connecting;
  }

  async continuousMove(pan, tilt, zoom) {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.continuousMove(
        {
          profileToken: this.profileToken,
          velocity: {
            x: Math.max(-1, Math.min(1, pan)),
            y: Math.max(-1, Math.min(1, tilt)),
            zoom: Math.max(-1, Math.min(1, zoom)),
          },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async absoluteMove(pan, tilt, zoom = 0) {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.absoluteMove(
        {
          profileToken: this.profileToken,
          position: { x: pan, y: tilt, zoom },
          speed: { x: 0.5, y: 0.5, zoom: 0.5 },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async relativeMove(pan, tilt, zoom = 0) {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.relativeMove(
        {
          profileToken: this.profileToken,
          translation: { x: pan, y: tilt, zoom },
          speed: { x: 0.5, y: 0.5 },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async stop(pan = true, tilt = true) {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.stop(
        { profileToken: this.profileToken, panTilt: pan, zoom: false },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async getPresets() {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.getPresets({ profileToken: this.profileToken }, (err, presets) => {
        if (err) return reject(err);
        const list = Array.isArray(presets) ? presets : Object.values(presets || {});
        resolve(list.map(p => ({ token: p.$.token, name: p.Name || p.$.token })));
      });
    });
  }

  async gotoPreset(presetToken) {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.gotoPreset(
        { profileToken: this.profileToken, presetToken, speed: { x: 0.8, y: 0.8 } },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async getStatus() {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.getStatus({ profileToken: this.profileToken }, (err, status) => {
        if (err) return reject(err);
        resolve({
          pan: status?.PTZStatus?.Position?.PanTilt?.$?.x,
          tilt: status?.PTZStatus?.Position?.PanTilt?.$?.y,
          zoom: status?.PTZStatus?.Position?.Zoom?.$?.x,
          moveStatus: status?.PTZStatus?.MoveStatus,
        });
      });
    });
  }

  async snapshot() {
    const cam = await this.connect();
    return new Promise((resolve, reject) => {
      cam.getSnapshotUri({ profileToken: this.profileToken }, (err, res) => {
        if (err) return reject(err);
        const uri = res?.MediaUri?.Uri || res;
        const axios = require('axios');
        axios.get(uri, {
          responseType: 'arraybuffer',
          auth: { username: this.config.username, password: this.config.password },
        })
          .then(r => resolve(Buffer.from(r.data)))
          .catch(reject);
      });
    });
  }
}

module.exports = ONVIFController;
