/**
 * HLS Streamer
 * =============
 * Transcodes RTSP camera streams to HLS for browser playback.
 * Spawns one ffmpeg process per camera, serving .m3u8 + .ts segments.
 *
 * Usage: accessed via /streams/:cameraId/index.m3u8 in browser
 * Requires: ffmpeg in PATH
 *
 * Profile-aware: only starts if HLS_ENABLED=true or profile includes it.
 */
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const EventEmitter = require('events');

class HLSStreamer extends EventEmitter {
  constructor({ outputDir = './streams', segmentDuration = 2, segmentCount = 5 } = {}) {
    super();
    this.outputDir       = outputDir;
    this.segmentDuration = segmentDuration;
    this.segmentCount    = segmentCount;
    this._streams        = new Map();  // cameraId → { proc, dir, restartCount }
    fs.mkdirSync(outputDir, { recursive: true });
  }

  /**
   * Start HLS transcoding for a camera.
   * @param {Object} camera - Camera object from DB { id, stream_url, name }
   */
  start(camera) {
    if (!camera.stream_url) {
      console.warn(`[HLS] Camera ${camera.id} has no stream_url — skipping`);
      return;
    }
    if (this._streams.has(camera.id)) return; // already running

    const dir = path.join(this.outputDir, String(camera.id));
    fs.mkdirSync(dir, { recursive: true });

    this._spawn(camera, dir, 0);
  }

  _spawn(camera, dir, restartCount) {
    const playlist = path.join(dir, 'index.m3u8');
    const segPat   = path.join(dir, 'seg%05d.ts');

    const args = [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', camera.stream_url,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', String(this.segmentDuration),
      '-hls_list_size', String(this.segmentCount),
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', segPat,
      playlist,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      // Only log errors, not ffmpeg's verbose output
      if (str.includes('Error') || str.includes('error')) {
        console.error(`[HLS:${camera.id}] ${str.trim()}`);
      }
    });

    proc.on('close', (code) => {
      this._streams.delete(camera.id);
      if (code !== 0 && restartCount < 10) {
        const delay = Math.min(30000, 2000 * (restartCount + 1));
        console.warn(`[HLS:${camera.id}] Process exited (${code}), restarting in ${delay}ms`);
        setTimeout(() => this._spawn(camera, dir, restartCount + 1), delay);
      } else if (restartCount >= 10) {
        console.error(`[HLS:${camera.id}] Too many restarts — giving up`);
        this.emit('error', camera.id);
      }
    });

    this._streams.set(camera.id, { proc, dir, camera, restartCount });
    console.log(`[HLS] Started stream for camera ${camera.id} (${camera.name})`);
    this.emit('started', camera.id);
  }

  stop(cameraId) {
    const entry = this._streams.get(cameraId);
    if (!entry) return;
    entry.proc.kill('SIGTERM');
    this._streams.delete(cameraId);
    console.log(`[HLS] Stopped stream for camera ${cameraId}`);
  }

  stopAll() {
    for (const [id] of this._streams) this.stop(id);
  }

  getPlaylistPath(cameraId) {
    return path.join(this.outputDir, String(cameraId), 'index.m3u8');
  }

  isRunning(cameraId) {
    return this._streams.has(cameraId);
  }

  getStatus() {
    const status = {};
    for (const [id, { camera, restartCount }] of this._streams) {
      status[id] = { name: camera.name, running: true, restartCount };
    }
    return status;
  }
}

module.exports = HLSStreamer;
