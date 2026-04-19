# RAPTOR Hardware Deployment Guide

## Overview

RAPTOR runs on any hardware from a MacBook Pro to a Raspberry Pi to a server rack.
Select the appropriate profile and config for your setup.

---

## Setup Profiles Quick Reference

| Profile | Hardware Needed | Use Case |
|---|---|---|
| `minimal` | None (demo mode) | Development and testing |
| `single` | 1× PTZ camera | Simple autonomous sky tracker |
| `dual` | 1× wide-angle + 1× PTZ | Sky360-style spotter+tracker |
| `station` | Full sensor pod | Remote station in multi-station network |
| `hub` | Server only | Mission control aggregation point |
| `full` | All hardware | Maximum capability deployment |

Set `RAPTOR_PROFILE=<name>` in `.env` to activate.

---

## Camera Hardware

### PTZ Cameras (Tracker)
Any camera supporting ONVIF Profile S, Axis VAPIX, or VISCA-over-IP.

Recommended models:
- **Axis P5655-E** — outdoor PTZ, 32× optical zoom, VAPIX
- **Hanwha QNP-9300RW** — 30× zoom, ONVIF, weatherproof
- **PTZOptics PT30X-SDI** — VISCA-over-IP, broadcast-grade
- **Hikvision DS-2DE4425IWG-E** — budget ONVIF, 25× zoom

### Wide-Field / Spotter Cameras
- **Axis M3106-L Mk II** — wide-angle dome, ONVIF
- **Reolink RLC-810A** — wide-angle outdoor, RTSP
- **Insta360 Link** — USB wide-angle (use with OpenCV local source)
- Any fisheye dome camera — set `SPOTTER_FISHEYE=true` + calibrate

---

## Compute Hardware

### Development (macOS)
- Runs natively — Apple MPS accelerates YOLOv8 inference
- No special configuration needed
- `RAPTOR_PROFILE=minimal` or `single`

### Raspberry Pi 5 (8GB)
- Use `configs/rpi5.env`
- Copy to `.env`: `cp configs/rpi5.env .env`
- ONNX Runtime for 15fps YOLOv8n inference on CPU
- USB 3.0 SSD recommended for recording storage
- PoE+ HAT for clean outdoor installation

### NVIDIA Jetson Nano / Orin
- Use `configs/jetson.env`
- TensorRT model export for 30-60fps inference
- `sudo docker compose up` with GPU passthrough enabled
- Native NVMe for storage

### Server / NUC (Intel/AMD)
- Standard `single` or `full` profile
- CUDA GPU optional but significantly improves detection speed
- Runs all services in Docker Compose

---

## Outdoor Enclosure (IP66 / NEMA 4X)

For permanent outdoor installation matching UFODAP MSDAU spec:

### Enclosure Sizing
- **Minimum**: 300×200×150mm for Pi 5 + PoE injector
- **Recommended**: 400×300×200mm for Pi 5 + SDR dongle + GPS module

### Power
- PoE+ (802.3at, 30W) for compute + camera over single Cat6 cable
- Solar option: 20W panel + 20Ah LiPo battery for off-grid deployment

### Connectivity
- Cat6 run to camera (PoE)
- Cat6 or Wi-Fi back to network
- 4G/LTE modem for remote sites

### Thermal Management
- Passive: aluminium heatsink plate on enclosure wall
- Active: 12V fan triggered by GPIO temperature sensor (>65°C)
- Operating range: -20°C to +60°C with appropriate enclosure

### Cable Entry
- IP68-rated glands for power and network cables
- Silica gel desiccant pack inside enclosure

---

## Network Architecture

```
Internet / WAN
      │
      │ (optional: VPN tunnel to Mission Control hub)
      │
┌─────┴──────────────────────────────────────────────┐
│                  Local Network                      │
│                                                     │
│  [PTZ Camera]──PoE──[Switch]──[RAPTOR Compute]      │
│  [Spotter Cam]─────────┘                            │
│                         │                           │
│                    [Operator PC]                    │
│                    http://raptor:80                 │
└─────────────────────────────────────────────────────┘
```

---

## Quick Start: Single PTZ Camera

```bash
# 1. Install dependencies
npm install
pip install -r detection/requirements.txt

# 2. Configure
cp .env.example .env
# Edit .env:
#   RAPTOR_PROFILE=single
#   DETECT_SOURCE=rtsp://admin:pass@192.168.1.100/stream1

# 3. Add camera to database (after first boot)
curl -X POST http://localhost:3000/api/cameras \
  -H 'Content-Type: application/json' \
  -d '{"name":"Rooftop PTZ","protocol":"onvif","host":"192.168.1.100","port":80,"username":"admin","password":"pass"}'

# 4. Start
npm run dev
# In another terminal:
cd detection && python detector.py --source rtsp://admin:pass@192.168.1.100/stream1
```

## Quick Start: Docker

```bash
cp .env.example .env
# Edit .env with your camera settings
docker compose up
# Dashboard: http://localhost:80
```

## Quick Start: Dual Camera (Sky360-style)

```bash
# Edit .env:
#   RAPTOR_PROFILE=dual
#   SPOTTER_RTSP=rtsp://admin:pass@192.168.1.101/stream1   ← wide-angle
#   DETECT_SOURCE=$SPOTTER_RTSP
#   SPOTTER_HFOV=90
#   SPOTTER_HOME_AZ=0
#   DUAL_CAMERA=true

npm run dev
cd detection && python detector.py --source $SPOTTER_RTSP
```
