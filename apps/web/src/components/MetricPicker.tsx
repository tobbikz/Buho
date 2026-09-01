'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

export interface PickerMetric {
  metric: string;
  label: string;
  family: string;
  unit: string;
}

/**
 * Selector de métricas para la pantalla de Análisis.
 *
 * La selección vive en la URL, no en estado del cliente: así un gráfico armado
 * se comparte pegando el enlace, que es la mitad del valor de una pantalla de
 * análisis en una investigación a cuatro manos.
 *
 * El filtro de texto busca tanto en el nombre legible como en el nombre crudo de
 * la métrica: quien viene de leer documentación de PostgreSQL busca
 * "tup_updated", no "tuplas modificadas".
 */
export function MetricPicker({
  available,
  selected,
  basePath,
  params,
  familyOrder,
}: {
  available: PickerMetric[];
  selected: string[];
  basePath: string;
  params: Record<string, string>;
  familyOrder: string[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState('');
  const [pending, startTransition] = useTransition();

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? available.filter(
          (item) =>
            item.label.toLowerCase().includes(needle) || item.metric.toLowerCase().includes(needle),
        )
      : available;

    const byFamily = new Map<string, PickerMetric[]>();
    for (const item of matching) {
      const list = byFamily.get(item.family) ?? [];
      list.push(item);
      byFamily.set(item.family, list);
    }

    return [...byFamily.entries()].sort(
      ([a], [b]) =>
        (familyOrder.indexOf(a) + 1 || 99) - (familyOrder.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
  }, [available, filter, familyOrder]);

  function navigate(metrics: string[]) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    for (const metric of metrics) search.append('m', metric);
    startTransition(() => router.push(`${basePath}?${search.toString()}`, { scroll: false }));
  }

  function toggle(metric: string) {
    navigate(
      selected.includes(metric) ? selected.filter((item) => item !== metric) : [...selected, metric],
    );
  }

  return (
    <section className="panel" style={{ opacity: pending ? 0.7 : 1 }}>
      <div className="panel-header">
        <span className="panel-title">Metrics</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          {selected.length} de {available.length}
        </span>
      </div>

      <div className="border-b border-border p-2">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filtrar (ej. cpu, tup_updated, wal)"
          className="w-full border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
        />
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => navigate([])}
            className="mt-1.5 text-[11px] text-foreground-muted underline decoration-dotted hover:text-foreground"
          >
            Quitar todas
          </button>
        )}
      </div>

      <div className="table-scroll" style={{ maxHeight: '32rem' }}>
        {groups.length === 0 ? (
          <div className="empty">No metrics match.</div>
        ) : (
          groups.map(([family, items]) => (
            <div key={family}>
              <div className="sticky top-0 border-b border-border bg-surface-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
                {family}
              </div>
              {items.map((item) => {
                const isOn = selected.includes(item.metric);
                return (
                  <label
                    key={item.metric}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-surface-muted"
                    style={{ background: isOn ? 'var(--accent-subtle)' : undefined }}
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => toggle(item.metric)}
                      className="h-3 w-3 accent-[#005eb8]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{item.label}</span>
                      <span className="block truncate font-mono text-[9.5px] text-foreground-muted">
                        {item.metric}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
