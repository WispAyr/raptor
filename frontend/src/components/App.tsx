import React, { useState, useCallback, useRef } from 'react';
import '../index.css';
import { useWebSocket, WSMessage } from '../hooks/useWebSocket';
import CameraList from './CameraList';
import VideoPanel from './VideoPanel';
import SkyMap from './SkyMap';
import PTZJoystick from './PTZJoystick';
import EventLog from './EventLog';
import AlertBanner from './AlertBanner';
import FusionPanel from './FusionPanel';

export interface Camera {
  id: number; name: string; protocol: string;
  host: string; port: number;
  stream_url?: string; snapshot_url?: string; active: number;
}

export interface TrackingState {
  active: boolean; cameraId: number | null; trackId: string | null;
  targetClass: string | null; confidence: number;
  centroid: { x: number; y: number };
  az: number | null; el: number | null; bearing: string | null;
  mode: 'tracking' | 'patrol' | 'manual';
  alertLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  fusionScore?: number;
}

export interface DetectionEvent {
  id?: number; track_id: string; class: string; confidence: number;
  centroid_x: number; centroid_y: number;
  az?: number; el?: number; bearing?: string;
  velocity_px?: number; anomaly_flag?: boolean; trajectory_score?: number;
  alert_level?: string; adsb_corroborated?: boolean; adsb_callsign?: string;
  frame_w?: number; frame_h?: number; time_visible_ms?: number;
  ts?: number; created_at?: string;
}

export interface Aircraft {
  icao: string; callsign: string; lat: number; lon: number;
  altFt: number; speedKts: number; bearing: number; elevDeg: number; distNm: number;
}

export interface FusionEvent {
  track_id: string; alert_level: string; score: number;
  visual?: DetectionEvent; rf?: object; magnetic?: object;
}

export interface WeatherData {
  temperature_c: number; windspeed: number; cloudcover_pct: number;
  visibility_m: number; is_daytime: boolean; fp_risk: number; fetched_at: string;
}

type View = 'tracking' | 'cameras' | 'events' | 'patrol' | 'intelligence';

const ALERT_COLOUR: Record<string, string> = {
  CRITICAL: '#ff3b5c', HIGH: '#e8531a', MEDIUM: '#f5a623', LOW: '#2adc8c',
};

export default function App() {
  const [view, setView]                   = useState<View>('tracking');
  const [cameras, setCameras]             = useState<Camera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [tracking, setTracking]           = useState<TrackingState>({
    active: false, cameraId: null, trackId: null, targetClass: null,
    confidence: 0, centroid: { x: 0, y: 0 }, az: null, el: null, bearing: null,
    mode: 'patrol', alertLevel: 'LOW',
  });
  const [events, setEvents]       = useState<DetectionEvent[]>([]);
  const [aircraft, setAircraft]   = useState<Aircraft[]>([]);
  const [fusion, setFusion]       = useState<FusionEvent[]>([]);
  const [weather, setWeather]     = useState<WeatherData | null>(null);
  const [connected, setConnected] = useState(false);
  const [alert, setAlert]         = useState<{ level: string; msg: string } | null>(null);
  const alertTimer                = useRef<ReturnType<typeof setTimeout>>();

  const showAlert = useCallback((level: string, msg: string) => {
    setAlert({ level, msg });
    clearTimeout(alertTimer.current);
    alertTimer.current = setTimeout(() => setAlert(null), level === 'CRITICAL' ? 8000 : 5000);
  }, []);

  const { send } = useWebSocket(
    `ws://${window.location.hostname}:${window.location.port || 3000}`,
    {
      onOpen:  () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (msg: WSMessage) => {
        switch (msg.type) {
          case 'state':
            if (msg.cameras)  setCameras(msg.cameras as Camera[]);
            if (msg.tracking) setTracking(msg.tracking as TrackingState);
            if (msg.adsb)     setAircraft(msg.adsb as Aircraft[]);
            if (msg.weather)  setWeather(msg.weather as WeatherData);
            break;
          case 'tracking':
            setTracking(msg.state as TrackingState);
            break;
          case 'detection':
            setEvents(prev => [msg as unknown as DetectionEvent, ...prev].slice(0, 500));
            break;
          case 'fusion': {
            const fev = msg as unknown as FusionEvent;
            setFusion(prev => {
              const idx = prev.findIndex(f => f.track_id === fev.track_id);
              const next = [...prev];
              idx >= 0 ? next[idx] = fev : next.unshift(fev);
              return next.slice(0, 50);
            });
            if (fev.alert_level === 'HIGH' || fev.alert_level === 'CRITICAL') {
              const v = fev.visual;
              showAlert(fev.alert_level,
                `${fev.alert_level} contact · ${v?.class ?? 'unknown'} · az ${v?.az ?? '?'}° el ${v?.el ?? '?'}° · score ${fev.score.toFixed(1)}`
              );
            }
            break;
          }
          case 'adsb':
            setAircraft(msg.aircraft as Aircraft[]);
            break;
          case 'weather':
            setWeather(msg.data as WeatherData);
            break;
          case 'handoff':
            if ((msg as any).phase === 'tracking') {
              showAlert('LOW', `Spotter hand-off complete — PTZ tracking #${(msg as any).track_id}`);
            }
            break;
        }
      },
    }
  );

  const selectCamera = useCallback((cam: Camera) => {
    setSelectedCamera(cam);
    send({ type: 'camera:select', cameraId: cam.id });
  }, [send]);

  const setMode = useCallback((mode: 'tracking' | 'patrol' | 'manual') => {
    send({ type: 'mode:set', mode });
  }, [send]);

  const alertLevel = tracking.alertLevel || 'LOW';
  const alertCol   = ALERT_COLOUR[alertLevel] || '#2adc8c';

  const navItems: { id: View; icon: string; label: string }[] = [
    { id: 'tracking',     icon: '🎯', label: 'Live Tracking' },
    { id: 'intelligence', icon: '🔬', label: 'Intelligence' },
    { id: 'cameras',      icon: '📷', label: 'Cameras' },
    { id: 'events',       icon: '📋', label: 'Events' },
    { id: 'patrol',       icon: '🔄', label: 'Patrol' },
  ];

  return (
    <div className="app-shell">
      {/* Alert banner */}
      {alert && (
        <AlertBanner level={alert.level} message={alert.msg} onDismiss={() => setAlert(null)} />
      )}

      {/* Header */}
      <header className="header">
        <div className="header-logo">
          <div className="raptor-icon">🦅</div>
          <span>RAPTOR</span>
        </div>
        <span className="text-muted text-xs" style={{ marginLeft: 4, letterSpacing: '0.05em' }}>
          Autonomous Sky Surveillance
        </span>

        {/* Mode switcher */}
        <div className="flex gap-2" style={{ marginLeft: 24 }}>
          {(['tracking', 'patrol', 'manual'] as const).map(m => (
            <button key={m} id={`mode-${m}`}
              className={`btn ${tracking.mode === m ? 'btn-primary' : 'btn-ghost'}`}
              style={{ padding: '5px 12px', fontSize: 11 }}
              onClick={() => setMode(m)}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Alert level badge */}
        {tracking.active && (
          <div style={{
            marginLeft: 12, padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
            background: `${alertCol}22`, color: alertCol, border: `1px solid ${alertCol}44`,
            transition: 'all 0.3s',
          }}>
            {alertLevel}
          </div>
        )}

        {/* Status */}
        <div className="header-status">
          {/* Weather mini */}
          {weather && (
            <span className="text-muted text-xs" style={{ marginRight: 12 }}>
              {weather.is_daytime ? '☀️' : '🌙'} {weather.temperature_c?.toFixed(0)}°C
              {' '}💨 {weather.windspeed?.toFixed(0)}km/h
              {weather.fp_risk > 0.4 && <span style={{ color: '#f5a623', marginLeft: 4 }}>⚠ FP</span>}
            </span>
          )}
          <div className={`status-dot ${connected ? (tracking.active ? 'tracking' : 'connected') : ''}`} />
          <span>
            {!connected ? 'Disconnected'
              : tracking.active
                ? `TRACKING · ${tracking.targetClass ?? '?'} ${(tracking.confidence * 100).toFixed(0)}%${tracking.bearing ? ` · ${tracking.bearing}` : ''}`
                : 'Standby'}
          </span>
          {selectedCamera && (
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>📷 {selectedCamera.name}</span>
          )}
        </div>
      </header>

      {/* Sidebar */}
      <nav className="sidebar">
        <span className="sidebar-section-label">Navigation</span>
        {navItems.map(item => (
          <button key={item.id} id={`nav-${item.id}`}
            className={`nav-item ${view === item.id ? 'active' : ''}`}
            onClick={() => setView(item.id)}>
            <span className="nav-icon">{item.icon}</span>
            {item.label}
            {item.id === 'intelligence' && fusion.filter(f => f.alert_level === 'HIGH' || f.alert_level === 'CRITICAL').length > 0 && (
              <span style={{ marginLeft: 'auto', background: '#e8531a', borderRadius: 99, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>
                {fusion.filter(f => f.alert_level === 'HIGH' || f.alert_level === 'CRITICAL').length}
              </span>
            )}
          </button>
        ))}

        <span className="sidebar-section-label" style={{ marginTop: 8 }}>Cameras</span>
        {cameras.map(cam => (
          <button key={cam.id} id={`cam-select-${cam.id}`}
            className={`nav-item ${selectedCamera?.id === cam.id ? 'active' : ''}`}
            onClick={() => selectCamera(cam)}>
            <span className="nav-icon">📡</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cam.name}</span>
          </button>
        ))}

        {/* Stats */}
        <div style={{ marginTop: 'auto', padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
          <div className="flex justify-between"><span>Events</span><span className="text-accent">{events.length}</span></div>
          <div className="flex justify-between" style={{ marginTop: 4 }}><span>Aircraft</span><span>{aircraft.length}</span></div>
          <div className="flex justify-between" style={{ marginTop: 4 }}><span>Fusions</span><span>{fusion.length}</span></div>
          {tracking.active && tracking.az !== null && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div className="flex justify-between"><span>Az</span><span style={{ color: '#e8531a' }}>{tracking.az?.toFixed(1)}°</span></div>
              <div className="flex justify-between" style={{ marginTop: 2 }}><span>El</span><span style={{ color: '#e8531a' }}>{tracking.el?.toFixed(1)}°</span></div>
            </div>
          )}
        </div>
      </nav>

      {/* Main */}
      <main className="main">
        {view === 'tracking' && (
          <>
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

            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">Sky Map</span>
                <span className="panel-badge">
                  {aircraft.length > 0 ? `${aircraft.length} aircraft` : 'AZ / EL'}
                </span>
              </div>
              <div className="panel-body">
                <SkyMap tracking={tracking} events={events.slice(0, 50)} aircraft={aircraft} />
              </div>
            </div>

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

        {view === 'intelligence' && (
          <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
            <div className="panel-header">
              <span className="panel-title">Intelligence</span>
              <span className="panel-badge">Sensor Fusion</span>
              {weather && <span className="text-xs text-muted" style={{ marginLeft: 8 }}>
                FP Risk: {(weather.fp_risk * 100).toFixed(0)}%
              </span>}
            </div>
            <div className="panel-body overflow-auto">
              <FusionPanel fusions={fusion} aircraft={aircraft} weather={weather} />
            </div>
          </div>
        )}

        {view === 'cameras' && (
          <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
            <div className="panel-header"><span className="panel-title">Camera Registry</span></div>
            <div className="panel-body overflow-auto">
              <CameraList cameras={cameras}
                onRefresh={() => fetch('/api/cameras').then(r => r.json()).then(setCameras)}
                selectedId={selectedCamera?.id} onSelect={selectCamera} />
            </div>
          </div>
        )}

        {view === 'events' && (
          <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}>
            <div className="panel-header">
              <span className="panel-title">Detection Events</span>
              <span className="panel-badge">{events.length} total</span>
              <a href="/api/export/csv" download style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
                ⬇ Export CSV
              </a>
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
              <p className="text-secondary text-sm">Configure patrol presets and dwell times.</p>
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
