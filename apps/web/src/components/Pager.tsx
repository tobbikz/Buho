'use client';

export const GROUPS_PER_PAGE = 8;
export const ROWS_PER_PAGE = 8;

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

export function slicePage<T>(items: T[], page: number, size: number): T[] {
  const start = (Math.min(page, pageCount(items.length, size)) - 1) * size;
  return items.slice(start, start + size);
}

export function Pager({
  page,
  total,
  size,
  onPage,
  label,
}: {
  page: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
  label: string;
}) {
  const pages = pageCount(total, size);
  if (pages <= 1) return null;
  const current = Math.min(page, pages);
  const from = (current - 1) * size + 1;
  const to = Math.min(current * size, total);

  return (
    <nav className="pager" aria-label={label}>
      <span className="pager__status">
        {from}–{to} of {total}
      </span>
      <button type="button" className="btn" disabled={current <= 1} onClick={() => onPage(current - 1)}>
        Previous
      </button>
      <span className="pager__status">
        {current} / {pages}
      </span>
      <button type="button" className="btn" disabled={current >= pages} onClick={() => onPage(current + 1)}>
        Next
      </button>
    </nav>
  );
}
