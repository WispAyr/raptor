import React from 'react';
import type { FusionEvent, Aircraft, WeatherData } from './App';

interface Props {
  fusions: FusionEvent[];
  aircraft: Aircraft[];
  weather: WeatherData | null;
}

const LEVEL_COL: Record<string, string> = {
  CRITICAL: '#ff3b5c', HIGH: '#e8531a', MEDIUM: '#f5a623', LOW: '#2adc8c',
};

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, (score / 12) * 100);
  const col = score >= 10 ? '#ff3b5c' : score >= 7 ? '#e8531a' : score >= 4 ? '#f5a623' : '#2adc8c';
  return (
    <div style={{ height: 4, background: '#1c2333', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: col, transition: 'width 0.4s ease', borderRadius: 2 }} />
    </div>
  );
}

export default function FusionPanel({ fusions, aircraft, weather }: Props) {
  const high = fusions.filter(f => f.alert_level === 'HIGH' || f.alert_level === 'CRITICAL');
  const rest = fusions.filter(f => f.alert_level !== 'HIGH' && f.alert_level !== 'CRITICAL');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, height: '100%', padding: 16 }}>

      {/* Fusion events */}
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 12, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Active Tracks ({fusions.length})
        </h3>
        {fusions.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: '#4a5568', fontSize: 13 }}>
            No active fusion events
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...high, ...rest].map(fev => {
            const v = fev.visual as any;
            const col = LEVEL_COL[fev.alert_level] || '#2adc8c';
            return (
              <div key={fev.track_id} style={{
                background: '#10141c', borderRadius: 8, padding: 12,
                border: `1px solid ${col}33`,
                boxShadow: fev.alert_level === 'CRITICAL' ? `0 0 12px ${col}22` : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ background: `${col}22`, color: col, border: `1px solid ${col}44`, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>
                    {fev.alert_level}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e4ed' }}>
                    {v?.class ?? 'unknown'} <span style={{ color: '#8892a4', fontWeight: 400 }}>#{fev.track_id}</span>
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8892a4' }}>
                    score {fev.score?.toFixed(1)}
                  </span>
                </div>
                <ScoreBar score={fev.score || 0} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginTop: 8, fontSize: 11 }}>
                  {v?.az != null && <span style={{ color: '#8892a4' }}>Az <strong style={{ color: '#e8531a' }}>{v.az}°</strong></span>}
                  {v?.el != null && <span style={{ color: '#8892a4' }}>El <strong style={{ color: '#e8531a' }}>{v.el}°</strong></span>}
                  {v?.confidence != null && <span style={{ color: '#8892a4' }}>Conf <strong>{(v.confidence * 100).toFixed(0)}%</strong></span>}
                  {v?.velocity_px != null && <span style={{ color: '#8892a4' }}>Vel <strong>{v.velocity_px}px</strong></span>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {v?.anomaly_flag && <Tag col="#f5a623">⚠ Anomaly</Tag>}
                  {v?.adsb_corroborated && <Tag col="#2adc8c">✓ ADS-B {v?.adsb_callsign}</Tag>}
                  {(fev as any).rf && <Tag col="#a78bfa">RF Correlated</Tag>}
                  {(fev as any).magnetic && <Tag col="#60a5fa">Magnetic</Tag>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right sidebar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Weather */}
        <div style={{ background: '#10141c', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.07)' }}>
          <h4 style={{ margin: '0 0 10px', fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Weather
          </h4>
          {weather ? (
            <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                ['Temp', `${weather.temperature_c?.toFixed(0)}°C`],
                ['Wind', `${weather.windspeed?.toFixed(0)} km/h`],
                ['Cloud', `${weather.cloudcover_pct ?? '—'}%`],
                ['Visibility', weather.visibility_m ? `${(weather.visibility_m/1000).toFixed(1)}km` : '—'],
                ['FP Risk', `${(weather.fp_risk * 100).toFixed(0)}%`],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#8892a4' }}>{k}</span>
                  <span style={{ color: k === 'FP Risk' && weather.fp_risk > 0.4 ? '#f5a623' : '#e0e4ed' }}>{v}</span>
                </div>
              ))}
            </div>
          ) : <div style={{ color: '#4a5568', fontSize: 12 }}>No weather data</div>}
        </div>

        {/* Air picture */}
        <div style={{ background: '#10141c', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.07)', flex: 1 }}>
          <h4 style={{ margin: '0 0 10px', fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Air Picture ({aircraft.length})
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', maxHeight: 300 }}>
            {aircraft.length === 0 && <div style={{ color: '#4a5568', fontSize: 12 }}>No ADS-B traffic</div>}
            {aircraft.map(ac => (
              <div key={ac.icao} style={{ fontSize: 11, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600, color: '#60a5fa' }}>{ac.callsign || ac.icao}</span>
                  <span style={{ color: '#8892a4' }}>{ac.distNm?.toFixed(1)}nm</span>
                </div>
                <div style={{ color: '#8892a4', marginTop: 2 }}>
                  Az {ac.bearing?.toFixed(0)}° · {(ac.altFt / 1000).toFixed(0)}kft · {ac.speedKts?.toFixed(0)}kt
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tag({ col, children }: { col: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: `${col}22`, color: col, border: `1px solid ${col}44` }}>
      {children}
    </span>
  );
}
