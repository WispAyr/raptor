/**
 * VISCA-over-IP Controller
 * Supports Sony, PTZOptics, Lumens, BirdDog, and compatible cameras.
 * VISCA is a serial protocol tunnelled over UDP or TCP.
 * Provides the same interface as ONVIFController and VAPIXController.
 */
const dgram = require('dgram');
const net = require('net');

// VISCA command bytes
const VISCA = {
  HEADER:      0x81,
  TERMINATOR:  0xFF,
  CMD:         0x01,
  INQ:         0x09,
  // Pan-Tilt
  PT_DRIVE:    [0x81, 0x01, 0x06, 0x01],
  PT_ABSOLUTE: [0x81, 0x01, 0x06, 0x02],
  PT_HOME:     [0x81, 0x01, 0x06, 0x04, 0xFF],
  PT_RESET:    [0x81, 0x01, 0x06, 0x05, 0xFF],
  PT_STOP:     [0x81, 0x01, 0x06, 0x01, 0x00, 0x00, 0x03, 0x03, 0xFF],
  // Zoom
  ZOOM_STOP:   [0x81, 0x01, 0x04, 0x07, 0x00, 0xFF],
  ZOOM_TELE:   [0x81, 0x01, 0x04, 0x07, 0x02, 0xFF],
  ZOOM_WIDE:   [0x81, 0x01, 0x04, 0x07, 0x03, 0xFF],
  // Presets
  PRESET_SET:  [0x81, 0x01, 0x04, 0x3F, 0x01],
  PRESET_CALL: [0x81, 0x01, 0x04, 0x3F, 0x02],
};

const MAX_PAN_SPEED  = 0x18; // 0x01–0x18
const MAX_TILT_SPEED = 0x14; // 0x01–0x14

class VISCAController {
  /**
   * @param {Object} config
   * @param {string} config.host
   * @param {number} [config.port=5678] - VISCA-over-IP default port
   * @param {string} [config.transport='udp'] - 'udp' or 'tcp'
   */
  constructor({ host, port = 5678, transport = 'udp' }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this._seq = 1;
    this._socket = null;
    this._tcpClient = null;
  }

  _nextSeq() {
    const s = this._seq++;
    if (this._seq > 0xFFFFFFFF) this._seq = 1;
    return s;
  }

  /**
   * Build a VISCA-over-IP packet with 8-byte header.
   */
  _buildPacket(payload) {
    const seq = this._nextSeq();
    const buf = Buffer.alloc(8 + payload.length);
    buf.writeUInt16BE(0x0100, 0);           // payload type: VISCA command
    buf.writeUInt16BE(payload.length, 2);   // payload length
    buf.writeUInt32BE(seq, 4);              // sequence number
    Buffer.from(payload).copy(buf, 8);
    return buf;
  }

  async _sendUDP(payload) {
    return new Promise((resolve, reject) => {
      const pkt = this._buildPacket(payload);
      const sock = dgram.createSocket('udp4');
      sock.send(pkt, this.port, this.host, (err) => {
        sock.close();
        if (err) reject(err); else resolve();
      });
    });
  }

  async _send(payload) {
    // Use raw VISCA bytes (no IP header) for TCP; IP header for UDP
    if (this.transport === 'tcp') {
      return this._sendTCP(Buffer.from(payload));
    }
    return this._sendUDP(payload);
  }

  async _sendTCP(buf) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      client.connect(this.port, this.host, () => {
        client.write(buf);
        setTimeout(() => { client.destroy(); resolve(); }, 200);
      });
      client.on('error', reject);
    });
  }

  /**
   * Continuous pan/tilt move.
   * pan, tilt: normalised -1..+1
   */
  async continuousMove(pan, tilt, zoom) {
    const panSpeed  = Math.round(Math.abs(pan)  * MAX_PAN_SPEED)  || 1;
    const tiltSpeed = Math.round(Math.abs(tilt) * MAX_TILT_SPEED) || 1;
    const panDir    = pan  > 0 ? 0x02 : pan  < 0 ? 0x01 : 0x03; // right/left/stop
    const tiltDir   = tilt > 0 ? 0x02 : tilt < 0 ? 0x01 : 0x03; // down/up/stop

    await this._send([...VISCA.PT_DRIVE, panSpeed, tiltSpeed, panDir, tiltDir, 0xFF]);

    if (zoom !== 0) {
      const zoomCmd = zoom > 0 ? VISCA.ZOOM_TELE : VISCA.ZOOM_WIDE;
      await this._send(zoomCmd);
    }
  }

  async stop() {
    await this._send(VISCA.PT_STOP);
    await this._send(VISCA.ZOOM_STOP);
  }

  /**
   * Absolute move — VISCA uses signed 16-bit pan/tilt positions.
   * pan, tilt: normalised -1..+1 → mapped to ±0x8000
   */
  async absoluteMove(pan, tilt, zoom = 0) {
    const panPos  = Math.round(pan  * 0x4000); // ±0x4000 typical range
    const tiltPos = Math.round(tilt * 0x2000);

    const toNybbles = (v) => {
      const u = v < 0 ? (0x10000 + v) : v;
      return [(u >> 12) & 0xF, (u >> 8) & 0xF, (u >> 4) & 0xF, u & 0xF];
    };

    const payload = [
      ...VISCA.PT_ABSOLUTE,
      MAX_PAN_SPEED, MAX_TILT_SPEED,
      ...toNybbles(panPos),
      ...toNybbles(tiltPos),
      0xFF,
    ];
    await this._send(payload);
  }

  async relativeMove(pan, tilt) {
    // VISCA doesn't have native relative move — simulate via absoluteMove delta
    // In a real implementation, read current position first
    return this.absoluteMove(pan, tilt, 0);
  }

  async gotoPreset(presetToken) {
    const presetNum = parseInt(presetToken, 10) || 0;
    await this._send([...VISCA.PRESET_CALL, presetNum & 0xFF, 0xFF]);
  }

  async setPreset(presetNum) {
    await this._send([...VISCA.PRESET_SET, presetNum & 0xFF, 0xFF]);
  }

  async getPresets() {
    // VISCA doesn't enumerate presets — return numbered list 0-15
    return Array.from({ length: 16 }, (_, i) => ({ token: String(i), name: `Preset ${i}` }));
  }

  async getStatus() {
    // VISCA inquiry would require parsing response bytes — stub for now
    return { pan: null, tilt: null, zoom: null };
  }

  async snapshot() {
    throw new Error('VISCA cameras do not support HTTP snapshot — use a separate RTSP/HTTP stream URL');
  }

  async homePosition() {
    await this._send(VISCA.PT_HOME);
  }
}

module.exports = VISCAController;
