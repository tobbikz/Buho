'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SchemaColumnTable {
  name: string;
  sizeBytes: number;
  columns: { column: string; dataType: string; notNull: boolean; position: number }[];
}

const PAGE_SIZE = 8;
const CARD_W = 210;
const HEADER = 28;
const ROW = 15;
const MAX_ROWS = 8;

interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  columns: SchemaColumnTable['columns'];
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxesRef = useRef<Box[]>([]);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(tables.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = useMemo(
    () => tables.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE),
    [tables, current],
  );
  const opened = tables.find((table) => table.name === open) ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const paint = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#f4f6f8';
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const boxes: Box[] = visible.map((table, index) => {
        const rows = Math.min(table.columns.length, MAX_ROWS) + (table.columns.length > MAX_ROWS ? 1 : 0);
        const h = HEADER + Math.max(rows, 1) * ROW + 8;
        const angle = (index / Math.max(visible.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const reach = Math.min(width, height) * 0.34;
        return {
          name: table.name,
          x: cx + Math.cos(angle) * reach - CARD_W / 2,
          y: cy + Math.sin(angle) * reach - h / 2,
          w: CARD_W,
          h,
          columns: table.columns,
        };
      });
      boxesRef.current = boxes;

      ctx.strokeStyle = '#c5ced8';
      ctx.lineWidth = 1;
      for (const box of boxes) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(box.x + box.w / 2, box.y + 14);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#005eb8';
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#6e7680';
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SCHEMA', cx, cy - 16);
      ctx.fillStyle = '#1c2430';
      ctx.font = '600 12px ui-monospace, SFMono-Regular, monospace';
      const hub = schema.length > 16 ? `${schema.slice(0, 15)}…` : schema;
      ctx.fillText(hub, cx, cy + 2);
      ctx.fillStyle = '#6e7680';
      ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(`${tables.length} tables`, cx, cy + 18);

      for (const box of boxes) {
        ctx.fillStyle = '#fff7ee';
        ctx.strokeStyle = '#c47a2c';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, box.w, box.h, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#8a5a00';
        ctx.fillRect(box.x, box.y, box.w, 22);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const title = box.name.length > 24 ? `${box.name.slice(0, 23)}…` : box.name;
        ctx.fillText(title, box.x + 8, box.y + 11);

        const shown = box.columns.slice(0, MAX_ROWS);
        ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
        shown.forEach((column, row) => {
          const y = box.y + HEADER + row * ROW;
          ctx.fillStyle = '#1c2430';
          const name = column.column.length > 16 ? `${column.column.slice(0, 15)}…` : column.column;
          ctx.fillText(name, box.x + 8, y);
          ctx.fillStyle = '#6e7680';
          ctx.textAlign = 'right';
          const type = column.dataType.length > 14 ? `${column.dataType.slice(0, 13)}…` : column.dataType;
          ctx.fillText(type, box.x + box.w - 8, y);
          ctx.textAlign = 'left';
        });
        if (box.columns.length === 0) {
          ctx.fillStyle = '#6e7680';
          ctx.fillText('columns on next sample', box.x + 8, box.y + HEADER);
        } else if (box.columns.length > MAX_ROWS) {
          ctx.fillStyle = '#8a5a00';
          ctx.fillText(`+${box.columns.length - MAX_ROWS} more`, box.x + 8, box.y + HEADER + MAX_ROWS * ROW);
        }
      }
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [schema, tables.length, visible]);

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const hit = boxesRef.current.find((item) => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
    setOpen(hit && hit.name !== open ? hit.name : null);
  };

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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_18rem]">
        <canvas
          ref={canvasRef}
          onClick={onClick}
          className="h-[72vh] min-h-[520px] w-full cursor-pointer rounded-[3px] border border-border"
        />
        <aside className="panel">
          <div className="panel-header">
            <span className="panel-title">{opened ? opened.name : schema}</span>
          </div>
          <div className="panel-body">
            {opened ? (
              <ul className="flex max-h-[60vh] flex-col gap-1 overflow-auto">
                {opened.columns.length === 0 ? (
                  <li className="text-[12px] text-foreground-muted">Column types arrive on the next catalog sample.</li>
                ) : (
                  opened.columns.map((column) => (
                    <li key={column.position} className="font-mono text-[11px] text-foreground">
                      <span className="text-foreground-muted">{column.position} </span>
                      {column.column}
                      <span className="text-foreground-muted"> {column.dataType}</span>
                      {column.notNull ? <span className="text-foreground-muted"> · not null</span> : null}
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <p className="text-[12px] text-foreground-secondary">
                Tables sit around the schema. Each box lists columns and types. Click one to read the full list.
              </p>
            )}
          </div>
        </aside>
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
