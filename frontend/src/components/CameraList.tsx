import React, { useState } from 'react';
import type { Camera } from './App';

interface CameraListProps {
  cameras: Camera[];
  selectedId?: number;
  onSelect: (cam: Camera) => void;
  onRefresh: () => void;
}

const EMPTY_FORM = { name: '', protocol: 'onvif', host: '', port: '80', username: 'admin', password: '', stream_url: '', snapshot_url: '' };

export default function CameraList({ cameras, selectedId, onSelect, onRefresh }: CameraListProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!form.name || !form.host) return;
    setSaving(true);
    try {
      await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, port: parseInt(form.port) }),
      });
      setForm(EMPTY_FORM);
      setShowAdd(false);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Remove this camera?')) return;
    await fetch(`/api/cameras/${id}`, { method: 'DELETE' });
    onRefresh();
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="flex justify-between items-center">
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Registered Cameras</h2>
        <div className="flex gap-2">
          <button id="btn-refresh-cameras" className="btn btn-ghost" onClick={onRefresh}>↻ Refresh</button>
          <button id="btn-add-camera" className="btn btn-primary" onClick={() => setShowAdd(v => !v)}>
            {showAdd ? '✕ Cancel' : '+ Add Camera'}
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label>Name</label><input id="cam-name" placeholder="Rooftop PTZ" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
          <div>
            <label>Protocol</label>
            <select id="cam-protocol" value={form.protocol} onChange={e => setForm(f => ({ ...f, protocol: e.target.value }))}>
              <option value="onvif">ONVIF</option>
              <option value="vapix">Axis VAPIX</option>
            </select>
          </div>
          <div><label>Host / IP</label><input id="cam-host" placeholder="192.168.1.100" value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} /></div>
          <div><label>Port</label><input id="cam-port" type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} /></div>
          <div><label>Username</label><input id="cam-username" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></div>
          <div><label>Password</label><input id="cam-password" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>RTSP Stream URL (optional)</label><input id="cam-stream" placeholder="rtsp://user:pass@192.168.1.100/stream1" value={form.stream_url} onChange={e => setForm(f => ({ ...f, stream_url: e.target.value }))} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label>Snapshot URL (optional)</label><input id="cam-snapshot" placeholder="http://192.168.1.100/snapshot.jpg" value={form.snapshot_url} onChange={e => setForm(f => ({ ...f, snapshot_url: e.target.value }))} /></div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
            <button id="btn-save-camera" className="btn btn-primary" disabled={saving || !form.name || !form.host} onClick={handleAdd}>
              {saving ? 'Saving…' : '+ Add Camera'}
            </button>
          </div>
        </div>
      )}

      {/* Camera cards */}
      {cameras.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📷</div>
          <p className="text-sm">No cameras yet. Add one above.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {cameras.map(cam => (
            <div
              key={cam.id}
              className="card"
              style={{
                cursor: 'pointer',
                border: `1px solid ${selectedId === cam.id ? 'var(--accent)' : 'var(--border)'}`,
                background: selectedId === cam.id ? 'var(--accent-dim)' : 'var(--bg-elevated)',
              }}
              onClick={() => onSelect(cam)}
            >
              <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{cam.name}</span>
                <div className="flex gap-2">
                  <span className="tag tag-other" style={{ fontSize: 10 }}>{cam.protocol.toUpperCase()}</span>
                  <button
                    id={`btn-delete-camera-${cam.id}`}
                    className="btn btn-danger"
                    style={{ padding: '3px 8px', fontSize: 10 }}
                    onClick={e => { e.stopPropagation(); handleDelete(cam.id); }}
                  >✕</button>
                </div>
              </div>
              <div className="mono text-xs text-muted">
                <div>{cam.host}:{cam.port}</div>
                {cam.stream_url && <div style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📡 {cam.stream_url}</div>}
              </div>
              {selectedId === cam.id && (
                <div className="text-xs text-accent" style={{ marginTop: 8 }}>● Selected for tracking</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
