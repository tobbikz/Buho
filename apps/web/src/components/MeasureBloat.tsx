'use client';

import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import { BLOAT_MODE_HINT, type BloatMeasurementRow } from '@/lib/bloat-types';

/**
 * Measured-bloat cell: shows a prior measurement, or the button to queue one.
 *
 * Exact mode is a full sequential scan on the watched instance — confirm first.
 */
export function MeasureBloat({
  action,
  instanceId,
  schema,
  table,
  sizeBytes,
  estimatedPct,
  measurement,
  canMeasure,
  blockedReason,
}: {
  action: (formData: FormData) => void;
  instanceId: number;
  schema: string;
  table: string;
  sizeBytes: number;
  estimatedPct: number | null;
  measurement: BloatMeasurementRow | null;
  canMeasure: boolean;
  blockedReason: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (measurement && (measurement.state === 'pendiente' || measurement.state === 'corriendo')) {
    return (
      <span className="text-[11px] text-foreground-muted">
        {measurement.state === 'corriendo' ? 'measuring…' : 'queued'}
      </span>
    );
  }

  if (measurement && measurement.state === 'error') {
    return (
      <span className="text-[11px] text-[var(--error)]" title={measurement.error ?? ''}>
        failed
      </span>
    );
  }

  if (measurement && measurement.state === 'listo') {
    const delta =
      measurement.estimatedPct !== null && measurement.deadPct !== null
        ? measurement.estimatedPct - measurement.deadPct
        : null;
    return (
      <span title={`measured by ${measurement.requestedBy} · mode ${measurement.mode}`}>
        {formatBytes((measurement.deadBytes ?? 0) + (measurement.freeBytes ?? 0))}
        <span className="ml-1 text-[10px] text-foreground-muted">
          {measurement.deadPct?.toFixed(1)}% dead, {measurement.freePct?.toFixed(1)}% free
        </span>
        {delta !== null && Math.abs(delta) >= 5 && (
          <span className="tag tag--warn ml-1.5">
            the estimate was off by {Math.abs(delta).toFixed(0)} pt
          </span>
        )}
      </span>
    );
  }

  if (!canMeasure) {
    return (
      <span className="text-[11px] text-foreground-muted" title={blockedReason ?? ''}>
        not available
      </span>
    );
  }

  if (!open) {
    return (
      <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setOpen(true)}>
        measure →
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-[10px] text-foreground-muted">{formatBytes(sizeBytes)} to read</span>
      <form action={action} className="flex gap-1">
        <input type="hidden" name="instanceId" value={instanceId} />
        <input type="hidden" name="schema" value={schema} />
        <input type="hidden" name="table" value={table} />
        <input type="hidden" name="estimatedPct" value={estimatedPct ?? ''} />
        <button
          type="submit"
          name="mode"
          value="aproximado"
          className="text-[11px] text-accent hover:underline"
          title={BLOAT_MODE_HINT.aproximado}
        >
          approximate
        </button>
        <span className="text-[11px] text-foreground-muted">·</span>
        <button
          type="submit"
          name="mode"
          value="exacto"
          className="text-[11px] text-[var(--warning)] hover:underline"
          title={BLOAT_MODE_HINT.exacto}
        >
          exact
        </button>
      </form>
      <button
        type="button"
        className="text-[10px] text-foreground-muted hover:underline"
        onClick={() => setOpen(false)}
      >
        cancel
      </button>
    </div>
  );
}
