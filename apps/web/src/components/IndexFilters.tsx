'use client';

export function IndexFilters({
  action,
  status,
  schema,
  schemas,
  q,
  sort,
  dir,
  footprintSchema,
  footprintQuery,
}: {
  action: string;
  status: string;
  schema: string | null;
  schemas: { schema: string; indexes: number }[];
  q: string;
  sort: string;
  dir: string;
  footprintSchema: string | null;
  footprintQuery: string;
}) {
  return (
    <form action={action} className="mb-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="sort" value={sort} />
      <input type="hidden" name="dir" value={dir} />
      {footprintSchema ? <input type="hidden" name="fp" value={footprintSchema} /> : null}
      {footprintQuery ? <input type="hidden" name="ft" value={footprintQuery} /> : null}
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-foreground-muted">
        Status
        <select
          name="filter"
          defaultValue={status}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-foreground"
        >
          <option value="all">All statuses</option>
          <option value="redundant">Redundant</option>
          <option value="unused">Unused</option>
          <option value="invalid">Invalid</option>
          <option value="ok">Healthy</option>
          <option value="bloated">Fragmented</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-foreground-muted">
        Schema
        <select
          name="schema"
          defaultValue={schema ?? ''}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="max-w-[18rem] rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-foreground"
        >
          <option value="">All schemas</option>
          {schemas.map((group) => (
            <option key={group.schema} value={group.schema}>
              {group.schema} ({group.indexes})
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-[11px] uppercase tracking-wide text-foreground-muted">
        Search
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Index, table, or definition"
          className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-foreground"
        />
      </label>
      <button type="submit" className="btn-secondary">
        Search
      </button>
    </form>
  );
}

export function FootprintFilters({
  action,
  status,
  schema,
  q,
  sort,
  dir,
  page,
  schemas,
  footprintSchema,
  footprintQuery,
}: {
  action: string;
  status: string;
  schema: string | null;
  q: string;
  sort: string;
  dir: string;
  page: number;
  schemas: { schema: string }[];
  footprintSchema: string | null;
  footprintQuery: string;
}) {
  return (
    <form action={action} className="mb-4 flex flex-wrap items-end gap-3">
      {status !== 'all' ? <input type="hidden" name="filter" value={status} /> : null}
      {schema ? <input type="hidden" name="schema" value={schema} /> : null}
      {q ? <input type="hidden" name="q" value={q} /> : null}
      <input type="hidden" name="sort" value={sort} />
      <input type="hidden" name="dir" value={dir} />
      {page > 1 ? <input type="hidden" name="page" value={page} /> : null}
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-foreground-muted">
        Schema
        <select
          name="fp"
          defaultValue={footprintSchema ?? ''}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="max-w-[18rem] rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-foreground"
        >
          <option value="">All schemas</option>
          {schemas.map((group) => (
            <option key={group.schema} value={group.schema}>
              {group.schema}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-[11px] uppercase tracking-wide text-foreground-muted">
        Table
        <input
          type="text"
          name="ft"
          defaultValue={footprintQuery}
          placeholder="Schema or table"
          className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px] normal-case tracking-normal text-foreground"
        />
      </label>
      <button type="submit" className="btn-secondary">
        Filter
      </button>
    </form>
  );
}
