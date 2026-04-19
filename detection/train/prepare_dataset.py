#!/usr/bin/env python3
"""
Dataset Preparation for Custom Sky Model
==========================================
Converts RAPTOR recorded clips + detection CSVs into YOLO annotation format
for fine-tuning YOLOv8 on sky-specific data.

Classes:
  0: aircraft
  1: bird
  2: satellite
  3: drone
  4: uap_candidate
  5: insect
  6: balloon

Usage:
  python prepare_dataset.py --clips-dir ../../recordings --output-dir ./dataset
  python prepare_dataset.py --clips-dir ../../recordings --output-dir ./dataset --split 0.8
"""
import argparse
import json
import os
import random
import shutil
from pathlib import Path

import cv2
import numpy as np

CLASS_MAP = {
    'aircraft':      0,
    'bird':          1,
    'satellite':     2,
    'drone':         3,
    'uap_candidate': 4,
    'uap':           4,  # alias
    'unknown':       4,  # treat unknown as UAP candidate
    'insect':        5,
    'balloon':       6,
}

YAML_TEMPLATE = """
path: {dataset_path}
train: images/train
val:   images/val

nc: 7
names:
  0: aircraft
  1: bird
  2: satellite
  3: drone
  4: uap_candidate
  5: insect
  6: balloon
"""


def extract_frames(clip_path: Path, bbox: list, cls_id: int, output_dir: Path, max_frames: int = 10):
    """Extract annotated frames from a clip."""
    cap = cv2.VideoCapture(str(clip_path))
    if not cap.isOpened():
        print(f'  [!] Cannot open {clip_path}')
        return 0

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    step = max(1, total // max_frames)
    count = 0
    frame_idx = 0

    (output_dir / 'images').mkdir(parents=True, exist_ok=True)
    (output_dir / 'labels').mkdir(parents=True, exist_ok=True)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % step == 0 and count < max_frames:
            stem = f'{clip_path.stem}_f{frame_idx:05d}'
            # Save image
            cv2.imwrite(str(output_dir / 'images' / f'{stem}.jpg'), frame)
            # Save YOLO label: class cx cy w h (normalised)
            x1, y1, x2, y2 = bbox
            cx = ((x1 + x2) / 2) / w
            cy = ((y1 + y2) / 2) / h
            bw = (x2 - x1) / w
            bh = (y2 - y1) / h
            with open(output_dir / 'labels' / f'{stem}.txt', 'w') as f:
                f.write(f'{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n')
            count += 1
        frame_idx += 1

    cap.release()
    return count


def main():
    parser = argparse.ArgumentParser(description='RAPTOR Dataset Preparation')
    parser.add_argument('--clips-dir',  required=True, help='Directory containing recorded clips')
    parser.add_argument('--output-dir', required=True, help='Output dataset directory')
    parser.add_argument('--split',      type=float, default=0.8, help='Train/val split ratio')
    parser.add_argument('--max-frames', type=int,   default=10,  help='Max frames to extract per clip')
    args = parser.parse_args()

    clips_dir  = Path(args.clips_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    train_dir = output_dir / 'train'
    val_dir   = output_dir / 'val'
    train_dir.mkdir(exist_ok=True)
    val_dir.mkdir(exist_ok=True)

    clips = list(clips_dir.glob('track_*.mp4'))
    if not clips:
        print(f'No clips found in {clips_dir}')
        return

    print(f'Found {len(clips)} clips')
    total_frames = 0

    for clip in clips:
        # Parse class from filename: track_<id>_<class>_<ts>.mp4
        parts = clip.stem.split('_')
        cls_name = parts[2] if len(parts) > 2 else 'unknown'
        cls_id = CLASS_MAP.get(cls_name.lower(), 4)

        # Placeholder bbox — in production, load from event CSV
        bbox = [0, 0, 100, 100]  # Will be overridden by CSV data if available

        # Check for companion CSV
        csv_path = clip.with_suffix('.json')
        if csv_path.exists():
            with open(csv_path) as f:
                meta = json.load(f)
                bbox = meta.get('bbox', bbox)

        dest = train_dir if random.random() < args.split else val_dir
        n = extract_frames(clip, bbox, cls_id, dest, args.max_frames)
        total_frames += n
        print(f'  {clip.name} → {cls_name} (cls {cls_id}): {n} frames')

    # Write dataset YAML
    yaml_content = YAML_TEMPLATE.format(dataset_path=str(output_dir.resolve()))
    with open(output_dir / 'dataset.yaml', 'w') as f:
        f.write(yaml_content.strip())

    print(f'\n✓ Dataset ready: {total_frames} frames in {output_dir}')
    print(f'  Run: python train.py --data {output_dir}/dataset.yaml')


if __name__ == '__main__':
    main()
