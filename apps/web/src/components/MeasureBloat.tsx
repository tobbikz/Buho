'use client';

import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import { BLOAT_MODE_HINT, type BloatMeasurementRow } from '@/lib/bloat-types';

/**
 * Celda de bloat medido: muestra lo que ya se midió, o el botón para medir.
 *
 * El botón abre una confirmación antes de encolar, y no por cortesía: la
 * medición exacta es un escaneo secuencial completo de la tabla contra la base
 * del cliente. Quien lo aprieta tiene que ver primero el tamaño de la tabla y
 * saber lo que está pidiendo.
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
        {measurement.state === 'corriendo' ? 'midiendo…' : 'en cola'}
      </span>
    );
  }

  if (measurement && measurement.state === 'error') {
    return (
      <span className="text-[11px] text-[var(--error)]" title={measurement.error ?? ''}>
        falló
      </span>
    );
  }

  if (measurement && measurement.state === 'listo') {
    // La diferencia contra la estimación es el dato interesante: si en este
    // servidor la estimación acierta, no hace falta volver a medir nada.
    const desvio =
      measurement.estimatedPct !== null && measurement.deadPct !== null
        ? measurement.estimatedPct - measurement.deadPct
        : null;
    return (
      <span title={`medido por ${measurement.requestedBy} · modo ${measurement.mode}`}>
        {formatBytes((measurement.deadBytes ?? 0) + (measurement.freeBytes ?? 0))}
        <span className="ml-1 text-[10px] text-foreground-muted">
          {measurement.deadPct?.toFixed(1)}% muerto, {measurement.freePct?.toFixed(1)}% libre
        </span>
        {desvio !== null && Math.abs(desvio) >= 5 && (
          <span className="tag tag--warn ml-1.5">
            la estimación erraba {Math.abs(desvio).toFixed(0)} pt
          </span>
        )}
      </span>
    );
  }

  if (!canMeasure) {
    return (
      <span className="text-[11px] text-foreground-muted" title={blockedReason ?? ''}>
        no disponible
      </span>
    );
  }

  if (!open) {
    return (
      <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setOpen(true)}>
        medir →
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-[10px] text-foreground-muted">{formatBytes(sizeBytes)} a leer</span>
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
          aproximado
        </button>
        <span className="text-[11px] text-foreground-muted">·</span>
        <button
          type="submit"
          name="mode"
          value="exacto"
          className="text-[11px] text-[var(--warning)] hover:underline"
          title={BLOAT_MODE_HINT.exacto}
        >
          exacto
        </button>
      </form>
      <button
        type="button"
        className="text-[10px] text-foreground-muted hover:underline"
        onClick={() => setOpen(false)}
      >
        cancelar
      </button>
    </div>
  );
}
