'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';

/**
 * Refresco silencioso mientras hay algo en curso.
 *
 * Distinto de AutoRefresh: ése es para vistas de salud, cada 30 s y con botón de
 * pausa visible. Acá no hay nada que pausar —del otro lado hay una persona
 * esperando un resultado que llega en un segundo— y no debe dibujar controles.
 */
export function PollWhilePending({ intervalMs = 1500 }: { intervalMs?: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  useEffect(() => {
    const timer = setInterval(() => startTransition(() => router.refresh()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, router]);

  return null;
}
