#!/usr/bin/env python3
"""
RAPTOR Detection Engine v2
===========================
Integrated pipeline with all Phase 2 modules:
  1. Fisheye dewarp (optional)
  2. Night mode preprocessing
  3. Constellation mask (star suppression)
  4. MOG2 background subtraction (adaptive params from night mode)
  5. Contour blob detection
  6. Optical flow velocity + trajectory anomaly scoring
  7. Kalman tracker
  8. YOLOv8 classification (optional)
  9. ZeroMQ publish

Usage:
  python detector.py --source demo
  python detector.py --source rtsp://admin:pass@192.168.1.100/stream1
  python detector.py --source 0 --fisheye --fisheye-fov 185
  python detector.py --no-yolo --show
"""
import argparse
import json
import os
import sys
import time
import logging

import cv2
import numpy as np
import zmq

from optical_flow import OpticalFlowTracker
from constellation_mask import ConstellationMask
from fisheye import FisheyeDewarper
from night_mode import NightModeProcessor

logging.basicConfig(level=logging.INFO, format='[RAPTOR] %(message)s')
log = logging.getLogger('raptor')

# ── Defaults ────────────────────────────────────────────────────────────────────
DEFAULT_ZMQ   = os.environ.get('ZMQ_ENDPOINT', 'tcp://127.0.0.1:5556')
FRAME_W       = int(os.environ.get('DETECT_PROCESS_W', 640))
FRAME_H       = int(os.environ.get('DETECT_PROCESS_H', 360))
MIN_BLOB_AREA = 30
MAX_BLOB_AREA = 50000
YOLO_CONF     = 0.35
IGNORE_CLASSES = {'bird', 'airplane', 'kite', 'sports ball'}

# ── ZMQ ─────────────────────────────────────────────────────────────────────────
def make_pub(endpoint):
    ctx = zmq.Context()
    sock = ctx.socket(zmq.PUB)
    sock.bind(endpoint)
    time.sleep(0.5)
    log.info(f'ZMQ PUB → {endpoint}')
    return sock

def publish(sock, payload):
    sock.send_string(json.dumps(payload))

# ── Kalman tracker ───────────────────────────────────────────────────────────────
class SimpleTracker:
    def __init__(self, max_disappeared=15, max_distance=80):
        self.next_id = 0
        self.objects = {}
        self.disappeared = {}
        self.kalman = {}
        self.max_disappeared = max_disappeared
        self.max_distance = max_distance

    def _make_kf(self, x, y):
        kf = cv2.KalmanFilter(4, 2)
        kf.measurementMatrix = np.array([[1,0,0,0],[0,1,0,0]], np.float32)
        kf.transitionMatrix  = np.array([[1,0,1,0],[0,1,0,1],[0,0,1,0],[0,0,0,1]], np.float32)
        kf.processNoiseCov   = np.eye(4, dtype=np.float32) * 0.03
        kf.measurementNoiseCov = np.eye(2, dtype=np.float32) * 1.0
        kf.statePost = np.array([[x],[y],[0],[0]], np.float32)
        return kf

    def _register(self, x, y):
        tid = self.next_id; self.next_id += 1
        self.objects[tid] = (x, y)
        self.disappeared[tid] = 0
        self.kalman[tid] = self._make_kf(x, y)
        return tid

    def _deregister(self, tid):
        del self.objects[tid], self.disappeared[tid], self.kalman[tid]

    def update(self, centroids):
        if not centroids:
            for tid in list(self.disappeared):
                self.disappeared[tid] += 1
                if self.disappeared[tid] > self.max_disappeared:
                    self._deregister(tid)
            return {}
        if not self.objects:
            for p in centroids: self._register(*p)
        else:
            ids = list(self.objects); old = list(self.objects.values())
            used = set(); matched = {}
            for tid, op in zip(ids, old):
                bd, bi = float('inf'), -1
                for i, np_ in enumerate(centroids):
                    if i in used: continue
                    d = np.hypot(op[0]-np_[0], op[1]-np_[1])
                    if d < bd: bd, bi = d, i
                if bi >= 0 and bd < self.max_distance:
                    matched[tid] = bi; used.add(bi)
            for tid in ids:
                if tid in matched:
                    x, y = centroids[matched[tid]]
                    kf = self.kalman[tid]
                    kf.correct(np.array([[x],[y]], np.float32))
                    p = kf.predict()
                    self.objects[tid] = (float(p[0]), float(p[1]))
                    self.disappeared[tid] = 0
                else:
                    self.disappeared[tid] += 1
                    p = self.kalman[tid].predict()
                    self.objects[tid] = (float(p[0]), float(p[1]))
                    if self.disappeared[tid] > self.max_disappeared:
                        self._deregister(tid)
            for i, c in enumerate(centroids):
                if i not in used: self._register(*c)
        return dict(self.objects)

# ── YOLO ────────────────────────────────────────────────────────────────────────
def load_yolo(model_path=None):
    try:
        from ultralytics import YOLO
        m = YOLO(model_path or os.environ.get('YOLO_MODEL_PATH', 'yolov8n.pt'))
        log.info(f'YOLO loaded: {model_path or "yolov8n.pt"}')
        return m
    except Exception as e:
        log.warning(f'YOLO unavailable: {e}')
        return None

def classify_roi(model, frame, x1, y1, x2, y2):
    if model is None: return 'unknown', 1.0
    roi = frame[max(0,y1):y2, max(0,x1):x2]
    if roi.size == 0: return 'unknown', 0.0
    results = model(roi, verbose=False, conf=YOLO_CONF)
    if results and results[0].boxes and len(results[0].boxes):
        b = results[0].boxes[0]
        return results[0].names[int(b.cls[0])], float(b.conf[0])
    return 'unknown', 1.0

# ── Demo source ──────────────────────────────────────────────────────────────────
def demo_gen(w, h):
    t = 0
    while True:
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        # Two targets — primary Lissajous, secondary random drift
        x1 = int(w/2 + (w/3)*np.sin(t*0.7))
        y1 = int(h/2 + (h/3)*np.sin(t*1.1))
        x2 = int(w/2 + (w/4)*np.sin(t*1.3 + 1.5))
        y2 = int(h/2 + (h/4)*np.sin(t*0.9 + 0.8))
        cv2.circle(frame, (x1, y1), 6, (255, 255, 255), -1)
        cv2.circle(frame, (x2, y2), 4, (180, 180, 255), -1)
        cv2.putText(frame, 'DEMO', (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,200,200), 2)
        t += 0.05
        yield frame

# ── Main ─────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source',       default=os.environ.get('DETECT_SOURCE','demo'))
    ap.add_argument('--zmq',          default=DEFAULT_ZMQ)
    ap.add_argument('--camera-id',    type=int, default=int(os.environ.get('CAMERA_ID','1')))
    ap.add_argument('--no-yolo',      action='store_true', default=os.environ.get('DETECT_YOLO','true')=='false')
    ap.add_argument('--no-flow',      action='store_true', default=os.environ.get('DETECT_FLOW','true')=='false')
    ap.add_argument('--no-constel',   action='store_true', default=os.environ.get('DETECT_CONSTEL','true')=='false')
    ap.add_argument('--fisheye',      action='store_true', default=os.environ.get('DETECT_FISHEYE','false')=='true')
    ap.add_argument('--fisheye-fov',  type=float, default=float(os.environ.get('SPOTTER_HFOV','185')))
    ap.add_argument('--fisheye-proj', default='equidistant')
    ap.add_argument('--night',        action='store_true', default=os.environ.get('DETECT_NIGHT','true')=='true')
    ap.add_argument('--mask',         default=None)
    ap.add_argument('--constel-mask', default=os.environ.get('CONSTEL_MASK_PATH', None))
    ap.add_argument('--yolo-model',   default=os.environ.get('YOLO_MODEL_PATH', None))
    ap.add_argument('--show',         action='store_true', default=os.environ.get('DETECT_SHOW','false')=='true')
    args = ap.parse_args()

    pub     = make_pub(args.zmq)
    tracker = SimpleTracker()
    model   = None if args.no_yolo else load_yolo(args.yolo_model)

    # ── Optional modules ──────────────────────────────────────────────────────
    flow_tracker = OpticalFlowTracker() if not args.no_flow else None

    night_proc = NightModeProcessor() if args.night else None

    bg_sub = cv2.createBackgroundSubtractorMOG2(history=200, varThreshold=40, detectShadows=False)

    constel = None
    if not args.no_constel:
        constel = ConstellationMask(FRAME_W, FRAME_H)
        if args.constel_mask and constel.load(args.constel_mask):
            log.info(f'Constellation mask loaded from {args.constel_mask}')
        else:
            log.info('Constellation mask: sampling first 60 frames')

    dewarper = None
    if args.fisheye:
        dewarper = FisheyeDewarper(
            frame_w=FRAME_W, frame_h=FRAME_H,
            fov_deg=args.fisheye_fov,
            projection=args.fisheye_proj,
            output_w=FRAME_W, output_h=FRAME_H,
        )
        dewarper.build_maps()
        log.info(f'Fisheye dewarper: {args.fisheye_fov}° {args.fisheye_proj}')

    static_mask = None
    if args.mask and os.path.exists(args.mask):
        static_mask = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
        static_mask = cv2.resize(static_mask, (FRAME_W, FRAME_H))

    # ── Source ────────────────────────────────────────────────────────────────
    demo_mode = args.source.lower() == 'demo'
    if demo_mode:
        log.info('DEMO mode — synthetic targets')
        gen = demo_gen(FRAME_W*2, FRAME_H*2)
        cap = None
    else:
        src = int(args.source) if args.source.isdigit() else args.source
        cap = cv2.VideoCapture(src)
        if not cap.isOpened():
            log.error(f'Cannot open: {args.source}'); sys.exit(1)
        log.info(f'Source: {args.source}')

    frame_count = 0
    track_start = {}
    morph_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    while True:
        if demo_mode:
            raw = next(gen)
        else:
            ret, raw = cap.read()
            if not ret:
                time.sleep(0.1); continue

        frame_count += 1
        orig_h, orig_w = raw.shape[:2]

        # ── 1. Fisheye dewarp ──────────────────────────────────────────────
        if dewarper:
            raw = dewarper.dewarp(raw)

        # ── 2. Downscale ───────────────────────────────────────────────────
        small = cv2.resize(raw, (FRAME_W, FRAME_H))
        scale_x = orig_w / FRAME_W
        scale_y = orig_h / FRAME_H

        # ── 3. Night mode preprocessing ────────────────────────────────────
        if night_proc:
            small, night_meta = night_proc.process(small)
            # Re-tune MOG2 params based on light conditions
            if frame_count % 300 == 1:
                params = night_proc.get_bg_subtractor_params()
                bg_sub.setHistory(params['history'])
                bg_sub.setVarThreshold(params['varThreshold'])
        else:
            night_meta = {'is_night': False, 'luminance': 128, 'mode': 'day'}

        # ── 4. Constellation mask sampling ─────────────────────────────────
        if constel and not constel.ready:
            constel.add_frame(small)

        # ── 5. Background subtraction ──────────────────────────────────────
        grey    = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(grey, (5, 5), 0)
        fg      = bg_sub.apply(blurred)

        # ── 6. Apply masks ─────────────────────────────────────────────────
        if constel and constel.ready:
            fg = constel.apply(fg)
        if static_mask is not None:
            fg = cv2.bitwise_and(fg, static_mask)

        # ── 7. Morphology ──────────────────────────────────────────────────
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, morph_k)
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN,  morph_k)

        # ── 8. Contour detection ───────────────────────────────────────────
        contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        centroids = []
        blobs = []  # (cx_s, cy_s, ox1, oy1, ox2, oy2)

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < MIN_BLOB_AREA or area > MAX_BLOB_AREA: continue
            x, y, bw, bh = cv2.boundingRect(cnt)
            cx, cy = x + bw//2, y + bh//2
            centroids.append((cx, cy))
            blobs.append((cx, cy,
                int(x*scale_x), int(y*scale_y),
                int((x+bw)*scale_x), int((y+bh)*scale_y)))

        # ── 9. Tracker update ──────────────────────────────────────────────
        tracks = tracker.update(centroids)
        if flow_tracker: flow_tracker.tick()

        # ── 10. Classify + publish ─────────────────────────────────────────
        now_ms = int(time.time() * 1000)

        published_tids = set()
        for (cx_s, cy_s, ox1, oy1, ox2, oy2) in blobs:
            # Match to nearest track
            best_tid, best_d = None, float('inf')
            for tid, (tx, ty) in tracks.items():
                d = np.hypot(cx_s - tx, cy_s - ty)
                if d < best_d: best_d, best_tid = d, tid
            if best_tid is None or best_tid in published_tids: continue
            published_tids.add(best_tid)

            if best_tid not in track_start:
                track_start[best_tid] = now_ms

            # Optical flow
            flow_meta = {}
            if flow_tracker:
                fm = flow_tracker.update(str(best_tid), cx_s * scale_x, cy_s * scale_y)
                if fm: flow_meta = fm

            # YOLO classify
            cls_name, conf = classify_roi(model, raw, ox1, oy1, ox2, oy2)
            if cls_name in IGNORE_CLASSES and conf > 0.6: continue

            payload = {
                'track_id':        str(best_tid),
                'class':           cls_name,
                'confidence':      round(conf, 3),
                'centroid_x':      round(cx_s * scale_x),
                'centroid_y':      round(cy_s * scale_y),
                'bbox':            [ox1, oy1, ox2, oy2],
                'frame_w':         orig_w,
                'frame_h':         orig_h,
                'camera_id':       args.camera_id,
                'time_visible_ms': now_ms - track_start[best_tid],
                'ts':              now_ms,
                # Phase 2 enrichments
                'velocity_px':     flow_meta.get('velocity_px'),
                'vx':              flow_meta.get('vx'),
                'vy':              flow_meta.get('vy'),
                'anomaly_flag':    flow_meta.get('anomaly_flag', False),
                'anomaly_reason':  flow_meta.get('anomaly_reason'),
                'trajectory_score':flow_meta.get('trajectory_score', 1.0),
                'night_mode':      night_meta.get('mode'),
                'luminance':       night_meta.get('luminance'),
            }
            publish(pub, payload)

            if args.show:
                col = (0,0,255) if flow_meta.get('anomaly_flag') else (0,200,100) if cls_name != 'unknown' else (200,200,0)
                cv2.rectangle(raw, (ox1,oy1), (ox2,oy2), col, 2)
                label = f'{cls_name} {conf:.2f} [{best_tid}]'
                if flow_meta.get('velocity_px'): label += f' {flow_meta["velocity_px"]:.1f}px'
                if flow_meta.get('anomaly_flag'): label += ' ⚠'
                cv2.putText(raw, label, (ox1, oy1-6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)

        if args.show:
            cv2.putText(raw, f'{night_meta.get("mode","").upper()} luma:{night_meta.get("luminance",0):.0f}',
                (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0,200,200), 2)
            cv2.imshow('RAPTOR', raw)
            cv2.imshow('FG', fg)
            if cv2.waitKey(1) & 0xFF == ord('q'): break

    if cap: cap.release()
    cv2.destroyAllWindows()
    pub.close()

if __name__ == '__main__':
    main()
