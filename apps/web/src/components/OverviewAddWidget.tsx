'use client';

import { useMemo, useState, useTransition } from 'react';
import { Modal } from '@/components/Modal';
import { previewOverviewSqlAction, testOverviewSqlAction } from '@/lib/overview-actions';
import { OVERVIEW_DEFAULT_H, OVERVIEW_DEFAULT_W } from '@/lib/overview-builtins';
import {
  newCustomWidgetId,
  nextWidgetPlacement,
  type OverviewMetricUnit,
  type OverviewSqlMode,
  type OverviewWidget,
} from '@/lib/overview-layout-types';

const SQL_MODE_HELP: Record<OverviewSqlMode, string> = {
  timeseries: 'Needs columns ts + value (+ optional series).',
  table: 'Any columns — rendered as a data table.',
  big_number: 'Uses the first numeric cell (optional string label column).',
  bar: 'Needs label/name + value columns (top ~40 rows).',
};

export function OverviewAddWidget({
  open,
  onClose,
  instanceId,
  availableMetrics,
  widgets,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  instanceId: number;
  availableMetrics: string[];
  widgets: OverviewWidget[];
  onAdd: (widget: OverviewWidget) => void;
}) {
  const [tab, setTab] = useState<'metric' | 'sql'>('metric');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [unit, setUnit] = useState<OverviewMetricUnit>('count');
  const [sql, setSql] = useState(
    `select date_trunc('minute', now()) as ts, 1::float8 as value`,
  );
  const [sqlMode, setSqlMode] = useState<OverviewSqlMode>('timeseries');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return availableMetrics.slice(0, 80);
    return availableMetrics.filter((m) => m.toLowerCase().includes(q)).slice(0, 80);
  }, [availableMetrics, filter]);

  function toggleMetric(metric: string) {
    setPicked((prev) =>
      prev.includes(metric) ? prev.filter((m) => m !== metric) : prev.length >= 6 ? prev : [...prev, metric],
    );
  }

  function submitMetric() {
    setError(null);
    if (picked.length === 0) {
      setError('Pick at least one metric.');
      return;
    }
    const place = nextWidgetPlacement(widgets, OVERVIEW_DEFAULT_W, OVERVIEW_DEFAULT_H);
    onAdd({
      id: newCustomWidgetId('m'),
      kind: 'metric',
      ...place,
      title: title.trim() || picked.join(' · '),
      metrics: picked,
      unit,
    });
    onClose();
    setPicked([]);
    setTitle('');
  }

  function sizeForMode(mode: OverviewSqlMode): { w: number; h: number } {
    if (mode === 'table') return { w: 8, h: 5 };
    if (mode === 'big_number') return { w: 3, h: 3 };
    if (mode === 'bar') return { w: 4, h: 5 };
    return { w: OVERVIEW_DEFAULT_W, h: OVERVIEW_DEFAULT_H };
  }

  function submitSql() {
    setError(null);
    if (!sql.trim()) {
      setError('SQL is required.');
      return;
    }
    const size = sizeForMode(sqlMode);
    const place = nextWidgetPlacement(widgets, size.w, size.h);
    onAdd({
      id: newCustomWidgetId('s'),
      kind: 'sql',
      ...place,
      title: title.trim() || 'Custom SQL',
      sql: sql.trim(),
      sqlMode,
    });
    onClose();
    setTitle('');
    setStatus(null);
  }

  function runTest() {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const result = await testOverviewSqlAction(instanceId, sql, sqlMode);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus(
        `Test OK · ${result.result.message}${result.result.planHint ? ` · ${result.result.planHint}` : ''}`,
      );
    });
  }

  function runPreview() {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const result = await previewOverviewSqlAction(instanceId, sql, sqlMode);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus(`Preview OK · ${result.tested}`);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Add overview widget"
      subtitle="Metrics from the Buho store, or read-only SQL on the Postgres target."
    >
      <div className="overview-add flex flex-col gap-3 text-[12px]">
        <div className="events-view-tabs" role="tablist">
          <button
            type="button"
            className={`tab ${tab === 'metric' ? 'is-active' : ''}`}
            onClick={() => setTab('metric')}
          >
            Metrics
          </button>
          <button
            type="button"
            className={`tab ${tab === 'sql' ? 'is-active' : ''}`}
            onClick={() => setTab('sql')}
          >
            SQL (advanced)
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-foreground-muted">Title</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tab === 'metric' ? 'Optional — defaults to metric names' : 'Custom SQL'}
          />
        </label>

        {tab === 'metric' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-foreground-muted">Unit</span>
              <select
                className="input"
                value={unit}
                onChange={(e) => setUnit(e.target.value as OverviewMetricUnit)}
              >
                <option value="count">count</option>
                <option value="rate">rate /s</option>
                <option value="pct">percent</option>
                <option value="bytes">bytes</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-foreground-muted">Filter metrics</span>
              <input
                className="input"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="connections, wal, …"
              />
            </label>
            <div className="overview-add__metric-list max-h-48 overflow-auto rounded border border-border p-2 space-y-1">
              {filtered.length === 0 ? (
                <p className="text-foreground-muted m-0">No metrics match.</p>
              ) : (
                filtered.map((metric) => (
                  <label key={metric} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={picked.includes(metric)}
                      onChange={() => toggleMetric(metric)}
                    />
                    <span className="font-mono text-[11px]">{metric}</span>
                  </label>
                ))
              )}
            </div>
            <p className="m-0 text-foreground-muted font-mono text-[10px]">
              Selected: {picked.length || 'none'} (max 6)
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={submitMetric}>
                Add metric widget
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-foreground-secondary">
              PostgreSQL target only. Single <code>SELECT</code> / <code>WITH…SELECT</code>.{' '}
              {SQL_MODE_HELP[sqlMode]}
            </p>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-foreground-muted">Viz mode</span>
              <select
                className="input"
                value={sqlMode}
                onChange={(e) => setSqlMode(e.target.value as OverviewSqlMode)}
              >
                <option value="timeseries">Line · timeseries</option>
                <option value="table">Table</option>
                <option value="big_number">Big number</option>
                <option value="bar">Bar · ranked</option>
              </select>
            </label>
            <label className="overview-add__sql flex flex-col gap-1 flex-1 min-h-0">
              <span className="font-mono text-[10px] text-foreground-muted">SQL</span>
              <textarea
                className="input font-mono text-[11px] overview-add__sql-editor"
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                spellCheck={false}
              />
            </label>
            {status ? (
              <p className="m-0 font-mono text-[10px]" style={{ color: 'var(--success)' }}>
                {status}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 flex-wrap">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={pending} onClick={runTest}>
                {pending ? 'Testing…' : 'Test'}
              </button>
              <button type="button" className="btn" disabled={pending} onClick={runPreview}>
                {pending ? 'Preview…' : 'Preview'}
              </button>
              <button type="button" className="btn btn--primary" onClick={submitSql}>
                Add SQL widget
              </button>
            </div>
          </>
        )}

        {error ? (
          <p className="m-0 text-[12px]" style={{ color: 'var(--error)' }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
