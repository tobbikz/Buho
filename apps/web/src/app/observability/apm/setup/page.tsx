import { networkInterfaces } from 'node:os';
import Link from 'next/link';
import { ApmSetup } from '@/components/ApmSetup';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { listApmEbpfBindings } from '@/lib/apm-bindings';
import { listEndpointMonitors } from '@/lib/endpoints';
import { listInventoryEntities } from '@/lib/obs-infra';
import { servicePath } from '@/lib/obs-service';
import { otlpTokenConfigured } from '@/lib/otlp-auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Add APM · Búho' };

function lanIpv4(): string | null {
  const nets = networkInterfaces();
  for (const rows of Object.values(nets)) {
    for (const row of rows ?? []) {
      if (row.family === 'IPv4' && !row.internal) return row.address;
    }
  }
  return null;
}

export default async function ObservabilityApmSetupPage() {
  let entities;
  let monitors;
  let initialBindings;
  try {
    [entities, monitors, initialBindings] = await Promise.all([
      listInventoryEntities(),
      listEndpointMonitors(),
      listApmEbpfBindings(),
    ]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const probeByAlias = new Map(monitors.map((m) => [m.alias, `${m.host}:${m.port}`]));

  // Match Services KPI: last-hour OTLP activity (not historical identity).
  const withTraces = entities.filter((e) => e.tracesRecent1h).length;
  const needApm = entities
    .filter((e) => e.hasUptime && !e.hasTraces)
    .map((e) => ({
      name: e.name,
      href: servicePath(e.name, 'overview'),
      hasUptime: e.hasUptime,
      probeTarget: probeByAlias.get(e.name) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const lan = lanIpv4();
  const host =
    process.env.BUHO_PUBLIC_HOST?.trim() ||
    process.env.NEXT_PUBLIC_BUHO_HOST?.trim() ||
    lan ||
    '127.0.0.1';
  const webPort = process.env.PORT?.trim() || '3100';
  const collectorEndpoint =
    process.env.BUHO_OTEL_COLLECTOR_ENDPOINT?.trim() || `http://${host}:4318`;
  const remoteOtlpEndpoint =
    process.env.BUHO_PUBLIC_OTLP?.trim() ||
    (lan ? `http://${lan}:4318` : collectorEndpoint.includes('127.0.0.1') ? '' : collectorEndpoint);
  const directEndpoint =
    process.env.BUHO_OTLP_PUBLIC_URL?.trim() ||
    `http://${host}:${webPort}/api/otlp/v1/traces`;
  const logsEndpoint = `http://${host}:${webPort}/api/otlp/v1/logs`;
  const tokenConfigured = otlpTokenConfigured() !== null;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="APM"
        title="Add APM"
        sub="100% no-code · IP:port · remote = SSH once · SDK optional"
        actions={
          <>
            <Link className="btn" href="/observability/apm/traces">
              Traces
            </Link>
            <Link className="btn" href="/observability/app-logs">
              App logs
            </Link>
            <Link className="btn" href="/observability/synthetics">
              Add probe
            </Link>
          </>
        }
      />
      <ApmSetup
        otlpPath="/api/otlp/v1/traces"
        collectorEndpoint={collectorEndpoint}
        remoteOtlpEndpoint={remoteOtlpEndpoint || `http://${lan || 'YOUR_LAN_IP'}:4318`}
        directEndpoint={directEndpoint}
        withTraces={withTraces}
        needApm={needApm}
        initialBindings={initialBindings}
        tokenConfigured={tokenConfigured}
        logsEndpoint={logsEndpoint}
      />
    </div>
  );
}
