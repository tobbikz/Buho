'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

const ENGINE_SHORT: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  endpoint: 'HTTP',
};

function kind(engine?: string | null): 'db' | 'http' | 'other' {
  if (engine === 'endpoint') return 'http';
  if (
    engine &&
    ['postgres', 'mariadb', 'mssql', 'oracle'].includes(
      engine,
    )
  ) {
    return 'db';
  }
  return 'other';
}

function label(engine?: string | null): string {
  if (!engine) return 'Service';
  return ENGINE_SHORT[engine] ?? engine;
}

/** Compact HTTP / probe icon. */
export function IconHttp({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="14"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M3 9h18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <circle cx="6.5" cy="6.5" r="0.9" fill="currentColor" />
      <circle cx="9.2" cy="6.5" r="0.9" fill="currentColor" />
      <path
        d="M9 14.5h6M12 11.5v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Database cylinder icon. */
export function IconDatabase({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <ellipse
        cx="12"
        cy="6"
        rx="7"
        ry="2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M5 6v8.5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M5 10.5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function EngineIcon({ engine }: { engine?: string | null }) {
  const k = kind(engine);
  if (k === 'db') return <IconDatabase className="dep-ico dep-ico--db" />;
  if (k === 'http') return <IconHttp className="dep-ico dep-ico--http" />;
  return <IconHttp className="dep-ico dep-ico--other" />;
}

export type ServiceDepRow = {
  fromAlias: string | null;
  fromService: string | null;
  fromEngine: string | null;
  toAlias: string;
  toEngine: string;
  toHost: string;
  toPort: number;
  toInstanceId: number;
};

export type ServiceDepEdgeProps = {
  fromAlias: string;
  fromEngine?: string | null;
  toAlias: string;
  toEngine?: string | null;
  toInstanceId: number;
  toHost?: string | null;
  toPort?: number | null;
};

/** One edge — used on monitor detail. */
export function ServiceDepEdge({
  fromAlias,
  fromEngine,
  toAlias,
  toEngine,
  toInstanceId,
  toHost,
  toPort,
}: ServiceDepEdgeProps) {
  const fromKind = kind(fromEngine ?? 'endpoint');
  const toKind = kind(toEngine);

  return (
    <div className="dep-edge">
      <div className={`dep-edge__node dep-edge__node--${fromKind}`}>
        <EngineIcon engine={fromEngine ?? 'endpoint'} />
        <div className="dep-edge__meta">
          <span className="dep-edge__engine">{label(fromEngine ?? 'endpoint')}</span>
          <span className="dep-edge__alias font-mono">{fromAlias}</span>
        </div>
      </div>

      <div className="dep-edge__link" aria-hidden>
        <span className="dep-edge__line" />
        <span className="dep-edge__caption">depends on</span>
        <span className="dep-edge__line" />
      </div>

      <Link
        href={`/instances/${toInstanceId}`}
        className={`dep-edge__node dep-edge__node--${toKind} dep-edge__node--link`}
      >
        <EngineIcon engine={toEngine} />
        <div className="dep-edge__meta">
          <span className="dep-edge__engine">{label(toEngine)}</span>
          <span className="dep-edge__alias font-mono">{toAlias}</span>
          {toHost != null && toHost !== '' && (
            <span className="dep-edge__host font-mono">
              {toHost}
              {toPort != null ? `:${toPort}` : ''}
            </span>
          )}
        </div>
      </Link>
    </div>
  );
}

export type FanoutTarget = {
  toInstanceId: number;
  toAlias: string;
  toEngine: string;
  toHost?: string | null;
  toPort?: number | null;
  source: 'dep' | 'span';
};

/** One service → many DBs (avoids duplicating the source card). */
export function ServiceDepsFanout({
  fromAlias,
  fromEngine,
  targets,
}: {
  fromAlias: string;
  fromEngine?: string | null;
  targets: FanoutTarget[];
}) {
  const fromKind = kind(fromEngine ?? 'endpoint');
  if (targets.length === 0) return null;
  if (targets.length === 1) {
    const t = targets[0]!;
    return (
      <div>
        <ServiceDepEdge
          fromAlias={fromAlias}
          fromEngine={fromEngine}
          toAlias={t.toAlias}
          toEngine={t.toEngine}
          toInstanceId={t.toInstanceId}
          toHost={t.toHost}
          toPort={t.toPort}
        />
        <div className="text-[10px] text-foreground-muted px-2 pb-2">
          {t.source === 'span' ? 'Inferred from OTLP db.name' : 'Declared in service_deps'}
        </div>
      </div>
    );
  }

  return (
    <div className="dep-fanout">
      <div className={`dep-edge__node dep-edge__node--${fromKind}`}>
        <EngineIcon engine={fromEngine ?? 'endpoint'} />
        <div className="dep-edge__meta">
          <span className="dep-edge__engine">{label(fromEngine ?? 'endpoint')}</span>
          <span className="dep-edge__alias font-mono">{fromAlias}</span>
        </div>
      </div>
      <div className="dep-fanout__hub" aria-hidden>
        <span className="dep-edge__line" />
        <span className="dep-edge__caption">depends on</span>
      </div>
      <div className="dep-fanout__targets">
        {targets.map((t) => (
          <Link
            key={t.toInstanceId}
            href={`/instances/${t.toInstanceId}`}
            className={`dep-edge__node dep-edge__node--${kind(t.toEngine)} dep-edge__node--link`}
            title={
              t.source === 'span' ? 'Inferred from OTLP db.name' : 'Declared in service_deps'
            }
          >
            <EngineIcon engine={t.toEngine} />
            <div className="dep-edge__meta">
              <span className="dep-edge__engine">{label(t.toEngine)}</span>
              <span className="dep-edge__alias font-mono">{t.toAlias}</span>
              {t.toHost != null && t.toHost !== '' && (
                <span className="dep-edge__host font-mono">
                  {t.toHost}
                  {t.toPort != null ? `:${t.toPort}` : ''}
                </span>
              )}
              <span className="text-[9px] text-foreground-muted">
                {t.source === 'span' ? 'OTLP' : 'declared'}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

const CHIP_CAP = 12;

export type DepDbTarget = {
  toInstanceId: number;
  toAlias: string;
  toEngine: string;
  toHost: string;
  toPort: number;
};

/**
 * Fleet view: group by target DB so N endpoints → 1 DB card (scales).
 * DB card → observability filter for endpoints on that DB (not /instances).
 * Chip → focus one monitor. Open-DB lives in the parent banner.
 */
export function ServiceDepsGrouped({
  deps,
  selectedAlias,
  selectedDbId,
  onSelectFrom,
  onSelectDb,
}: {
  deps: ServiceDepRow[];
  selectedAlias?: string | null;
  selectedDbId?: number | null;
  onSelectFrom?: (alias: string) => void;
  onSelectDb?: (db: DepDbTarget) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<
      number,
      {
        toInstanceId: number;
        toAlias: string;
        toEngine: string;
        toHost: string;
        toPort: number;
        from: Array<{ alias: string; engine: string | null }>;
      }
    >();
    for (const d of deps) {
      const alias = d.fromAlias ?? d.fromService;
      if (!alias) continue;
      let g = map.get(d.toInstanceId);
      if (!g) {
        g = {
          toInstanceId: d.toInstanceId,
          toAlias: d.toAlias,
          toEngine: d.toEngine,
          toHost: d.toHost,
          toPort: d.toPort,
          from: [],
        };
        map.set(d.toInstanceId, g);
      }
      if (!g.from.some((f) => f.alias === alias)) {
        g.from.push({ alias, engine: d.fromEngine });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.toAlias.localeCompare(b.toAlias));
  }, [deps]);

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (groups.length === 0) return null;

  return (
    <div className="dep-groups">
      {groups.map((g) => {
        const open = expanded[g.toInstanceId] ?? false;
        const shown = open ? g.from : g.from.slice(0, CHIP_CAP);
        const hidden = g.from.length - shown.length;
        return (
          <div
            key={g.toInstanceId}
            className={`dep-group${selectedDbId === g.toInstanceId ? ' is-selected' : ''}`}
          >
            <button
              type="button"
              className="dep-group__db"
              title="Show endpoints that depend on this database"
              onClick={() =>
                onSelectDb?.({
                  toInstanceId: g.toInstanceId,
                  toAlias: g.toAlias,
                  toEngine: g.toEngine,
                  toHost: g.toHost,
                  toPort: g.toPort,
                })
              }
            >
              <EngineIcon engine={g.toEngine} />
              <div className="dep-edge__meta">
                <span className="dep-edge__engine">{label(g.toEngine)}</span>
                <span className="dep-edge__alias font-mono">{g.toAlias}</span>
                {g.toHost ? (
                  <span className="dep-edge__host font-mono">
                    {g.toHost}:{g.toPort}
                  </span>
                ) : null}
              </div>
              <span className="dep-group__count">{g.from.length}</span>
            </button>
            <div className="dep-group__from">
              <span className="dep-group__from-label">used by</span>
              <div className="dep-group__chips">
                {shown.map((f) => (
                  <button
                    key={f.alias}
                    type="button"
                    className={`dep-chip${selectedAlias === f.alias ? ' is-selected' : ''}`}
                    title={label(f.engine ?? 'endpoint')}
                    onClick={() => onSelectFrom?.(f.alias)}
                  >
                    <IconHttp className="dep-chip__ico" />
                    <span className="font-mono">{f.alias}</span>
                  </button>
                ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="dep-chip dep-chip--more"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [g.toInstanceId]: true }))
                    }
                  >
                    +{hidden} more
                  </button>
                )}
                {open && g.from.length > CHIP_CAP && (
                  <button
                    type="button"
                    className="dep-chip dep-chip--more"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [g.toInstanceId]: false }))
                    }
                  >
                    show less
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
