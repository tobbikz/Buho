'use client';

import { useEffect, useState } from 'react';
import { formatAgo } from '@/lib/format';

/**
 * Relative timestamps use Date.now(), so SSR HTML and the first client paint
 * often disagree by a second (React hydration mismatch on Fleet cards).
 * Render a stable placeholder until mount, then live-update.
 */
export function RelativeTime({
  at,
  className,
  empty = '—',
}: {
  at: Date | string | null;
  className?: string;
  empty?: string;
}) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setLabel(formatAgo(at));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [at]);

  return <span className={className}>{label ?? empty}</span>;
}
