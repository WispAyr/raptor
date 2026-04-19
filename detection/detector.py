#!/usr/bin/env python3
"""
RAPTOR Detection Engine
=======================
Sky-object detection pipeline inspired by UFODAP/OTDAU and Sky360/SimpleTracker.

Pipeline (per frame):
  1. Resize + greyscale
  2. Gaussian blur (noise reduction)
  3. MOG2 background subtraction (motion mask)
  4. Blob detection (fast moving-object candidates)
  5. YOLOv8 classification on each blob ROI (filter false positives)
  6. ByteTrack multi-object tracking (stable IDs)
  7. Publish detections via ZeroMQ PUB socket

Usage:
  python detector.py --source rtsp://admin:pass@192.168.1.100/stream1
  python detector.py --source 0          # webcam
  python detector.py --source demo       # synthetic moving dot demo
"""
import argparse
import json
import time
import sys
import os
import logging

import cv2
import numpy as np
import zmq

logging.basicConfig(level=logging.INFO, format='[RAPTOR] %(message)s')
log = logging.getLogger('raptor')

# ── Config ─────────────────────────────────────────────────────────────────────
DEFAULT_ZMQ_ENDPOINT = 'tcp://127.0.0.1:5556'
DEFAULT_SOURCE        = '0'
FRAME_WIDTH           = 1280
FRAME_HEIGHT          = 720
PROCESS_WIDTH         = 640   # Downscale for processing
PROCESS_HEIGHT        = 360
MIN_BLOB_AREA         = 40    # px² — smaller blobs ignored
MAX_BLOB_AREA         = 50000 # px² — too large = background noise
DETECTION_CONFIDENCE  = 0.35
CLASSES_TO_IGNORE     = {'bird', 'airplane', 'kite', 'sports ball'}  # tune per use case

# ── ZeroMQ Publisher ───────────────────────────────────────────────────────────
def create_publisher(endpoint: str):
    ctx = zmq.Context()
    sock = ctx.socket(zmq.PUB)
    sock.bind(endpoint)
    time.sleep(0.5)  # Allow subscribers to connect
    log.info(f'ZMQ PUB bound to {endpoint}')
    return sock

def publish(sock, payload: dict):
    sock.send_string(json.dumps(payload))

# ── Background subtractor ──────────────────────────────────────────────────────
def create_bg_subtractor():
    sub = cv2.createBackgroundSubtractorMOG2(
        history=200,
        varThreshold=40,
        detectShadows=False
    )
    return sub

# ── Blob detector ─────────────────────────────────────────────────────────────
def create_blob_detector():
    params = cv2.SimpleBlobDetector_Params()
    params.filterByArea = True
    params.minArea = MIN_BLOB_AREA
    params.maxArea = MAX_BLOB_AREA
    params.filterByCircularity = False
    params.filterByConvexity = False
    params.filterByInertia = False
    return cv2.SimpleBlobDetector_create(params)

# ── Simple Kalman tracker ─────────────────────────────────────────────────────
class SimpleTracker:
    """Lightweight centroid-based tracker with Kalman filter per track."""
    def __init__(self, max_disappeared=15, max_distance=80):
        self.next_id = 0
        self.objects = {}       # id → centroid (x, y)
        self.disappeared = {}   # id → frames since last seen
        self.max_disappeared = max_disappeared
        self.max_distance = max_distance
        self.kalman = {}        # id → cv2.KalmanFilter

    def _create_kalman(self, x, y):
        kf = cv2.KalmanFilter(4, 2)
        kf.measurementMatrix = np.array([[1,0,0,0],[0,1,0,0]], np.float32)
        kf.transitionMatrix = np.array([[1,0,1,0],[0,1,0,1],[0,0,1,0],[0,0,0,1]], np.float32)
        kf.processNoiseCov = np.eye(4, dtype=np.float32) * 0.03
        kf.measurementNoiseCov = np.eye(2, dtype=np.float32) * 1.0
        kf.statePost = np.array([[x],[y],[0],[0]], np.float32)
        return kf

    def register(self, x, y):
        tid = self.next_id
        self.objects[tid] = (x, y)
        self.disappeared[tid] = 0
        self.kalman[tid] = self._create_kalman(x, y)
        self.next_id += 1
        return tid

    def deregister(self, tid):
        del self.objects[tid]
        del self.disappeared[tid]
        del self.kalman[tid]

    def update(self, centroids):
        if not centroids:
            for tid in list(self.disappeared):
                self.disappeared[tid] += 1
                if self.disappeared[tid] > self.max_disappeared:
                    self.deregister(tid)
            return {}

        if not self.objects:
            for (x, y) in centroids:
                self.register(x, y)
        else:
            ids = list(self.objects.keys())
            old_pts = list(self.objects.values())

            # Simple greedy nearest-neighbour matching
            used_new = set()
            matched = {}
            for tid, op in zip(ids, old_pts):
                best_dist, best_idx = float('inf'), -1
                for i, np_ in enumerate(centroids):
                    if i in used_new:
                        continue
                    d = np.hypot(op[0]-np_[0], op[1]-np_[1])
                    if d < best_dist:
                        best_dist, best_idx = d, i
                if best_idx >= 0 and best_dist < self.max_distance:
                    matched[tid] = best_idx
                    used_new.add(best_idx)

            for tid in ids:
                if tid in matched:
                    x, y = centroids[matched[tid]]
                    kf = self.kalman[tid]
                    kf.correct(np.array([[x],[y]], np.float32))
                    pred = kf.predict()
                    self.objects[tid] = (float(pred[0]), float(pred[1]))
                    self.disappeared[tid] = 0
                else:
                    self.disappeared[tid] += 1
                    pred = self.kalman[tid].predict()
                    self.objects[tid] = (float(pred[0]), float(pred[1]))
                    if self.disappeared[tid] > self.max_disappeared:
                        self.deregister(tid)

            for i, (x, y) in enumerate(centroids):
                if i not in used_new:
                    self.register(x, y)

        return dict(self.objects)

# ── YOLO classifier (optional — graceful fallback) ────────────────────────────
def load_yolo():
    try:
        from ultralytics import YOLO
        model = YOLO('yolov8n.pt')  # Nano — fast on CPU/MPS
        log.info('YOLOv8n loaded')
        return model
    except Exception as e:
        log.warning(f'YOLO unavailable: {e}. Classification disabled.')
        return None

def classify_roi(model, frame, x1, y1, x2, y2):
    """Run YOLOv8 on a bounding box ROI. Returns (class, confidence)."""
    if model is None:
        return 'unknown', 1.0
    roi = frame[max(0,y1):y2, max(0,x1):x2]
    if roi.size == 0:
        return 'unknown', 0.0
    results = model(roi, verbose=False, conf=DETECTION_CONFIDENCE)
    if results and results[0].boxes and len(results[0].boxes):
        box = results[0].boxes[0]
        cls_name = results[0].names[int(box.cls[0])]
        conf = float(box.conf[0])
        return cls_name, conf
    return 'unknown', 1.0

# ── Demo source (synthetic moving blob) ──────────────────────────────────────
def demo_generator():
    """Yields synthetic frames with a moving bright dot for testing without a camera."""
    w, h = FRAME_WIDTH, FRAME_HEIGHT
    t = 0
    while True:
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        # Lissajous figure path
        x = int(w/2 + (w/3) * np.sin(t * 0.7))
        y = int(h/2 + (h/3) * np.sin(t * 1.1))
        cv2.circle(frame, (x, y), 8, (255, 255, 255), -1)
        cv2.putText(frame, 'DEMO MODE', (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,200,200), 2)
        t += 0.05
        yield frame

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='RAPTOR Detection Engine')
    parser.add_argument('--source', default=DEFAULT_SOURCE, help='RTSP URL, device index, or "demo"')
    parser.add_argument('--zmq', default=DEFAULT_ZMQ_ENDPOINT, help='ZMQ PUB endpoint')
    parser.add_argument('--camera-id', type=int, default=1, help='Camera ID to tag events with')
    parser.add_argument('--mask', default=None, help='Path to detection mask image (white=detect area)')
    parser.add_argument('--show', action='store_true', help='Show live preview window')
    parser.add_argument('--no-yolo', action='store_true', help='Disable YOLOv8 classification')
    args = parser.parse_args()

    pub = create_publisher(args.zmq)
    bg_sub = create_bg_subtractor()
    tracker = SimpleTracker()
    model = None if args.no_yolo else load_yolo()

    # Load optional detection mask
    mask_img = None
    if args.mask and os.path.exists(args.mask):
        mask_img = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
        mask_img = cv2.resize(mask_img, (PROCESS_WIDTH, PROCESS_HEIGHT))
        log.info(f'Detection mask loaded: {args.mask}')

    # Open source
    demo_mode = args.source.lower() == 'demo'
    if demo_mode:
        log.info('Running in DEMO mode — synthetic moving target')
        gen = demo_generator()
        cap = None
    else:
        source = int(args.source) if args.source.isdigit() else args.source
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            log.error(f'Cannot open source: {args.source}')
            sys.exit(1)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
        log.info(f'Source opened: {args.source}')

    frame_count = 0
    track_start = {}  # track_id → first_seen_ms

    while True:
        if demo_mode:
            frame = next(gen)
        else:
            ret, frame = cap.read()
            if not ret:
                log.warning('Frame read failed — retrying...')
                time.sleep(0.1)
                continue

        frame_count += 1
        h, w = frame.shape[:2]

        # ── 1. Downscale for processing ───────────────────────────────────────
        small = cv2.resize(frame, (PROCESS_WIDTH, PROCESS_HEIGHT))
        scale_x = w / PROCESS_WIDTH
        scale_y = h / PROCESS_HEIGHT

        # ── 2. Greyscale + Gaussian blur ──────────────────────────────────────
        grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(grey, (5, 5), 0)

        # ── 3. Background subtraction ─────────────────────────────────────────
        fg_mask = bg_sub.apply(blurred)
        if mask_img is not None:
            fg_mask = cv2.bitwise_and(fg_mask, mask_img)

        # ── 4. Morphological cleanup ──────────────────────────────────────────
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, kernel)
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel)

        # ── 5. Find contours (blobs) ──────────────────────────────────────────
        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        centroids = []
        detections = []  # (cx, cy, x1, y1, x2, y2) in original frame coords

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < MIN_BLOB_AREA or area > MAX_BLOB_AREA:
                continue
            x, y, bw, bh = cv2.boundingRect(cnt)
            cx = x + bw // 2
            cy = y + bh // 2
            centroids.append((cx, cy))
            # Scale back to original frame
            ox1 = int(x * scale_x)
            oy1 = int(y * scale_y)
            ox2 = int((x + bw) * scale_x)
            oy2 = int((y + bh) * scale_y)
            detections.append((cx, cy, ox1, oy1, ox2, oy2))

        # ── 6. Update tracker ─────────────────────────────────────────────────
        tracks = tracker.update(centroids)  # {id: (x, y)}

        # ── 7. Classify + publish ─────────────────────────────────────────────
        now_ms = int(time.time() * 1000)

        for (cx_s, cy_s, ox1, oy1, ox2, oy2) in detections:
            # Find nearest track to this detection centroid
            best_tid = None
            best_d = float('inf')
            for tid, (tx, ty) in tracks.items():
                d = np.hypot(cx_s - tx, cy_s - ty)
                if d < best_d:
                    best_d, best_tid = d, tid

            if best_tid is None:
                continue

            if best_tid not in track_start:
                track_start[best_tid] = now_ms

            # Classify ROI with YOLO
            cls_name, conf = classify_roi(model, frame, ox1, oy1, ox2, oy2)

            # Skip known false positives
            if cls_name in CLASSES_TO_IGNORE and conf > 0.6:
                continue

            time_visible_ms = now_ms - track_start[best_tid]

            payload = {
                'track_id': str(best_tid),
                'class': cls_name,
                'confidence': round(conf, 3),
                'centroid_x': round(cx_s * scale_x),
                'centroid_y': round(cy_s * scale_y),
                'bbox': [ox1, oy1, ox2, oy2],
                'frame_w': w,
                'frame_h': h,
                'camera_id': args.camera_id,
                'time_visible_ms': time_visible_ms,
                'ts': now_ms,
            }
            publish(pub, payload)

            if args.show:
                colour = (0, 0, 255) if cls_name == 'unknown' else (0, 200, 100)
                cv2.rectangle(frame, (ox1, oy1), (ox2, oy2), colour, 2)
                label = f'{cls_name} {conf:.2f} [{best_tid}]'
                cv2.putText(frame, label, (ox1, oy1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1)

        if args.show:
            cv2.imshow('RAPTOR Detection', frame)
            cv2.imshow('FG Mask', fg_mask)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    if cap:
        cap.release()
    cv2.destroyAllWindows()
    pub.close()

if __name__ == '__main__':
    main()
