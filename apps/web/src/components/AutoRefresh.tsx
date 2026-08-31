'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/**
 * Refresco por polling desde el cliente. El estándar de la consola es 30 s
 * para vistas de salud (ver Design System Hub) y el operador siempre puede
 * pausarlo: nada peor que la tabla que estás leyendo se recargue sola.
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => startTransition(() => router.refresh()), intervalMs);
    return () => clearInterval(timer);
  }, [paused, intervalMs, router]);

  return (
    <div className="flex items-center gap-2">
      {/* El contador de frescura se quitó a propósito: cada segundo re-renderizaba
          el topbar para decir algo que el propio dato ya muestra. La frescura por
          instancia sigue en la tabla de flota y en el encabezado del detalle. */}
      {pending ? <span className="font-mono text-[10px] text-foreground-muted">actualizando…</span> : null}
      <button type="button" className="btn-secondary" onClick={() => setPaused((value) => !value)}>
        {paused ? 'Reanudar' : 'Pausar'}
      </button>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
      >
        Refrescar
      </button>
    </div>
  );
}
