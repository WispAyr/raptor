/**
 * PID Controller
 * Used for smooth pan and tilt tracking.
 * Input: normalised pixel error (-1..+1)
 * Output: normalised velocity command (-1..+1)
 */
class PIDController {
  /**
   * @param {number} kp - Proportional gain
   * @param {number} ki - Integral gain
   * @param {number} kd - Derivative gain
   * @param {number} [outputLimit=1.0] - Clamp output to ±limit
   * @param {number} [integralLimit=0.5] - Anti-windup clamp for integral
   * @param {number} [deadband=0.01] - Ignore errors smaller than this
   */
  constructor(kp, ki, kd, outputLimit = 1.0, integralLimit = 0.5, deadband = 0.01) {
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.outputLimit = outputLimit;
    this.integralLimit = integralLimit;
    this.deadband = deadband;

    this._integral = 0;
    this._prevError = 0;
    this._lastTime = null;
  }

  /**
   * Compute PID output given current error.
   * @param {number} error - Current error (-1..+1)
   * @param {number} [dt=0.033] - Time delta in seconds
   * @returns {number} Velocity command (-1..+1)
   */
  compute(error, dt = 0.033) {
    if (Math.abs(error) < this.deadband) {
      this._prevError = 0;
      return 0;
    }

    // Integral with anti-windup
    this._integral += error * dt;
    this._integral = Math.max(-this.integralLimit, Math.min(this.integralLimit, this._integral));

    // Derivative
    const derivative = (error - this._prevError) / dt;
    this._prevError = error;

    const output = (this.kp * error) + (this.ki * this._integral) + (this.kd * derivative);
    return Math.max(-this.outputLimit, Math.min(this.outputLimit, output));
  }

  reset() {
    this._integral = 0;
    this._prevError = 0;
    this._lastTime = null;
  }

  tune(kp, ki, kd) {
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.reset();
  }
}

module.exports = PIDController;
