/**
 * ZeroMQ Detection Bridge
 * Subscribes to the Python detector's ZMQ PUB socket and emits detection events
 * to the Node.js event system. Falls back gracefully if ZMQ is not available.
 */
const EventEmitter = require('events');

class ZMQBridge extends EventEmitter {
  constructor(endpoint = 'tcp://127.0.0.1:5556') {
    super();
    this.endpoint = endpoint;
    this._socket = null;
    this._running = false;
    this._trackTimers = new Map(); // trackId → timeout for lost detection
    this._lastSeen = new Map();
    this.LOST_TIMEOUT_MS = 1500;
  }

  async start() {
    try {
      // Dynamic import — zeromq is optional; system still works without it
      const zmq = await import('zeromq');
      this._socket = new zmq.Subscriber();
      await this._socket.connect(this.endpoint);
      this._socket.subscribe('');
      this._running = true;
      console.log(`[ZMQ] Subscribed to ${this.endpoint}`);
      this._listen();
    } catch (err) {
      console.warn(`[ZMQ] ZeroMQ not available (${err.message}). Detection bridge inactive.`);
      console.warn('[ZMQ] Start the Python detector separately and ensure zeromq is installed.');
    }
  }

  async _listen() {
    for await (const [msg] of this._socket) {
      if (!this._running) break;
      try {
        const event = JSON.parse(msg.toString());
        this._handleEvent(event);
      } catch (err) {
        console.error('[ZMQ] Parse error:', err.message);
      }
    }
  }

  _handleEvent(event) {
    const { track_id } = event;

    // Clear existing lost timer for this track
    clearTimeout(this._trackTimers.get(track_id));
    this._lastSeen.set(track_id, Date.now());

    this.emit('detection', event);

    // Set timer — if we don't hear from this track for LOST_TIMEOUT_MS, emit 'lost'
    this._trackTimers.set(
      track_id,
      setTimeout(() => {
        this._trackTimers.delete(track_id);
        this._lastSeen.delete(track_id);
        this.emit('lost', { track_id });
        // If no tracks remain, emit global lost
        if (this._trackTimers.size === 0) {
          this.emit('lost', {});
        }
      }, this.LOST_TIMEOUT_MS)
    );
  }

  async stop() {
    this._running = false;
    if (this._socket) {
      await this._socket.close();
      this._socket = null;
    }
  }
}

module.exports = ZMQBridge;
