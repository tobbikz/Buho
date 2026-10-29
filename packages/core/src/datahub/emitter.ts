/**
 * Soft-fail DataHub REST emitter (GMS aspect ingest stub).
 * Does not block monitoring if DataHub is down.
 */
import type { InstanceConfig } from '../types';

export interface DatahubEmitResult {
  attempted: boolean;
  ok: boolean;
  message: string;
  /** Dataset / platform URN when emit was attempted. */
  urn?: string;
}

export async function emitInstanceToDatahub(
  instance: InstanceConfig,
  extras?: { topics?: string[]; dags?: string[] },
): Promise<DatahubEmitResult> {
  const cfg = instance.datahub;
  if (!cfg?.emit || !cfg.baseUrl) {
    return { attempted: false, ok: true, message: 'DataHub emit disabled' };
  }
  const base = cfg.baseUrl.replace(/\/$/, '');
  const urn = `urn:li:dataPlatformInstance:(urn:li:dataPlatform:buho,${instance.alias})`;
  const datasetUrn = `urn:li:dataset:(urn:li:dataPlatform:buho,${instance.alias}.${instance.database || 'default'},PROD)`;
  const statusProposal = {
    proposal: {
      entityType: 'dataPlatformInstance',
      entityUrn: urn,
      changeType: 'UPSERT',
      aspectName: 'status',
      aspect: {
        contentType: 'application/json',
        value: JSON.stringify({
          removed: false,
          buho: {
            engine: instance.engine ?? 'postgres',
            host: instance.host,
            port: instance.port,
            environment: instance.environment ?? 'prod',
            topics: extras?.topics ?? [],
            dags: extras?.dags ?? [],
          },
        }),
      },
    },
  };
  const datasetProposal = {
    proposal: {
      entityType: 'dataset',
      entityUrn: datasetUrn,
      changeType: 'UPSERT',
      aspectName: 'datasetProperties',
      aspect: {
        contentType: 'application/json',
        value: JSON.stringify({
          name: instance.alias,
          description: `Búho-monitored ${instance.engine ?? 'postgres'} ${instance.host}:${instance.port}/${instance.database ?? ''}`,
          customProperties: {
            buho_engine: String(instance.engine ?? 'postgres'),
            buho_host: instance.host,
            buho_port: String(instance.port),
          },
        }),
      },
    },
  };
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    };
    const res1 = await fetch(`${base}/aspects?action=ingestProposal`, {
      method: 'POST',
      signal: AbortSignal.timeout(8_000),
      headers,
      body: JSON.stringify(statusProposal),
    });
    if (!res1.ok) {
      const text = await res1.text();
      return {
        attempted: true,
        ok: false,
        urn,
        message: `DataHub HTTP ${res1.status}: ${text.slice(0, 200)}`,
      };
    }
    // Dataset aspect is best-effort — older GMS builds may reject the shape.
    const res2 = await fetch(`${base}/aspects?action=ingestProposal`, {
      method: 'POST',
      signal: AbortSignal.timeout(8_000),
      headers,
      body: JSON.stringify(datasetProposal),
    });
    if (!res2.ok) {
      return {
        attempted: true,
        ok: true,
        urn,
        message: `Emitted ${urn}; dataset aspect skipped (HTTP ${res2.status})`,
      };
    }
    return {
      attempted: true,
      ok: true,
      urn: datasetUrn,
      message: `Emitted ${urn} + ${datasetUrn}`,
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      urn,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function datahubBrowseUrl(instance: InstanceConfig): string | null {
  const base = instance.datahub?.baseUrl?.replace(/\/$/, '');
  if (!base) return null;
  return `${base}/search?query=${encodeURIComponent(instance.alias)}`;
}
