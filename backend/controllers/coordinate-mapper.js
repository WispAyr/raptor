/**
 * Coordinate Mapper
 * Converts pixel centroids to real azimuth/elevation angles and vice versa.
 *
 * Coordinate system:
 *   Azimuth:   0° = North, 90° = East, 180° = South, 270° = West
 *   Elevation: 0° = Horizon, 90° = Zenith
 *
 * Requires:
 *   - Camera GPS position (lat, lon, alt)
 *   - Camera FOV (horizontal and vertical, in degrees)
 *   - Current pan/tilt encoder position (degrees from home)
 *   - Home azimuth (compass bearing the camera faces at pan=0)
 */
class CoordinateMapper {
  /**
   * @param {Object} config
   * @param {number} config.lat            - Camera latitude (decimal degrees)
   * @param {number} config.lon            - Camera longitude (decimal degrees)
   * @param {number} config.alt            - Camera altitude (metres ASL)
   * @param {number} config.hfov           - Horizontal field of view (degrees)
   * @param {number} config.vfov           - Vertical field of view (degrees)
   * @param {number} [config.homeAz=0]     - Azimuth at pan=0 (compass degrees, 0=North)
   * @param {number} [config.homeTilt=0]   - Elevation at tilt=0 (degrees, 0=horizon)
   */
  constructor({ lat, lon, alt = 0, hfov = 60, vfov = 34, homeAz = 0, homeTilt = 0 }) {
    this.lat = lat;
    this.lon = lon;
    this.alt = alt;
    this.hfov = hfov;
    this.vfov = vfov;
    this.homeAz = homeAz;
    this.homeTilt = homeTilt;
    // Updated dynamically as camera moves
    this.currentPan = 0;   // degrees from home
    this.currentTilt = 0;  // degrees from home
  }

  /** Update the camera's current pan/tilt from encoder feedback. */
  updatePosition(pan, tilt) {
    this.currentPan = pan;
    this.currentTilt = tilt;
  }

  /**
   * Convert pixel centroid → azimuth/elevation.
   * @param {number} px - Pixel x (0 = left)
   * @param {number} py - Pixel y (0 = top)
   * @param {number} frameW - Frame width in pixels
   * @param {number} frameH - Frame height in pixels
   * @returns {{ az: number, el: number, bearing: string }}
   */
  pixelToAzEl(px, py, frameW, frameH) {
    // Normalise pixel to -0.5..+0.5 relative to frame centre
    const normX = (px / frameW) - 0.5;
    const normY = (py / frameH) - 0.5;

    // Angular offset from camera boresight
    const dPan  =  normX * this.hfov;  // positive = right = increasing az
    const dTilt = -normY * this.vfov;  // positive = up   = increasing el

    // Current boresight in world coordinates
    const boresightAz = (this.homeAz + this.currentPan) % 360;
    const boresightEl = this.homeTilt + this.currentTilt;

    const az = ((boresightAz + dPan) + 360) % 360;
    const el = Math.max(-90, Math.min(90, boresightEl + dTilt));

    return { az: parseFloat(az.toFixed(2)), el: parseFloat(el.toFixed(2)), bearing: this._bearing(az) };
  }

  /**
   * Convert azimuth/elevation → required pan/tilt command (normalised -1..+1).
   * @param {number} targetAz - Target azimuth (degrees)
   * @param {number} targetEl - Target elevation (degrees)
   * @returns {{ pan: number, tilt: number }} normalised -1..+1 velocity hints
   */
  azElToMove(targetAz, targetEl) {
    const boresightAz = (this.homeAz + this.currentPan + 360) % 360;
    const boresightEl = this.homeTilt + this.currentTilt;

    let dAz = targetAz - boresightAz;
    if (dAz > 180) dAz -= 360;
    if (dAz < -180) dAz += 360;
    const dEl = targetEl - boresightEl;

    // Normalise by half-FOV → if target is at edge of frame, full speed
    const pan  = Math.max(-1, Math.min(1, dAz / (this.hfov / 2)));
    const tilt = Math.max(-1, Math.min(1, dEl / (this.vfov / 2)));

    return { pan, tilt };
  }

  /**
   * Convert pixel centroid error (from frame centre) to pan/tilt velocity.
   * Used by the PID controller — this is purely proportional (PID adds I and D).
   */
  pixelErrorToVelocity(dx, dy, frameW, frameH) {
    return {
      pan:  (dx / (frameW / 2)),   // +1 = full right
      tilt: -(dy / (frameH / 2)),  // +1 = full up
    };
  }

  /** Convert azimuth degrees to compass bearing string. */
  _bearing(az) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(az / 22.5) % 16];
  }

  /**
   * Haversine distance between two lat/lon points (metres).
   * Used by multi-station triangulator.
   */
  static haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  /**
   * Bearing from point A to point B (degrees, 0=North).
   */
  static bearing(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
}

module.exports = CoordinateMapper;
