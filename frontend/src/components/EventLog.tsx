import React from 'react';
import type { DetectionEvent } from './App';

interface EventLogProps {
  events: DetectionEvent[];
}

const CLASS_TAG: Record<string, string> = {
  unknown:  'tag-unknown',
  aircraft: 'tag-aircraft',
  bird:     'tag-bird',
};

function formatTime(ts?: number, created_at?: string): string {
  const d = ts ? new Date(ts) : created_at ? new Date(created_at) : new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function EventLog({ events }: EventLogProps) {
  if (events.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: 8 }}>
        <span style={{ fontSize: 32 }}>🔭</span>
        <p className="text-sm">No detections yet</p>
        <p className="text-xs text-muted">Start the detection engine to see events</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '80px 60px 90px 80px 80px 1fr', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        <span>Time</span>
        <span>Class</span>
        <span>Confidence</span>
        <span>Centroid X</span>
        <span>Centroid Y</span>
        <span>Track ID</span>
      </div>

      {events.map((ev, i) => (
        <div
          key={`${ev.track_id}-${i}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '80px 60px 90px 80px 80px 1fr',
            gap: 8,
            padding: '6px 16px',
            borderBottom: '1px solid var(--border)',
            alignItems: 'center',
            background: i === 0 ? 'rgba(232,83,26,0.05)' : 'transparent',
            transition: 'background 300ms',
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>{formatTime(ev.ts, ev.created_at)}</span>
          <span className={`tag ${CLASS_TAG[ev.class] ?? 'tag-other'}`}>{ev.class}</span>
          <span style={{ color: ev.confidence > 0.7 ? 'var(--green)' : ev.confidence > 0.4 ? 'var(--amber)' : 'var(--text-muted)' }}>
            {(ev.confidence * 100).toFixed(1)}%
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{Math.round(ev.centroid_x ?? 0)}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{Math.round(ev.centroid_y ?? 0)}</span>
          <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            #{ev.track_id}
          </span>
        </div>
      ))}
    </div>
  );
}
