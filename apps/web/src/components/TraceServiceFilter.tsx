'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { tracesListHref } from '@/lib/apm-trace-href';

export function TraceServiceFilter({
  windowKey,
  fromIso,
  toIso,
  initialQuery,
  serviceFilter,
  serviceOptions,
}: {
  windowKey: string;
  fromIso?: string | null;
  toIso?: string | null;
  initialQuery: string;
  serviceFilter: string | null;
  serviceOptions: string[];
}) {
  const router = useRouter();
  const absolute = !!(fromIso || toIso);
  const timeCtx = absolute
    ? { from: fromIso ?? null, to: toIso ?? null }
    : { w: windowKey === 'custom' ? '1h' : windowKey };

  return (
    <div className="apm-traces__context mb-3 flex flex-wrap items-center gap-2">
      <label className="muted text-xs" htmlFor="apm-traces-service">
        Service
      </label>
      <select
        id="apm-traces-service"
        className="input"
        value={serviceFilter ?? ''}
        aria-label="Filter traces by service"
        style={{ width: 'auto', minWidth: '10rem' }}
        onChange={(e) => {
          const next = e.target.value.trim() || null;
          router.push(
            tracesListHref({
              ...timeCtx,
              service: next,
              q: initialQuery || null,
            }),
          );
        }}
      >
        <option value="">All services</option>
        {serviceOptions.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {serviceFilter ? (
        <span className="tag tag--info" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <span className="font-mono">{serviceFilter}</span>
          <Link
            href={tracesListHref({
              ...timeCtx,
              service: null,
              q: initialQuery || null,
            })}
            className="underline"
            aria-label={`Clear service filter ${serviceFilter}`}
            title="Clear service"
          >
            ×
          </Link>
        </span>
      ) : null}
    </div>
  );
}
