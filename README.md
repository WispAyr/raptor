# RAPTOR 🦅
### Real-time Autonomous PTZ Tracking and Object Recognition

RAPTOR is an open-source sky surveillance and PTZ camera control system. It detects and tracks moving objects in the sky — aircraft, drones, and unidentified aerial phenomena — using a combination of classical computer vision and AI classification, then commands PTZ cameras to automatically follow targets in real-time using a PID closed-loop controller.

Inspired by [UFODAP/OTDAU](https://ufodap.com/technology) and the [Sky360](https://sky360.org) citizen science project.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     RAPTOR System                          │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Wide-Field  │    │  Detection   │    │  PTZ Camera  │  │
│  │  IP Camera   │───▶│  Engine (Py) │───▶│  Controller  │  │
│  │  (RTSP)      │    │  YOLOv8 +    │    │  ONVIF/VAPIX │  │
│  └──────────────┘    │  Kalman      │    └──────┬───────┘  │
│                      └──────┬───────┘           │          │
│                             │ ZeroMQ            │ PID Loop │
│                             ▼                   ▼          │
│                      ┌──────────────────────────────────┐  │
│                      │     Node.js Backend              │  │
│                      │  Express + WebSocket + SQLite    │  │
│                      └──────────────┬───────────────────┘  │
│                                     │ WebSocket             │
│                                     ▼                       │
│                      ┌──────────────────────────────────┐  │
│                      │     Operator Dashboard           │  │
│                      │     React + Vite + D3            │  │
│                      │  · Live feed + overlay           │  │
│                      │  · Sky map (az/el polar)         │  │
│                      │  · PTZ joystick                  │  │
│                      │  · Event log                     │  │
│                      └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Features

| Feature | Description |
|---|---|
| **Multi-protocol PTZ control** | ONVIF (universal) and Axis VAPIX support |
| **Sky360-style detection pipeline** | Resize → blur → MOG2 background subtraction → blob detection → Kalman tracking |
| **YOLOv8 classification** | Filters birds, aircraft from true unknowns |
| **PID closed-loop tracking** | Smooth pan/tilt control with anti-windup, deadband, derivative kick prevention |
| **Touring / Patrol mode** | Cycles through up to 16 PTZ presets; pauses automatically on detection |
| **Event recording** | ffmpeg clip recording per track + CSV export of all camera movements |
| **Sky map** | Real-time azimuth/elevation polar plot (D3.js) |
| **Virtual joystick** | Touch + mouse PTZ control in manual mode |
| **SQLite persistence** | Camera registry, detection events, presets |

---

## Quick Start

### Prerequisites

- Node.js 20+
- Python 3.10+
- ffmpeg (for clip recording)
- An ONVIF or Axis VAPIX PTZ camera (or use demo mode)

### 1. Install dependencies

```bash
# Node.js (backend + frontend)
npm install

# Python detection engine
pip install -r detection/requirements.txt
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your camera credentials and settings
```

### 3. Run

```bash
# Start backend + frontend dev servers
npm run dev

# In a separate terminal — start the detection engine
# Option A: Use a real RTSP camera
npm run detect -- --source rtsp://admin:pass@192.168.1.100/stream1

# Option B: Demo mode (synthetic moving target — no camera required)
npm run detect -- --source demo

# Option C: Webcam
npm run detect -- --source 0
```

Open **http://localhost:5173** in your browser.

---

## Detection Pipeline

The Python detector (`detection/detector.py`) follows the Sky360/SimpleTracker approach:

1. **Downscale** frame to 640×360 for fast processing
2. **Greyscale + Gaussian blur** to reduce noise
3. **MOG2 background subtraction** to isolate moving objects
4. **Morphological cleanup** (open/close) to remove speckle
5. **Contour detection** + area filtering (configurable min/max blob size)
6. **Kalman filter tracker** for stable track IDs across frames
7. **YOLOv8 classification** on each blob ROI to filter false positives
8. **ZeroMQ PUB** — publish detection events to the Node.js backend

### Optional detection mask

Create a grayscale PNG mask (white = detect here, black = ignore) and pass it with `--mask mask.png`. Useful for excluding tree lines, buildings, or streetlights from detection.

---

## PTZ Control

### Supported protocols

| Protocol | Library | Use case |
|---|---|---|
| **ONVIF Profile S** | `onvif` npm package | Any standard ONVIF camera |
| **Axis VAPIX** | Custom HTTP client | Axis P/Q series cameras |

### PID Controller

The PID controller converts pixel error (distance of target centroid from frame centre) into normalised pan/tilt velocity commands:

```
error (pixels) → normalise → PID(Kp, Ki, Kd) → velocity (-1..+1) → PTZ command
```

Tune `PID_PAN_KP`, `PID_PAN_KI`, `PID_PAN_KD` (and tilt equivalents) in `.env`.

---

## Project Structure

```
raptor/
├── backend/
│   ├── server.js               # Express + WebSocket hub
│   ├── controllers/
│   │   ├── onvif.js            # ONVIF PTZ control
│   │   ├── vapix.js            # Axis VAPIX control
│   │   └── pid.js              # PID controller
│   ├── services/
│   │   ├── patrol.js           # Touring/patrol manager
│   │   └── recorder.js         # Event + clip recording
│   └── bridge/
│       └── zmq-bridge.js       # ZeroMQ → Node bridge
├── detection/
│   ├── detector.py             # Main detection engine
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── App.tsx
│       │   ├── VideoPanel.tsx  # Snapshot feed + tracking overlay
│       │   ├── SkyMap.tsx      # Az/El polar plot
│       │   ├── PTZJoystick.tsx # Virtual joystick
│       │   ├── EventLog.tsx    # Detection event table
│       │   └── CameraList.tsx  # Camera registry
│       └── hooks/
│           └── useWebSocket.ts # Auto-reconnect WS hook
└── docs/
    ├── ARCHITECTURE.md
    ├── API.md
    └── SETUP.md
```

---

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cameras` | List all cameras |
| `POST` | `/api/cameras` | Register a new camera |
| `DELETE` | `/api/cameras/:id` | Remove camera |
| `GET` | `/api/cameras/:id/snapshot` | Live JPEG snapshot |
| `GET` | `/api/cameras/:id/status` | PTZ position + move status |
| `POST` | `/api/cameras/:id/ptz/move` | Continuous move `{pan, tilt, zoom}` |
| `POST` | `/api/cameras/:id/ptz/stop` | Stop all movement |
| `POST` | `/api/cameras/:id/ptz/absolute` | Absolute move `{pan, tilt, zoom}` |
| `GET` | `/api/cameras/:id/presets` | List PTZ presets |
| `POST` | `/api/cameras/:id/presets/:token/goto` | Go to preset |
| `GET` | `/api/events` | Detection event log |
| `GET` | `/api/tracking` | Current tracking state |
| `GET` | `/api/patrol` | Patrol status |
| `POST` | `/api/patrol/start` | Start patrol |
| `POST` | `/api/patrol/stop` | Pause patrol |

## WebSocket Events

Connect to `ws://localhost:3000`.

| Event (server → client) | Payload |
|---|---|
| `state` | Initial state: cameras + tracking |
| `tracking` | Tracking state update |
| `detection` | New detection event |
| `patrol` | Patrol state change |

| Command (client → server) | Payload |
|---|---|
| `ptz:move` | `{cameraId, pan, tilt, zoom}` |
| `ptz:stop` | `{cameraId}` |
| `ptz:preset` | `{cameraId, presetToken}` |
| `mode:set` | `{mode: 'tracking'|'patrol'|'manual'}` |
| `camera:select` | `{cameraId}` |

---

## References & Inspiration

- [UFODAP / OTDAU](https://ufodap.com/technology) — UAP data acquisition system with PTZ tracking
- [Sky360](https://sky360.org) — Open-source citizen science sky observatory
- [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics)
- [agsh/onvif](https://github.com/agsh/onvif) — Node.js ONVIF library

---

## Licence

MIT
