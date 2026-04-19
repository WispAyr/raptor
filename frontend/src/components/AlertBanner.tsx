import React, { useEffect, useRef } from 'react';

interface AlertBannerProps {
  level: string;
  message: string;
  onDismiss: () => void;
}

const COLOURS: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  CRITICAL: { bg: '#1a0208', border: '#ff3b5c', text: '#ff3b5c', icon: '🚨' },
  HIGH:     { bg: '#1a0a02', border: '#e8531a', text: '#e8531a', icon: '⚠️' },
  MEDIUM:   { bg: '#1a1402', border: '#f5a623', text: '#f5a623', icon: '⚡' },
  LOW:      { bg: '#021a0a', border: '#2adc8c', text: '#2adc8c', icon: '📡' },
};

export default function AlertBanner({ level, message, onDismiss }: AlertBannerProps) {
  const c = COLOURS[level] || COLOURS.LOW;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDismiss]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = 'translateY(-100%)';
    el.style.opacity = '0';
    requestAnimationFrame(() => {
      setTimeout(() => {
        el.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        el.style.transform = 'translateY(0)';
        el.style.opacity = '1';
      }, 10);
    });
  }, [message]);

  return (
    <div ref={ref} id={`alert-banner-${level.toLowerCase()}`} style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: c.bg, borderBottom: `2px solid ${c.border}`,
      padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
      boxShadow: `0 0 30px ${c.border}44`,
    }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: c.border, boxShadow: `0 0 8px ${c.border}` }} />
      <span style={{ fontSize: 16 }}>{c.icon}</span>
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 700, color: c.text, fontSize: 13, marginRight: 8 }}>[{level}]</span>
        <span style={{ color: '#e0e4ed', fontSize: 13 }}>{message}</span>
      </div>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', fontSize: 18, padding: '0 4px' }} title="Esc">×</button>
    </div>
  );
}
