import React, { useState, useCallback } from 'react';
import '../index.css';
import { useWebSocket, WSMessage } from '../hooks/useWebSocket';
import CameraList from './CameraList';
import VideoPanel from './VideoPanel';
import SkyMap from './SkyMap';
import PTZJoystick from './PTZJoystick';
import EventLog from './EventLog';

export interface Camera {
  id: number;
  name: string;
  protocol: string;
  host: string;
  port: number;
  stream_url?: string;
  snapshot_url?: string;
  active: number;
}

export interface TrackingState {
  active: boolean;
  cameraId: number | null;
  trackId: string | null;
  targetClass: string | null;
  confidence: number;
  centroid: { x: number; y: number };
  mode: 'tracking' | 'patrol' | 'manual';
}

export interface DetectionEvent {
  id?: number;
  track_id: string;
  class: string;
  confidence: number;
  centroid_x: number;
  centroid_y: number;
  frame_w?: number;
  frame_h?: number;
  time_visible_ms?: number;
  ts?: number;
  created_at?: string;
}

type View = 'cameras' | 'tracking' | 'events' | 'patrol';

export default function App() {
  const [view, setView] = useState<View>('tracking');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [tracking, setTracking] = useState<TrackingState>({
    active: false, cameraId: null, trackId: null, targetClass: null,
    confidence: 0, centroid: { x: 0, y: 0 }, mode: 'patrol',
  });
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const { send } = useWebSocket(
    `ws://${window.location.hostname}:3000`,
    {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg: WSMessage) => handleWSMessage(msg),
    }
  );

  const handleWSMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'state':
        if (msg.cameras) setCameras(msg.cameras as Camera[]);
        if (msg.tracking) setTracking(msg.tracking as TrackingState);
        break;
      case 'tracking':
        setTracking(msg.state as TrackingState);
        break;
      case 'detection':
        setEvents(prev => [msg as unknown as DetectionEvent, ...prev].slice(0, 500));
        break;
    }
  }, []);

  const selectCamera = useCallback((cam: Camera) => {
    setSelectedCamera(cam);
    send({ type: 'camera:select', cameraId: cam.id });
  }, [send]);

  const setMode = useCallback((mode: 'tracking' | 'patrol' | 'manual') => {
    send({ type: 'mode:set', mode });
  }, [send]);

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="header">
        <div className="header-logo">
          <div className="raptor-icon">🦅</div>
          <span>RAPTOR</span>
        </div>
        <span className="text-muted text-xs" style={{ marginLeft: 4, letterSpacing: '0.05em' }}>
          Real-time Autonomous PTZ Tracking
        </span>

        {/* Mode switcher */}
        <div className="flex gap-2" style={{ marginLeft: 24 }}>
          {(['tracking', 'patrol', 'manual'] as const).map(m => (
            <button
              key={m}
              id={`mode-${m}`}
              className={`btn ${tracking.mode === m ? 'btn-primary' : 'btn-ghost'}`}
              style={{ padding: '5px 12px', fontSize: 11 }}
              onClick={() => setMode(m)}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Status */}
        <div className="header-status">
          <div className={`status-dot ${connected ? (tracking.active ? 'tracking' : 'connected') : ''}`} />
          <span>{!connected ? 'Disconnected' : tracking.active ? `TRACKING · ${tracking.targetClass ?? '?'} ${(tracking.confidence * 100).toFixed(0)}%` : 'Standby'}</span>
          {selectedCamera && (
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
              📷 {selectedCamera.name}
            </span>
          )}
        </div>
      </header>

      {/* Sidebar */}
      <nav className="sidebar">
        <span className="sidebar-section-label">Navigation</span>
        {([
          { id: 'tracking', icon: '🎯', label: 'Live Tracking' },
          { id: 'cameras',  icon: '📷', label: 'Cameras' },
          { id: 'events',   icon: '📋', label: 'Events' },
          { id: 'patrol',   icon: '🔄', label: 'Patrol' },
        ] as const).map(item => (
          <button
            key={item.id}
            id={`nav-${item.id}`}
            className={`nav-item ${view === item.id ? 'active' : ''}`}
            onClick={() => setView(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}

        <span className="sidebar-section-label" style={{ marginTop: 8 }}>Cameras</span>
        {cameras.map(cam => (
          <button
            key={cam.id}
            id={`cam-select-${cam.id}`}
            className={`nav-item ${selectedCamera?.id === cam.id ? 'active' : ''}`}
            onClick={() => selectCamera(cam)}
          >
            <span className="nav-icon">📡</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cam.name}
            </span>
          </button>
        ))}

        {/* Stats at bottom */}
        <div style={{ marginTop: 'auto', padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
          <div className="flex justify-between">
            <span>Events</span><span className="text-accent">{events.length}</span>
          </div>
          <div className="flex justify-between" style={{ marginTop: 4 }}>
            <span>Cameras</span><span>{cameras.length}</span>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main className="main">
        {view === 'tracking' && (
          <>
            {/* Video + overlay — top left */}
            <div className="panel" style={{ gridRow: '1 / 3' }}>
              <div className="panel-header">
                <span className="panel-title">Live Feed</span>
                {selectedCamera && <span className="text-xs text-muted">{selectedCamera.host}</span>}
                <span className={`panel-badge ${tracking.active ? 'active' : ''}`}>
                  {tracking.active ? 'TRACKING' : 'MONITOR'}
                </span>
              </div>
              <div className="panel-body">
                <VideoPanel camera={selectedCamera} tracking={tracking} />
              </div>
            </div>

            {/* Sky Map — top right */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">Sky Map</span>
                <span className="panel-badge">AZ / EL</span>
              </div>
              <div className="panel-body">
                <SkyMap tracking={tracking} events={events.slice(0, 30)} />
              </div>
            </div>

            {/* PTZ Joystick — bottom right */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">PTZ Control</span>
                <span className={`panel-badge ${tracking.mode === 'manual' ? 'active' : ''}`}>
                  {tracking.mode.toUpperCase()}
                </span>
              </div>
              <div className="panel-body">
                <PTZJoystick send={send} cameraId={selectedCamera?.id ?? null} mode={tracking.mode} />
              </div>
            </div>
          </>
        )}

        {view === 'cameras' && (
          <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
            <div className="panel-header"><span className="panel-title">Camera Registry</span></div>
            <div className="panel-body overflow-auto">
              <CameraList
                cameras={cameras}
                onRefresh={() => fetch('/api/cameras').then(r => r.json()).then(setCameras)}
                selectedId={selectedCamera?.id}
                onSelect={selectCamera}
              />
            </div>
          </div>
        )}

        {view === 'events' && (
          <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
            <div className="panel-header">
              <span className="panel-title">Detection Events</span>
              <span className="panel-badge">{events.length} total</span>
            </div>
            <div className="panel-body overflow-auto">
              <EventLog events={events} />
            </div>
          </div>
        )}

        {view === 'patrol' && (
          <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
            <div className="panel-header"><span className="panel-title">Patrol Configuration</span></div>
            <div className="panel-body p-4">
              <p className="text-secondary text-sm">
                Configure patrol presets and dwell times. The camera will cycle through positions when no target is detected.
              </p>
              <div style={{ marginTop: 16, padding: 24, background: 'var(--bg-elevated)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', textAlign: 'center', color: 'var(--text-muted)' }}>
                Patrol preset editor — coming soon
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
