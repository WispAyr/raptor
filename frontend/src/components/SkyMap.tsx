import React, { useEffect, useRef } from 'react';
import type { TrackingState, DetectionEvent, Aircraft } from './App';
import * as d3 from 'd3';

interface SkyMapProps {
  tracking: TrackingState;
  events: DetectionEvent[];
  aircraft?: Aircraft[];
}

function azElToXY(az: number, el: number, cx: number, cy: number, R: number) {
  const r   = R * (1 - Math.max(0, el) / 90);
  const rad = (az - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export default function SkyMap({ tracking, events, aircraft = [] }: SkyMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const size = 300;
    const cx = size / 2, cy = size / 2, R = (size / 2) - 24;
    const s = d3.select(svg);
    s.selectAll('*').remove();

    // Sky background gradient
    const defs = s.append('defs');
    const radGrad = defs.append('radialGradient').attr('id', 'sky-grad');
    radGrad.append('stop').attr('offset', '0%').attr('stop-color', '#0d1a2e');
    radGrad.append('stop').attr('offset', '100%').attr('stop-color', '#050608');
    s.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R + 2)
      .attr('fill', 'url(#sky-grad)').attr('stroke', 'rgba(255,255,255,0.08)').attr('stroke-width', 1);

    // Elevation rings
    [0, 30, 60].forEach(el => {
      const r = R * (1 - el / 90);
      s.append('circle').attr('cx', cx).attr('cy', cy).attr('r', r)
        .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.06)').attr('stroke-width', 1);
      s.append('text').attr('x', cx + 4).attr('y', cy - r + 12)
        .attr('fill', 'rgba(255,255,255,0.18)').attr('font-size', 9).text(`${el}°`);
    });

    // Cardinal lines
    [{ az: 0, l: 'N' }, { az: 90, l: 'E' }, { az: 180, l: 'S' }, { az: 270, l: 'W' }].forEach(({ az, l }) => {
      const rad = (az - 90) * Math.PI / 180;
      s.append('line').attr('x1', cx).attr('y1', cy)
        .attr('x2', cx + R * Math.cos(rad)).attr('y2', cy + R * Math.sin(rad))
        .attr('stroke', 'rgba(255,255,255,0.06)').attr('stroke-width', 1);
      s.append('text')
        .attr('x', cx + (R + 14) * Math.cos(rad)).attr('y', cy + (R + 14) * Math.sin(rad))
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', 11).attr('font-weight', 600).text(l);
    });

    // ADS-B aircraft
    aircraft.forEach(ac => {
      if (ac.bearing == null || ac.elevDeg == null) return;
      const { x, y } = azElToXY(ac.bearing, ac.elevDeg, cx, cy, R);
      s.append('circle').attr('cx', x).attr('cy', y).attr('r', 5)
        .attr('fill', '#60a5fa33').attr('stroke', '#60a5fa').attr('stroke-width', 1);
      // Heading arrow
      const headRad = (ac.track || 0) * Math.PI / 180;
      s.append('line')
        .attr('x1', x).attr('y1', y)
        .attr('x2', x + Math.sin(headRad) * 10).attr('y2', y - Math.cos(headRad) * 10)
        .attr('stroke', '#60a5fa').attr('stroke-width', 1.5);
      s.append('text').attr('x', x + 7).attr('y', y - 7)
        .attr('fill', '#60a5fa').attr('font-size', 8)
        .text(ac.callsign || ac.icao);
    });

    // Historical event trails — use real az/el if available, fallback to pixel proxy
    events.forEach((ev, i) => {
      const alpha = (1 - i / events.length) * 0.6;
      const az = ev.az ?? ((ev.centroid_x ?? 0) / (ev.frame_w ?? 1280)) * 360;
      const el = ev.el ?? 90 - ((ev.centroid_y ?? 0) / (ev.frame_h ?? 720)) * 90;
      const { x, y } = azElToXY(az, el, cx, cy, R);
      const col = ev.alert_level === 'CRITICAL' ? '#ff3b5c'
                : ev.alert_level === 'HIGH'     ? '#e8531a'
                : ev.anomaly_flag               ? '#f5a623' : '#e8531a';
      s.append('circle').attr('cx', x).attr('cy', y).attr('r', ev.anomaly_flag ? 4 : 3)
        .attr('fill', `rgba(${col.startsWith('#ff') ? '255,59,92' : col.startsWith('#f5') ? '245,166,35' : '232,83,26'},${alpha})`);
    });

    // Live target
    if (tracking.active) {
      const az = tracking.az ?? ((tracking.centroid.x) / 1280) * 360;
      const el = tracking.el ?? 90 - (tracking.centroid.y / 720) * 90;
      const { x, y } = azElToXY(az, el, cx, cy, R);

      s.append('circle').attr('cx', x).attr('cy', y).attr('r', 16)
        .attr('fill', 'none').attr('stroke', 'rgba(232,83,26,0.15)').attr('stroke-width', 1);
      s.append('circle').attr('cx', x).attr('cy', y).attr('r', 5)
        .attr('fill', '#e8531a').attr('filter', 'url(#glow)');

      [[-12,0],[12,0],[0,-12],[0,12]].forEach(([dx, dy]) => {
        s.append('line').attr('x1', x+dx).attr('y1', y+dy)
          .attr('x2', x+dx*0.3).attr('y2', y+dy*0.3)
          .attr('stroke', '#e8531a').attr('stroke-width', 1.5);
      });

      s.append('text').attr('x', x + 10).attr('y', y - 10)
        .attr('fill', '#e8531a').attr('font-size', 9).attr('font-family', 'monospace')
        .text(`${tracking.targetClass ?? '?'} ${(tracking.confidence * 100).toFixed(0)}%`);

      if (tracking.az != null) {
        s.append('text').attr('x', x + 10).attr('y', y + 2)
          .attr('fill', 'rgba(232,83,26,0.7)').attr('font-size', 8).attr('font-family', 'monospace')
          .text(`${tracking.az?.toFixed(1)}° ${tracking.bearing ?? ''}`);
      }
    }

    // Zenith dot
    s.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 2).attr('fill', 'rgba(255,255,255,0.2)');

  }, [tracking, events, aircraft]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
      <svg ref={svgRef} id="sky-map-svg"
        style={{ width: '100%', height: '100%', maxWidth: 300, maxHeight: 300 }}
        viewBox="0 0 300 300" />
    </div>
  );
}
