import React, { useEffect, useRef } from 'react';
import type { TrackingState, DetectionEvent } from './App';
import * as d3 from 'd3';

interface SkyMapProps {
  tracking: TrackingState;
  events: DetectionEvent[];
}

/**
 * SkyMap — Polar plot showing azimuth (0°-360°) on the ring
 * and elevation (0°-90°) as radius from centre (zenith).
 * Treats the centroid x/y pixel position as a proxy for az/el
 * until a real coordinate transform is available.
 */
export default function SkyMap({ tracking, events }: SkyMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const size = svg.clientWidth || 300;
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) - 24;

    const s = d3.select(svg);
    s.selectAll('*').remove();

    // Background
    const defs = s.append('defs');
    const radGrad = defs.append('radialGradient').attr('id', 'sky-grad');
    radGrad.append('stop').attr('offset', '0%').attr('stop-color', '#0d1a2e');
    radGrad.append('stop').attr('offset', '100%').attr('stop-color', '#050608');

    s.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R + 2)
      .attr('fill', 'url(#sky-grad)').attr('stroke', 'rgba(255,255,255,0.08)').attr('stroke-width', 1);

    // Elevation rings (90°, 60°, 30°, 0°)
    [90, 60, 30, 0].forEach(el => {
      const r = R * (1 - el / 90);
      s.append('circle').attr('cx', cx).attr('cy', cy).attr('r', r)
        .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.06)').attr('stroke-width', 1);
      if (el < 90) {
        s.append('text')
          .attr('x', cx + 4).attr('y', cy - r + 12)
          .attr('fill', 'rgba(255,255,255,0.2)').attr('font-size', 9)
          .text(`${el}°`);
      }
    });

    // Cardinal azimuth lines
    const cardinals = [{ az: 0, label: 'N' }, { az: 90, label: 'E' }, { az: 180, label: 'S' }, { az: 270, label: 'W' }];
    cardinals.forEach(({ az, label }) => {
      const rad = (az - 90) * (Math.PI / 180);
      s.append('line')
        .attr('x1', cx).attr('y1', cy)
        .attr('x2', cx + R * Math.cos(rad)).attr('y2', cy + R * Math.sin(rad))
        .attr('stroke', 'rgba(255,255,255,0.06)').attr('stroke-width', 1);
      s.append('text')
        .attr('x', cx + (R + 14) * Math.cos(rad)).attr('y', cy + (R + 14) * Math.sin(rad))
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', 11).attr('font-weight', 600)
        .text(label);
    });

    // Historical event trails
    events.forEach((ev, i) => {
      const alpha = 1 - i / events.length;
      // Map centroid to fake az/el using frame position
      const az = ((ev.centroid_x ?? 0) / (ev.frame_w ?? 1280)) * 360;
      const el = 90 - ((ev.centroid_y ?? 0) / (ev.frame_h ?? 720)) * 90;
      const r = R * (1 - el / 90);
      const rad = (az - 90) * (Math.PI / 180);
      const px = cx + r * Math.cos(rad);
      const py = cy + r * Math.sin(rad);
      s.append('circle').attr('cx', px).attr('cy', py).attr('r', 3)
        .attr('fill', `rgba(232,83,26,${alpha * 0.5})`);
    });

    // Live target
    if (tracking.active && tracking.centroid) {
      const { x, y } = tracking.centroid;
      // Placeholder mapping: centroid pixel → az/el
      const az = (x / 1280) * 360;
      const el = 90 - (y / 720) * 90;
      const r = R * (1 - el / 90);
      const rad = (az - 90) * (Math.PI / 180);
      const px = cx + r * Math.cos(rad);
      const py = cy + r * Math.sin(rad);

      // Glow ring
      s.append('circle').attr('cx', px).attr('cy', py).attr('r', 14)
        .attr('fill', 'none').attr('stroke', 'rgba(232,83,26,0.2)').attr('stroke-width', 1);
      s.append('circle').attr('cx', px).attr('cy', py).attr('r', 5)
        .attr('fill', '#e8531a');

      // Crosshair
      [[-10,0],[10,0],[0,-10],[0,10]].forEach(([dx, dy]) => {
        s.append('line')
          .attr('x1', px + dx).attr('y1', py + dy)
          .attr('x2', px + dx * 0.3).attr('y2', py + dy * 0.3)
          .attr('stroke', '#e8531a').attr('stroke-width', 1.5);
      });

      s.append('text')
        .attr('x', px + 10).attr('y', py - 10)
        .attr('fill', '#e8531a').attr('font-size', 10).attr('font-family', 'JetBrains Mono, monospace')
        .text(`${tracking.targetClass ?? '?'} ${(tracking.confidence * 100).toFixed(0)}%`);
    }

    // Zenith marker
    s.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 2)
      .attr('fill', 'rgba(255,255,255,0.2)');

  }, [tracking, events]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
      <svg
        ref={svgRef}
        id="sky-map-svg"
        style={{ width: '100%', height: '100%', maxWidth: 300, maxHeight: 300 }}
        viewBox="0 0 300 300"
      />
    </div>
  );
}
