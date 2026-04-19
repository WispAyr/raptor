#!/usr/bin/env python3
"""
YOLOv8 Fine-Tuning Script for RAPTOR Sky Model
================================================
Fine-tunes YOLOv8 on a RAPTOR sky-specific dataset prepared by prepare_dataset.py.
Supports CPU, MPS (Apple Silicon), and CUDA acceleration.

Usage:
  python train.py --data ./dataset/dataset.yaml
  python train.py --data ./dataset/dataset.yaml --model yolov8s.pt --epochs 100
  python train.py --data ./dataset/dataset.yaml --resume  # resume interrupted training
"""
import argparse
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='RAPTOR YOLOv8 Training')
    parser.add_argument('--data',    required=True,              help='Path to dataset.yaml')
    parser.add_argument('--model',   default='yolov8n.pt',       help='Base model (yolov8n/s/m/l/x.pt)')
    parser.add_argument('--epochs',  type=int, default=50,       help='Training epochs')
    parser.add_argument('--imgsz',   type=int, default=640,      help='Image size')
    parser.add_argument('--batch',   type=int, default=16,       help='Batch size (-1 = auto)')
    parser.add_argument('--device',  default='',                 help='Device: cpu / mps / 0 (GPU) / "" (auto)')
    parser.add_argument('--resume',  action='store_true',        help='Resume training from last checkpoint')
    parser.add_argument('--name',    default='raptor-sky',       help='Run name')
    parser.add_argument('--project', default='./runs/train',     help='Output directory')
    args = parser.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print('ERROR: ultralytics not installed. Run: pip install ultralytics')
        sys.exit(1)

    data_path = Path(args.data)
    if not data_path.exists():
        print(f'ERROR: Dataset not found: {data_path}')
        print('Run prepare_dataset.py first.')
        sys.exit(1)

    # Auto-detect device
    device = args.device
    if not device:
        try:
            import torch
            if torch.cuda.is_available():
                device = '0'
                print('Using CUDA GPU')
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                device = 'mps'
                print('Using Apple MPS')
            else:
                device = 'cpu'
                print('Using CPU')
        except ImportError:
            device = 'cpu'

    if args.resume:
        # Find latest checkpoint
        last_ckpt = Path(args.project) / args.name / 'weights' / 'last.pt'
        if last_ckpt.exists():
            model = YOLO(str(last_ckpt))
            print(f'Resuming from {last_ckpt}')
        else:
            print(f'No checkpoint found at {last_ckpt}. Starting fresh.')
            model = YOLO(args.model)
    else:
        model = YOLO(args.model)
        print(f'Base model: {args.model}')

    print(f'Dataset: {args.data}')
    print(f'Epochs:  {args.epochs} | Batch: {args.batch} | Device: {device}')
    print('─' * 50)

    results = model.train(
        data=str(data_path),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        name=args.name,
        project=args.project,
        resume=args.resume,
        # Sky-specific augmentation
        flipud=0.0,     # Don't flip vertically — sky is always above
        fliplr=0.5,     # Horizontal flip OK
        mosaic=0.5,     # Reduced mosaic for small-object sky data
        degrees=10.0,   # Slight rotation augmentation
        scale=0.3,      # Scale augmentation
        hsv_h=0.01,     # Low hue shift (sky colour is important)
        hsv_s=0.3,
        hsv_v=0.4,
        conf=0.3,       # Lower confidence threshold for sky objects
        iou=0.5,
    )

    print('\n✓ Training complete')
    best = Path(results.save_dir) / 'weights' / 'best.pt'
    print(f'  Best model: {best}')
    print(f'  To use: set YOLO_MODEL_PATH={best} in .env and restart RAPTOR')


if __name__ == '__main__':
    main()
