import React, { useEffect, useRef, useState } from 'react';
import type { Camera, TrackingState } from './App';

interface VideoPanelProps {
  camera: Camera | null;
  tracking: TrackingState;
}

/**
 * VideoPanel — shows live snapshot feed from the selected camera with
 * tracking overlay (bounding box + crosshair drawn on canvas).
 * Uses polling snapshot for MVP; upgrade to HLS/WebRTC later.
 */
export default function VideoPanel({ camera, tracking }: VideoPanelProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Poll snapshot every 250ms
  useEffect(() => {
    if (!camera) return;
    setLoading(true);
    setError(null);

    const poll = () => {
      if (!imgRef.current) return;
      const ts = Date.now();
      imgRef.current.src = `/api/cameras/${camera.id}/snapshot?_t=${ts}`;
    };

    poll();
    pollRef.current = setInterval(poll, 250);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [camera?.id]);

  // Draw tracking overlay on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = img.clientWidth || 640;
    canvas.height = img.clientHeight || 360;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!tracking.active || !tracking.centroid) return;

    const scaleX = canvas.width / (img.naturalWidth || 1280);
    const scaleY = canvas.height / (img.naturalHeight || 720);
    const cx = tracking.centroid.x * scaleX;
    const cy = tracking.centroid.y * scaleY;
    const boxW = 80 * scaleX;
    const boxH = 60 * scaleY;

    // Bounding box
    ctx.strokeStyle = '#e8531a';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 2]);
    ctx.strokeRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    ctx.setLineDash([]);

    // Corner accents
    const cs = 12;
    ctx.lineWidth = 2.5;
    [[cx - boxW/2, cy - boxH/2, 1, 1], [cx + boxW/2, cy - boxH/2, -1, 1],
     [cx - boxW/2, cy + boxH/2, 1, -1], [cx + boxW/2, cy + boxH/2, -1, -1]].forEach(([x, y, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(x as number, (y as number) + (dy as number) * cs);
      ctx.lineTo(x as number, y as number);
      ctx.lineTo((x as number) + (dx as number) * cs, y as number);
      ctx.stroke();
    });

    // Crosshair
    ctx.strokeStyle = 'rgba(232,83,26,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 5, cy);
    ctx.moveTo(cx + 5, cy);  ctx.lineTo(cx + 20, cy);
    ctx.moveTo(cx, cy - 20); ctx.lineTo(cx, cy - 5);
    ctx.moveTo(cx, cy + 5);  ctx.lineTo(cx, cy + 20);
    ctx.stroke();

    // Centre dot
    ctx.fillStyle = '#e8531a';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = '#e8531a';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.fillText(
      `${tracking.targetClass ?? '?'} · ${(tracking.confidence * 100).toFixed(0)}%`,
      cx - boxW / 2, cy - boxH / 2 - 6
    );
  }, [tracking]);

  if (!camera) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12, color: 'var(--text-muted)' }}>
        <span style={{ fontSize: 40 }}>📷</span>
        <p className="text-sm">Select a camera from the sidebar</p>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}>
      <img
        ref={imgRef}
        id="video-feed"
        alt="Camera feed"
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: loading ? 'none' : 'block' }}
        onLoad={() => setLoading(false)}
        onError={() => { setError('Snapshot unavailable'); setLoading(false); }}
      />
      <canvas
        ref={canvasRef}
        id="tracking-overlay"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Connecting to {camera.host}…
        </div>
      )}
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 32 }}>⚠️</span>
          <span className="text-sm">{error}</span>
          <span className="text-xs">{camera.host}:{camera.port}</span>
        </div>
      )}
      {/* HUD overlay */}
      <div style={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', justifyContent: 'space-between', pointerEvents: 'none' }}>
        <div style={{ background: 'rgba(5,6,8,0.75)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, padding: '3px 8px', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-secondary)' }}>
          {camera.protocol.toUpperCase()} · {camera.name}
        </div>
        {tracking.active && (
          <div style={{ background: 'rgba(232,83,26,0.15)', border: '1px solid rgba(232,83,26,0.4)', borderRadius: 4, padding: '3px 8px', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)' }}>
            ● TRACKING
          </div>
        )}
      </div>
    </div>
  );
}
