#!/usr/bin/env python3
"""
Optical Flow Module
===================
Computes per-track velocity and trajectory anomaly score using Lucas-Kanade
sparse optical flow. Flags tracks with anomalous kinematics:
  - Sudden direction reversal
  - Non-ballistic (non-constant velocity) trajectory
  - Anomalous acceleration (exceeds configurable threshold)

Usage: imported by detector.py, not run standalone.
"""
import numpy as np
import cv2
from collections import defaultdict


# Thresholds
ANOMALY_ACCEL_THRESHOLD  = 8.0   # px/frame² — above this = anomalous acceleration
ANOMALY_REVERSAL_DEGREES = 120   # direction change > this degrees in one frame = anomalous
MIN_TRACK_LENGTH         = 5     # frames before anomaly scoring starts

LK_PARAMS = dict(
    winSize=(15, 15),
    maxLevel=3,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 10, 0.03),
)


class OpticalFlowTracker:
    """Tracks centroid motion history per track ID and computes velocity/anomaly metrics."""

    def __init__(self):
        self._history = defaultdict(list)   # track_id → list of (x, y, frame_idx)
        self._velocities = defaultdict(list) # track_id → list of (vx, vy)
        self._frame_idx = 0

    def update(self, track_id: str, cx: float, cy: float):
        """
        Register a new centroid position for a track.
        Returns a metrics dict or None if not enough history.
        """
        self._history[track_id].append((cx, cy, self._frame_idx))
        hist = self._history[track_id]

        if len(hist) < 2:
            return None

        # Compute velocity
        prev_x, prev_y, _ = hist[-2]
        vx = cx - prev_x
        vy = cy - prev_y
        speed = np.hypot(vx, vy)
        self._velocities[track_id].append((vx, vy))

        metrics = {
            'velocity_px':       round(speed, 2),
            'vx':                round(vx, 2),
            'vy':                round(vy, 2),
            'anomaly_flag':      False,
            'anomaly_reason':    None,
            'trajectory_score':  1.0,  # 1.0 = normal, 0.0 = highly anomalous
        }

        if len(hist) < MIN_TRACK_LENGTH:
            return metrics

        # ── Acceleration check ────────────────────────────────────────────────
        velocities = self._velocities[track_id]
        if len(velocities) >= 2:
            prev_vx, prev_vy = velocities[-2]
            ax = vx - prev_vx
            ay = vy - prev_vy
            accel = np.hypot(ax, ay)
            if accel > ANOMALY_ACCEL_THRESHOLD:
                metrics['anomaly_flag']   = True
                metrics['anomaly_reason'] = f'acceleration {accel:.1f}px/f²'
                metrics['trajectory_score'] = max(0.0, 1.0 - accel / (ANOMALY_ACCEL_THRESHOLD * 3))

        # ── Direction reversal check ──────────────────────────────────────────
        if len(velocities) >= 2:
            prev_vx, prev_vy = velocities[-2]
            prev_angle = np.degrees(np.arctan2(prev_vy, prev_vx))
            curr_angle = np.degrees(np.arctan2(vy, vx))
            angle_diff = abs(((curr_angle - prev_angle) + 180) % 360 - 180)
            if angle_diff > ANOMALY_REVERSAL_DEGREES and speed > 2.0:
                metrics['anomaly_flag']   = True
                metrics['anomaly_reason'] = f'direction reversal {angle_diff:.0f}°'
                metrics['trajectory_score'] = min(metrics['trajectory_score'], max(0.0, 1.0 - angle_diff / 360))

        # ── Trajectory smoothness (variance of velocity direction) ────────────
        if len(velocities) >= MIN_TRACK_LENGTH:
            angles = [np.degrees(np.arctan2(vy_, vx_)) for vx_, vy_ in velocities[-MIN_TRACK_LENGTH:]]
            angle_variance = np.std(np.unwrap(np.radians(angles)) * 180 / np.pi)
            if angle_variance > 45:
                metrics['trajectory_score'] = min(metrics['trajectory_score'], max(0.0, 1.0 - angle_variance / 180))

        return metrics

    def tick(self):
        """Call once per frame to advance the frame counter."""
        self._frame_idx += 1

    def remove_track(self, track_id: str):
        self._history.pop(track_id, None)
        self._velocities.pop(track_id, None)

    def get_history(self, track_id: str):
        return [(x, y) for x, y, _ in self._history.get(track_id, [])]
