'use client';

import { useEffect, useMemo, useState } from 'react';

export const LIST_PAGE_SIZE = 10;

export function useListPage<T>(items: T[], pageSize = LIST_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const rows = useMemo(
    () => items.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [items, safePage, pageSize],
  );

  useEffect(() => {
    setPage(0);
  }, [items]);

  return { page: safePage, setPage, pageCount, rows, pageSize };
}

export function ListPager({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
      <span className="font-mono text-[11px] text-foreground-muted">
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="tag tag--muted"
          style={{ cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.5 : 1 }}
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
        >
          Prev
        </button>
        <span className="font-mono text-[11px] text-foreground-muted">
          {page + 1}/{pageCount}
        </span>
        <button
          type="button"
          className="tag tag--muted"
          style={{
            cursor: page >= pageCount - 1 ? 'default' : 'pointer',
            opacity: page >= pageCount - 1 ? 0.5 : 1,
          }}
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
        >
          Next
        </button>
      </div>
    </div>
  );
}
