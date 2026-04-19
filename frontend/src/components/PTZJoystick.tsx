import React, { useRef, useEffect, useState, useCallback } from 'react';

interface PTZJoystickProps {
  send: (msg: Record<string, unknown>) => void;
  cameraId: number | null;
  mode: 'tracking' | 'patrol' | 'manual';
}

/**
 * PTZJoystick — touch+mouse virtual joystick for manual pan/tilt.
 * Sends continuousMove commands while dragging, stops on release.
 */
export default function PTZJoystick({ send, cameraId, mode }: PTZJoystickProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [zoom, setZoom] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const PAD_R = 60; // radius of pad
  const THUMB_R = 18;

  const getOffset = (e: MouseEvent | Touch, el: HTMLDivElement) => {
    const rect = el.getBoundingClientRect();
    return {
      x: (('clientX' in e ? e.clientX : e.clientX) - rect.left) - rect.width / 2,
      y: (('clientY' in e ? e.clientY : e.clientY) - rect.top) - rect.height / 2,
    };
  };

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  const sendMove = useCallback((x: number, y: number) => {
    if (!cameraId) return;
    send({ type: 'ptz:move', cameraId, pan: x, tilt: -y, zoom: 0 });
  }, [cameraId, send]);

  const sendStop = useCallback(() => {
    if (!cameraId) return;
    send({ type: 'ptz:stop', cameraId });
  }, [cameraId, send]);

  const onDown = (clientX: number, clientY: number) => {
    if (mode !== 'manual') return;
    dragging.current = true;
  };

  const onMove = (clientX: number, clientY: number) => {
    if (!dragging.current || !padRef.current) return;
    const rect = padRef.current.getBoundingClientRect();
    let dx = clientX - rect.left - rect.width / 2;
    let dy = clientY - rect.top - rect.height / 2;
    const dist = Math.hypot(dx, dy);
    if (dist > PAD_R) {
      dx = (dx / dist) * PAD_R;
      dy = (dy / dist) * PAD_R;
    }
    setPosition({ x: dx, y: dy });
    sendMove(clamp(dx / PAD_R), clamp(dy / PAD_R));
  };

  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setPosition({ x: 0, y: 0 });
    sendStop();
  };

  useEffect(() => {
    const handleMove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const handleUp = () => onUp();
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [cameraId, mode]);

  const disabled = mode !== 'manual' || !cameraId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 20, padding: 16 }}>
      {/* Mode notice */}
      {mode !== 'manual' && (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Switch to <strong style={{ color: 'var(--text-primary)' }}>Manual</strong> mode to use joystick
        </div>
      )}

      {/* Joystick pad */}
      <div
        ref={padRef}
        id="ptz-joystick-pad"
        onMouseDown={(e) => onDown(e.clientX, e.clientY)}
        onTouchStart={(e) => { const t = e.touches[0]; onDown(t.clientX, t.clientY); }}
        onTouchMove={(e) => { const t = e.touches[0]; onMove(t.clientX, t.clientY); }}
        onTouchEnd={onUp}
        style={{
          position: 'relative',
          width: PAD_R * 2 + THUMB_R * 2,
          height: PAD_R * 2 + THUMB_R * 2,
          borderRadius: '50%',
          background: disabled ? 'var(--bg-elevated)' : 'radial-gradient(circle, var(--bg-elevated) 60%, var(--bg-surface))',
          border: `1px solid ${disabled ? 'var(--border)' : 'var(--border-bright)'}`,
          cursor: disabled ? 'not-allowed' : 'crosshair',
          userSelect: 'none',
          flexShrink: 0,
          boxShadow: disabled ? 'none' : '0 0 32px rgba(232,83,26,0.1)',
        }}
      >
        {/* Grid lines */}
        <div style={{ position: 'absolute', top: '50%', left: '10%', right: '10%', height: 1, background: 'rgba(255,255,255,0.05)', transform: 'translateY(-50%)' }} />
        <div style={{ position: 'absolute', left: '50%', top: '10%', bottom: '10%', width: 1, background: 'rgba(255,255,255,0.05)', transform: 'translateX(-50%)' }} />

        {/* Thumb */}
        <div
          ref={thumbRef}
          style={{
            position: 'absolute',
            width: THUMB_R * 2,
            height: THUMB_R * 2,
            borderRadius: '50%',
            background: disabled ? 'var(--bg-base)' : 'var(--accent)',
            border: `2px solid ${disabled ? 'var(--border)' : 'rgba(255,255,255,0.3)'}`,
            top: '50%',
            left: '50%',
            transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
            transition: dragging.current ? 'none' : 'transform 200ms cubic-bezier(0.4,0,0.2,1)',
            boxShadow: disabled ? 'none' : '0 0 16px rgba(232,83,26,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
          }}
        >
          🎯
        </div>
      </div>

      {/* Zoom slider */}
      <div style={{ width: '80%' }}>
        <label style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
          <span>Zoom</span>
          <span className="font-mono text-xs text-accent">{zoom > 0 ? `+${zoom}` : zoom}</span>
        </label>
        <input
          id="ptz-zoom-slider"
          type="range"
          min="-1"
          max="1"
          step="0.05"
          value={zoom}
          disabled={disabled}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setZoom(v);
            if (cameraId) send({ type: 'ptz:move', cameraId, pan: 0, tilt: 0, zoom: v });
          }}
          onMouseUp={() => {
            setZoom(0);
            if (cameraId) send({ type: 'ptz:stop', cameraId });
          }}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
      </div>

      {/* Quick preset buttons */}
      <div className="flex gap-2" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
        {['Home', 'North', 'East', 'South', 'West'].map((label) => (
          <button
            key={label}
            id={`preset-btn-${label.toLowerCase()}`}
            className="btn btn-ghost"
            style={{ padding: '5px 10px', fontSize: 11, opacity: disabled ? 0.4 : 1 }}
            disabled={disabled}
            onClick={() => cameraId && send({ type: 'ptz:preset', cameraId, presetToken: label.toLowerCase() })}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
