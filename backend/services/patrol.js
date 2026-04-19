/**
 * Patrol Manager
 * Cycles a PTZ camera through a list of presets with configurable dwell times.
 * Pauses automatically when a detection event fires, resumes after a timeout.
 * Mirrors the UFODAP "Touring" feature.
 */
const EventEmitter = require('events');

class PatrolManager extends EventEmitter {
  constructor({ db, getController, broadcast }) {
    super();
    this.db = db;
    this.getController = getController;
    this.broadcast = broadcast;

    this.presets = [];        // [{ cameraId, token, name, dwell_ms }]
    this.currentIndex = 0;
    this.state = 'idle';      // 'idle' | 'patrolling' | 'paused' | 'dwelling'
    this.cameraId = null;
    this._dwellTimer = null;
    this._resumeTimer = null;
  }

  setPresets(presets, cameraId) {
    this.presets = presets;
    this.cameraId = cameraId || this.cameraId;
    this.currentIndex = 0;
  }

  getState() {
    return {
      state: this.state,
      currentIndex: this.currentIndex,
      presets: this.presets,
      cameraId: this.cameraId,
    };
  }

  async resume(delayMs = 0) {
    clearTimeout(this._resumeTimer);
    if (delayMs > 0) {
      this._resumeTimer = setTimeout(() => this._startPatrol(), delayMs);
    } else {
      this._startPatrol();
    }
  }

  pause() {
    clearTimeout(this._dwellTimer);
    clearTimeout(this._resumeTimer);
    if (this.state !== 'idle' && this.state !== 'paused') {
      this.state = 'paused';
      this.broadcast({ type: 'patrol', state: this.getState() });
    }
  }

  _startPatrol() {
    if (this.presets.length === 0 || !this.cameraId) {
      this.state = 'idle';
      return;
    }
    this.state = 'patrolling';
    this.broadcast({ type: 'patrol', state: this.getState() });
    this._moveToNext();
  }

  async _moveToNext() {
    if (this.state === 'paused' || this.state === 'idle') return;
    if (this.presets.length === 0) return;

    const preset = this.presets[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.presets.length;

    this.state = 'dwelling';
    this.broadcast({ type: 'patrol', state: this.getState() });

    try {
      const ctrl = this.getController(preset.cameraId || this.cameraId);
      await ctrl.gotoPreset(preset.token);
    } catch (err) {
      console.error('[Patrol] gotoPreset failed:', err.message);
    }

    const dwell = preset.dwell_ms || 5000;
    this._dwellTimer = setTimeout(() => this._moveToNext(), dwell);
  }

  stop() {
    this.pause();
    this.state = 'idle';
    this.broadcast({ type: 'patrol', state: this.getState() });
  }
}

module.exports = PatrolManager;
