'use client';

import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Selector de agrupación. La elección va en la URL y no en estado local para
 * que una vista agrupada por cliente se pueda pegar en un chat.
 */
export function GroupBy({ keys, current }: { keys: { key: string; label: string }[]; current: string }) {
  const router = useRouter();
  const params = useSearchParams();

  function change(value: string) {
    const next = new URLSearchParams(params.toString());
    next.set('agrupar', value);
    router.push(`/?${next.toString()}`);
  }

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
      Agrupar por
      <select
        value={current}
        onChange={(event) => change(event.target.value)}
        className="border border-border bg-surface px-1.5 py-0.5 text-[11.5px] text-foreground outline-none focus:border-accent"
      >
        {keys.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  );
}
