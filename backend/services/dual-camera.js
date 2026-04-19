/**
 * Dual-Camera Service
 * Implements the Sky360 / UFODAP "spotter + tracker" hand-off architecture:
 *
 *   Wide-field (spotter) camera → detects blob → calculates az/el bearing
 *     → commands PTZ (tracker) camera to slew to that bearing
 *       → PTZ acquires target → PID closed-loop tracking begins
 *
 * The wide-field camera can be any IP camera with an RTSP feed (fisheye or wide-angle).
 * The tracker camera must be a PTZ camera (ONVIF, VAPIX, or VISCA).
 */
const EventEmitter = require('events');
const CoordinateMapper = require('../controllers/coordinate-mapper');

class DualCameraService extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.spotterConfig     - Spotter camera config { lat, lon, alt, hfov, vfov, homeAz }
   * @param {number} options.trackerCameraId   - ID of the PTZ tracking camera in DB
   * @param {Function} options.getController   - Function to get a camera controller by ID
   * @param {Function} options.broadcast       - WebSocket broadcast function
   * @param {number} [options.acquireTimeoutMs=8000] - Time to attempt acquisition before giving up
   * @param {number} [options.handoffCooldownMs=3000] - Min time between hand-offs
   */
  constructor({ spotterConfig, trackerCameraId, getController, broadcast, acquireTimeoutMs = 8000, handoffCooldownMs = 3000 }) {
    super();
    this.spotterMapper   = new CoordinateMapper(spotterConfig);
    this.trackerCameraId = trackerCameraId;
    this.getController   = getController;
    this.broadcast       = broadcast;
    this.acquireTimeoutMs   = acquireTimeoutMs;
    this.handoffCooldownMs  = handoffCooldownMs;

    this.state = 'idle'; // 'idle' | 'slewing' | 'acquiring' | 'tracking'
    this._lastHandoff = 0;
    this._acquireTimer = null;
  }

  /**
   * Called when the spotter camera detects a new track.
   * @param {Object} event - Detection event from ZMQ bridge
   */
  async onSpotterDetection(event) {
    const now = Date.now();

    // Throttle hand-offs
    if (now - this._lastHandoff < this.handoffCooldownMs) return;
    if (this.state === 'tracking') return; // already tracking, let PTZ PID handle it

    const { centroid_x, centroid_y, frame_w, frame_h, track_id, class: cls, confidence } = event;

    // Calculate az/el from spotter camera
    const { az, el, bearing } = this.spotterMapper.pixelToAzEl(centroid_x, centroid_y, frame_w, frame_h);

    this.broadcast({
      type: 'handoff',
      phase: 'detected',
      track_id,
      class: cls,
      confidence,
      az, el, bearing,
      source: 'spotter',
    });

    await this._slewTrackerTo(az, el, track_id);
  }

  async _slewTrackerTo(az, el, trackId) {
    this.state = 'slewing';
    this._lastHandoff = Date.now();

    try {
      const ctrl = this.getController(this.trackerCameraId);

      // Calculate pan/tilt move needed
      // Assumes tracker camera mapper has same home position; in production, use tracker's own mapper
      const { pan, tilt } = this.spotterMapper.azElToMove(az, el);

      this.broadcast({ type: 'handoff', phase: 'slewing', az, el, pan, tilt });

      await ctrl.absoluteMove(pan, tilt, 0);

      this.state = 'acquiring';
      this.broadcast({ type: 'handoff', phase: 'acquiring', track_id: trackId });

      // Give camera time to slew and acquire
      clearTimeout(this._acquireTimer);
      this._acquireTimer = setTimeout(() => {
        if (this.state === 'acquiring') {
          this.state = 'idle';
          this.broadcast({ type: 'handoff', phase: 'failed', reason: 'acquisition_timeout' });
        }
      }, this.acquireTimeoutMs);

      this.emit('slewed', { az, el, trackId });

    } catch (err) {
      this.state = 'idle';
      this.broadcast({ type: 'handoff', phase: 'error', error: err.message });
      console.error('[DualCamera] Slew failed:', err.message);
    }
  }

  /** Called when the PTZ tracking camera confirms it has acquired the target. */
  onTrackerAcquired(trackId) {
    clearTimeout(this._acquireTimer);
    this.state = 'tracking';
    this.broadcast({ type: 'handoff', phase: 'tracking', track_id: trackId });
    this.emit('acquired', trackId);
  }

  /** Called when the PTZ tracking camera loses the target. */
  onTrackerLost() {
    this.state = 'idle';
    this.broadcast({ type: 'handoff', phase: 'lost' });
    this.emit('lost');
  }

  getState() {
    return {
      state: this.state,
      trackerCameraId: this.trackerCameraId,
      lastHandoffMs: Date.now() - this._lastHandoff,
    };
  }
}

module.exports = DualCameraService;
