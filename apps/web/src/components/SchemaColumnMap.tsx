'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatBytes } from '@/lib/format';

export interface SchemaColumnTable {
  name: string;
  sizeBytes: number;
  columns: { column: string; dataType: string; notNull: boolean; position: number }[];
}

const PAGE_SIZE = 8;

function TableCard({
  table,
  open,
  onToggle,
}: {
  table: SchemaColumnTable;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-[3px] border border-[#8a5a00]/40 bg-[var(--surface)] px-2 py-1.5">
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="truncate font-mono text-[11px] font-semibold text-foreground">{table.name}</div>
        <div className="font-mono text-[10px] text-foreground-muted">
          {table.columns.length > 0 ? `${table.columns.length} columns` : formatBytes(table.sizeBytes)}
          {open ? ' · hide' : ' · show columns'}
        </div>
      </button>
      {open ? (
        <div className="mt-1 max-h-36 overflow-auto border-t border-border pt-1">
          {table.columns.length === 0 ? (
            <p className="font-mono text-[10px] text-foreground-muted">
              Column types arrive on the next catalog sample.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {table.columns.map((column) => (
                <li key={column.position} className="font-mono text-[10px] leading-tight text-foreground">
                  <span className="text-foreground-muted">{column.position} </span>
                  {column.column}
                  <span className="text-foreground-muted"> {column.dataType}</span>
                  {column.notNull ? <span className="text-foreground-muted"> · not null</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SchemaColumnMap({
  instanceId,
  schema,
  schemas,
  tables,
}: {
  instanceId: number;
  schema: string;
  schemas: string[];
  tables: SchemaColumnTable[];
}) {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(tables.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = useMemo(
    () => tables.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE),
    [tables, current],
  );
  const around = [
    visible[0],
    visible[1],
    visible[2],
    visible[3],
    visible[4],
    visible[5],
    visible[6],
    visible[7],
  ];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex w-fit flex-col gap-1 text-[11px] uppercase tracking-wide text-foreground-muted">
        Schema
        <select
          value={schema}
          onChange={(event) => {
            setPage(0);
            setOpen(null);
            router.push(
              `/instances/${instanceId}/topology?vista=detalle&schema=${encodeURIComponent(event.target.value)}`,
            );
          }}
          className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-foreground"
        >
          {schemas.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {around.slice(0, 3).map((table, index) =>
          table ? (
            <TableCard
              key={table.name}
              table={table}
              open={open === table.name}
              onToggle={() => setOpen(open === table.name ? null : table.name)}
            />
          ) : (
            <div key={`empty-top-${index}`} />
          ),
        )}
        {around[3] ? (
          <TableCard
            table={around[3]}
            open={open === around[3].name}
            onToggle={() => setOpen(open === around[3]!.name ? null : around[3]!.name)}
          />
        ) : (
          <div />
        )}
        <div className="flex items-center justify-center rounded-[3px] border border-[#005eb8] bg-[var(--surface)] px-3 py-4 text-center">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-foreground-muted">schema</div>
            <div className="font-mono text-[13px] font-semibold text-foreground">{schema}</div>
            <div className="font-mono text-[10px] text-foreground-muted">{tables.length} tables</div>
          </div>
        </div>
        {around[4] ? (
          <TableCard
            table={around[4]}
            open={open === around[4].name}
            onToggle={() => setOpen(open === around[4]!.name ? null : around[4]!.name)}
          />
        ) : (
          <div />
        )}
        {around.slice(5).map((table, index) =>
          table ? (
            <TableCard
              key={table.name}
              table={table}
              open={open === table.name}
              onToggle={() => setOpen(open === table.name ? null : table.name)}
            />
          ) : (
            <div key={`empty-bot-${index}`} />
          ),
        )}
      </div>

      {pages > 1 ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={current <= 0}
            onClick={() => {
              setOpen(null);
              setPage(current - 1);
            }}
          >
            Previous
          </button>
          <span className="font-mono text-[11px] text-foreground-muted">
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={current >= pages - 1}
            onClick={() => {
              setOpen(null);
              setPage(current + 1);
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
