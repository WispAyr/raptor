/**
 * Auto-Zoom Controller
 * Monitors target position relative to frame centre and issues incremental
 * zoom commands when the target stays centred. Backs off when target drifts
 * toward frame edges. Mirrors the UFODAP OTDAU auto-zoom feature.
 */
class AutoZoom {
  /**
   * @param {Object} options
   * @param {number} [options.centreThreshold=0.15]  - Fraction of frame width — target must be within this to trigger zoom in
   * @param {number} [options.edgeThreshold=0.35]    - Fraction of frame width — if target beyond this, zoom out
   * @param {number} [options.dwellFrames=20]         - Consecutive frames target must be centred before zoom step
   * @param {number} [options.zoomStep=0.05]          - Zoom increment per step (normalised 0..1)
   * @param {number} [options.maxZoom=0.9]            - Maximum normalised zoom level
   * @param {number} [options.minZoom=0.0]            - Minimum normalised zoom level
   * @param {Function} options.onZoom                 - Callback: (zoomLevel) => void
   */
  constructor({
    centreThreshold = 0.15,
    edgeThreshold   = 0.35,
    dwellFrames     = 20,
    zoomStep        = 0.05,
    maxZoom         = 0.9,
    minZoom         = 0.0,
    onZoom          = () => {},
  } = {}) {
    this.centreThreshold = centreThreshold;
    this.edgeThreshold   = edgeThreshold;
    this.dwellFrames     = dwellFrames;
    this.zoomStep        = zoomStep;
    this.maxZoom         = maxZoom;
    this.minZoom         = minZoom;
    this.onZoom          = onZoom;

    this.currentZoom     = 0;    // normalised 0..1
    this._centredFrames  = 0;
    this._enabled        = true;
  }

  enable()  { this._enabled = true; }
  disable() { this._enabled = false; this.reset(); }
  reset()   { this._centredFrames = 0; }

  /**
   * Call once per detection frame.
   * @param {number} normDx - Normalised x error from frame centre (-1..+1)
   * @param {number} normDy - Normalised y error from frame centre (-1..+1)
   * @returns {number|null} New zoom level if changed, null otherwise
   */
  update(normDx, normDy) {
    if (!this._enabled) return null;

    const dist = Math.hypot(normDx, normDy);

    if (dist < this.centreThreshold) {
      // Target is centred — count dwell frames
      this._centredFrames++;
      if (this._centredFrames >= this.dwellFrames) {
        this._centredFrames = 0;
        return this._zoomIn();
      }
    } else if (dist > this.edgeThreshold) {
      // Target is near edge — zoom out to avoid losing it
      this._centredFrames = 0;
      return this._zoomOut();
    } else {
      // Target drifting — reset dwell counter but don't change zoom
      this._centredFrames = Math.max(0, this._centredFrames - 1);
    }
    return null;
  }

  _zoomIn() {
    if (this.currentZoom >= this.maxZoom) return null;
    this.currentZoom = Math.min(this.maxZoom, this.currentZoom + this.zoomStep);
    this.onZoom(this.currentZoom);
    return this.currentZoom;
  }

  _zoomOut() {
    if (this.currentZoom <= this.minZoom) return null;
    this.currentZoom = Math.max(this.minZoom, this.currentZoom - this.zoomStep * 2);
    this.onZoom(this.currentZoom);
    return this.currentZoom;
  }

  resetZoom() {
    this.currentZoom = 0;
    this.onZoom(0);
    return 0;
  }

  getState() {
    return {
      zoom: this.currentZoom,
      centredFrames: this._centredFrames,
      dwellThreshold: this.dwellFrames,
      enabled: this._enabled,
    };
  }
}

module.exports = AutoZoom;
