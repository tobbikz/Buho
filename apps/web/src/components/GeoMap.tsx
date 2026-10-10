'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { GeoPin } from '@/lib/geo-map';

const ENGINE_SHORT: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  endpoint: 'HTTP',
};

function tone(score: number | null, critical: number): string {
  if (score == null) return '#6b7280';
  if (critical > 0 || score < 60) return '#b01818';
  if (score < 85) return '#9a4a00';
  return '#0a6e42';
}

/**
 * Kibana Maps–style shell: OSM basemap + instance layers.
 * Not Elastic Maps Service — OpenStreetMap tiles only.
 */
export function GeoMap({ pins }: { pins: GeoPin[] }) {
  const [basemapOn, setBasemapOn] = useState(true);
  const [exactOn, setExactOn] = useState(true);
  const [approxOn, setApproxOn] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [MapView, setMapView] = useState<null | ComponentType<{
    pins: GeoPin[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    showBasemap: boolean;
  }>>(null);

  useEffect(() => {
    let cancelled = false;
    void import('@/components/GeoMapCanvas').then((mod) => {
      if (!cancelled) setMapView(() => mod.GeoMapCanvas);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(
    () =>
      pins.filter(
        (p) => (p.precision === 'exact' && exactOn) || (p.precision === 'approx' && approxOn),
      ),
    [pins, exactOn, approxOn],
  );

  const selected = selectedId != null ? pins.find((p) => p.instanceId === selectedId) : null;
  const exactCount = pins.filter((p) => p.precision === 'exact').length;
  const approxCount = pins.filter((p) => p.precision === 'approx').length;

  return (
    <div className="geo-map">
      <div className="geo-map__stage panel">
        <div className="geo-map__canvas">
          {!MapView && <div className="empty">Loading map…</div>}
          {MapView && (
            <MapView
              pins={visible}
              selectedId={selectedId}
              onSelect={setSelectedId}
              showBasemap={basemapOn}
            />
          )}
        </div>
      </div>

      <aside className="geo-map__layers panel">
        <div className="panel-header">
          <span className="panel-title">Layers</span>
        </div>
        <div className="panel-body geo-map__layer-list">
          <label className="geo-map__layer">
            <input
              type="checkbox"
              checked={basemapOn}
              onChange={(e) => setBasemapOn(e.target.checked)}
            />
            <span>Basemap</span>
            <span className="muted text-[10px]">Esri dark</span>
          </label>
          <label className="geo-map__layer">
            <input
              type="checkbox"
              checked={exactOn}
              onChange={(e) => setExactOn(e.target.checked)}
            />
            <span>Instances (geo tags)</span>
            <span className="geo-map__badge">{exactCount}</span>
          </label>
          <label className="geo-map__layer">
            <input
              type="checkbox"
              checked={approxOn}
              onChange={(e) => setApproxOn(e.target.checked)}
            />
            <span>Instances (approx)</span>
            <span className="geo-map__badge">{approxCount}</span>
          </label>
          <p className="muted text-[10px] m-0 leading-snug">
            Exact: tags <span className="font-mono">lat</span>+
            <span className="font-mono">lon</span>. Approx: lab layout when missing (not GPS).
          </p>
        </div>

        <div className="panel-header" style={{ borderTop: '1px solid var(--border)' }}>
          <span className="panel-title">{selected ? selected.alias : 'Details'}</span>
        </div>
        <div className="panel-body space-y-2 text-sm">
          {!selected && (
            <p className="muted text-[12px] m-0">Click a pin on the map.</p>
          )}
          {selected && (
            <>
              <div className="font-mono text-[11px] text-foreground-muted">
                {ENGINE_SHORT[selected.engine] ?? selected.engine} · {selected.host}:
                {selected.port}
              </div>
              <div className="flex flex-wrap gap-1">
                <span
                  className="tag"
                  style={{ background: tone(selected.score, selected.critical), color: '#fff' }}
                >
                  score {selected.score ?? '—'}
                </span>
                <span className="tag tag--muted">{selected.precision}</span>
                <span className="tag tag--muted">{selected.environment}</span>
              </div>
              <div className="font-mono text-[10px] text-foreground-muted">
                {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Link
                  href={
                    selected.engine === 'endpoint'
                      ? `/observability/services/${encodeURIComponent(selected.alias)}?tab=uptime`
                      : `/instances/${selected.instanceId}`
                  }
                  className="btn btn--primary"
                >
                  {selected.engine === 'endpoint' ? 'Open probe' : 'Open database'}
                </Link>
                <button type="button" className="btn" onClick={() => setSelectedId(null)}>
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
