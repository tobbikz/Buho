import Link from 'next/link';
import { tracesListHref } from '@/lib/apm-trace-href';
import { listApmServiceDbLinks } from '@/lib/traces';

/**
 * Light APM ↔ Blame correlation: services that touch this DB instance.
 * Hidden when no links exist (APM is optional for Databases scope).
 */
export async function ApmBlameLite({
  instanceId,
  windowMinutes = 60,
}: {
  instanceId: number;
  windowMinutes?: number;
}) {
  const map = await listApmServiceDbLinks(windowMinutes).catch(
    () => new Map<string, { instanceId: number; alias: string; engine: string; source: string }[]>(),
  );

  const services: Array<{ name: string; source: string }> = [];
  for (const [name, links] of map) {
    const hit = links.find((l) => l.instanceId === instanceId);
    if (hit) services.push({ name, source: hit.source });
  }

  if (services.length === 0) return null;

  const w =
    windowMinutes <= 60
      ? '1h'
      : windowMinutes <= 360
        ? '6h'
        : windowMinutes <= 1440
          ? '24h'
          : '7d';

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">APM ↔ this database</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          lite · {services.length} service(s)
        </span>
      </div>
      <div className="panel-body flex flex-col gap-2">
        <p className="text-[12px] text-foreground-secondary m-0">
          Services that declare or emit spans against this instance — page app owners here when
          Blame pain is application/CPU, not recovery.
        </p>
        <div className="flex flex-wrap gap-2">
          {services.map((s) => (
            <Link
              key={s.name}
              href={tracesListHref({ service: s.name, w })}
              className="tag tag--info"
              title={`link source: ${s.source}`}
            >
              {s.name}
              <span className="ml-1 font-mono text-[9px] opacity-70">{s.source}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
