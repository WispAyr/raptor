/**
 * Event Recorder
 * Logs detection events to SQLite and triggers ffmpeg clip recording.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class EventRecorder {
  constructor({ recordingsDir, snapshotsDir, db }) {
    this.recordingsDir = recordingsDir;
    this.snapshotsDir = snapshotsDir;
    this.db = db;
    this._activeRecordings = new Map(); // trackId → { proc, startedAt, eventId }
  }

  /**
   * Called when a new detection arrives.
   * Starts a recording if this is a new track_id, or extends the existing one.
   */
  onDetection({ camera_id, track_id, cls, confidence, centroid_x, centroid_y }) {
    if (!this._activeRecordings.has(track_id)) {
      this._startRecording({ camera_id, track_id, cls, confidence, centroid_x, centroid_y });
    }
    // Update last-seen time for the track
    const rec = this._activeRecordings.get(track_id);
    if (rec) rec.lastSeen = Date.now();
  }

  /**
   * Called when a track is lost. Stops the recording after a short grace period.
   */
  onTrackLost(track_id) {
    const rec = this._activeRecordings.get(track_id);
    if (!rec) return;
    setTimeout(() => {
      this._stopRecording(track_id);
    }, 2000);
  }

  _startRecording({ camera_id, track_id, cls, confidence, centroid_x, centroid_y }) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const clipName = `track_${track_id}_${cls}_${ts}.mp4`;
    const clipPath = path.join(this.recordingsDir, clipName);

    // Get camera stream URL
    const cam = this.db.prepare('SELECT * FROM cameras WHERE id = ?').get(camera_id);
    if (!cam?.stream_url) {
      // No stream URL — log event only
      const result = this.db.prepare(
        'INSERT INTO events (camera_id, track_id, class, confidence, centroid_x, centroid_y) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(camera_id, track_id, cls, confidence, centroid_x, centroid_y);
      this._activeRecordings.set(track_id, { eventId: result.lastInsertRowid, lastSeen: Date.now() });
      return;
    }

    // Start ffmpeg recording
    const proc = spawn('ffmpeg', [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', cam.stream_url,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-t', '120',  // max 2 minute clips
      clipPath,
    ], { stdio: 'ignore' });

    const result = this.db.prepare(
      'INSERT INTO events (camera_id, track_id, class, confidence, centroid_x, centroid_y, clip_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(camera_id, track_id, cls, confidence, centroid_x, centroid_y, clipPath);

    proc.on('close', () => {
      console.log(`[Recorder] Clip saved: ${clipPath}`);
    });

    this._activeRecordings.set(track_id, {
      proc,
      clipPath,
      eventId: result.lastInsertRowid,
      lastSeen: Date.now(),
    });
  }

  _stopRecording(track_id) {
    const rec = this._activeRecordings.get(track_id);
    if (!rec) return;
    if (rec.proc) {
      rec.proc.stdin?.write('q');
      rec.proc.kill('SIGTERM');
    }
    this._activeRecordings.delete(track_id);
    console.log(`[Recorder] Track ${track_id} recording stopped`);
  }

  /**
   * Export events to CSV string.
   */
  exportCSV(limit = 1000) {
    const events = this.db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit);
    const header = 'id,camera_id,track_id,class,confidence,centroid_x,centroid_y,pan,tilt,zoom,created_at,clip_path\n';
    const rows = events.map(e =>
      `${e.id},${e.camera_id},${e.track_id},${e.class},${e.confidence},${e.centroid_x},${e.centroid_y},${e.pan},${e.tilt},${e.zoom},${e.created_at},${e.clip_path}`
    ).join('\n');
    return header + rows;
  }
}

module.exports = EventRecorder;
