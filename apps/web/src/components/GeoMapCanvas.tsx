'use client';

import { useEffect } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import type { GeoPin } from '@/lib/geo-map';
import 'leaflet/dist/leaflet.css';

function FitBounds({ pins }: { pins: GeoPin[] }) {
  const map = useMap();
  useEffect(() => {
    if (pins.length === 0) {
      map.setView([20, 0], 2);
      return;
    }
    if (pins.length === 1) {
      map.setView([pins[0]!.lat, pins[0]!.lon], 6);
      return;
    }
    const lats = pins.map((p) => p.lat);
    const lons = pins.map((p) => p.lon);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [36, 36], maxZoom: 8 },
    );
  }, [map, pins]);
  return null;
}

/** Kibana-like bubble palette by health. */
function bubbleFill(score: number | null, critical: number): string {
  if (critical > 0 || (score != null && score < 60)) return '#f59e0b'; // amber
  if (score != null && score < 85) return '#a78bfa'; // soft purple
  if (score != null) return '#34d399'; // mint
  return '#818cf8'; // indigo
}

function bubbleRadius(score: number | null, selected: boolean, exact: boolean): number {
  const base = exact ? 14 : 11;
  const healthBoost = score == null ? 0 : Math.max(0, (100 - score) / 12);
  return (selected ? base + 4 : base) + healthBoost;
}

export function GeoMapCanvas({
  pins,
  selectedId,
  onSelect,
  showBasemap,
}: {
  pins: GeoPin[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  showBasemap: boolean;
}) {
  return (
    <MapContainer
      center={[20, 0]}
      zoom={2}
      className="geo-map__leaflet geo-map__leaflet--dark"
      scrollWheelZoom
      zoomControl
    >
      {showBasemap && (
        <TileLayer
          // Esri Canvas Dark Gray — no API key (CARTO dark tiles now watermark without one).
          attribution='Tiles &copy; <a href="https://www.esri.com/">Esri</a>'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          maxZoom={16}
        />
      )}
      <FitBounds pins={pins} />
      {pins.map((p) => {
        const selected = selectedId === p.instanceId;
        const fill = bubbleFill(p.score, p.critical);
        const radius = bubbleRadius(p.score, selected, p.precision === 'exact');
        return (
          <CircleMarker
            key={p.instanceId}
            center={[p.lat, p.lon]}
            radius={radius}
            pathOptions={{
              color: selected ? '#e0e7ff' : fill,
              fillColor: fill,
              fillOpacity: selected ? 0.85 : 0.55,
              weight: selected ? 2.5 : 1,
              opacity: 0.95,
            }}
            eventHandlers={{
              click: () => onSelect(p.instanceId),
            }}
          >
            <Popup>
              <strong className="font-mono">{p.alias}</strong>
              <br />
              {p.engine} · {p.host}:{p.port}
              <br />
              {p.precision === 'exact' ? 'geo tags' : 'approx (no lat/lon)'}
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
