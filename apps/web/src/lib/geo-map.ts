import { listInstances, type FleetInstance } from './queries';

export type GeoPin = {
  instanceId: number;
  alias: string;
  engine: string;
  host: string;
  port: number;
  environment: string;
  score: number | null;
  critical: number;
  lat: number;
  lon: number;
  /** Exact = from tags; approx = lab fallback (no geo tags yet). */
  precision: 'exact' | 'approx';
};

function parseCoord(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

function coordsFromTags(tags: Record<string, string>): { lat: number; lon: number } | null {
  const lat = parseCoord(tags['lat'] ?? tags['latitude'] ?? tags['LAT']);
  const lon = parseCoord(tags['lon'] ?? tags['lng'] ?? tags['longitude'] ?? tags['LON']);
  if (lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    return { lat, lon };
  }
  const packed = tags['geo'] ?? tags['location'] ?? tags['GEO'];
  if (packed) {
    const parts = packed.split(/[,;\s]+/).map((p) => Number(p.trim()));
    if (
      parts.length >= 2 &&
      Number.isFinite(parts[0]) &&
      Number.isFinite(parts[1]) &&
      parts[0]! >= -90 &&
      parts[0]! <= 90 &&
      parts[1]! >= -180 &&
      parts[1]! <= 180
    ) {
      return { lat: parts[0]!, lon: parts[1]! };
    }
  }
  return null;
}

/** Deterministic lab pin around San José, CR when no geo tags exist. */
function approxCoords(alias: string): { lat: number; lon: number } {
  let h = 0;
  for (let i = 0; i < alias.length; i++) h = (h * 31 + alias.charCodeAt(i)) >>> 0;
  const lat = 9.9281 + ((h % 1000) / 1000 - 0.5) * 0.35;
  const lon = -84.0907 + (((h >> 10) % 1000) / 1000 - 0.5) * 0.45;
  return { lat, lon };
}

function toPin(inst: FleetInstance, includeApprox: boolean): GeoPin | null {
  const exact = coordsFromTags(inst.tags);
  if (exact) {
    return {
      instanceId: inst.instanceId,
      alias: inst.alias,
      engine: inst.engine,
      host: inst.host,
      port: inst.port,
      environment: inst.environment,
      score: inst.score,
      critical: inst.critical,
      lat: exact.lat,
      lon: exact.lon,
      precision: 'exact',
    };
  }
  if (!includeApprox) return null;
  // Endpoints on localhost clutter the map — skip unless exact tags.
  if (inst.engine === 'endpoint') return null;
  const approx = approxCoords(inst.alias);
  return {
    instanceId: inst.instanceId,
    alias: inst.alias,
    engine: inst.engine,
    host: inst.host,
    port: inst.port,
    environment: inst.environment,
    score: inst.score,
    critical: inst.critical,
    lat: approx.lat,
    lon: approx.lon,
    precision: 'approx',
  };
}

/** Fleet pins for the Observability Maps app (not the service-dependency map). */
export async function listGeoPins(opts?: {
  includeApprox?: boolean;
}): Promise<GeoPin[]> {
  const includeApprox = opts?.includeApprox ?? true;
  const instances = await listInstances();
  return instances
    .map((i) => toPin(i, includeApprox))
    .filter((p): p is GeoPin => p != null)
    .sort((a, b) => a.alias.localeCompare(b.alias));
}
