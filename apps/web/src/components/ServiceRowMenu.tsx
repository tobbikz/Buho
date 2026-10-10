'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InventoryEntity } from '@/lib/obs-infra';
import { servicePath } from '@/lib/obs-service';

type MenuPos = { top: number; left: number; openUp: boolean };

export function ServiceRowMenu({ entity }: { entity: InventoryEntity }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuH = 280;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuH && rect.top > spaceBelow;
    setPos({
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - 200),
      openUp,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      const t = ev.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  async function rename() {
    const next = window.prompt('New service name', entity.name)?.trim();
    if (!next || next === entity.name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/observability/services/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rename', service: entity.name, newName: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; href?: string };
      if (!res.ok) {
        setError(data.error ?? 'Rename failed');
        return;
      }
      setOpen(false);
      router.push(data.href ?? servicePath(next));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(scope: 'probe' | 'apm' | 'all') {
    const label =
      scope === 'probe'
        ? 'Delete PROBE only?'
        : scope === 'apm'
          ? 'Delete APM traces for this service?'
          : 'Delete PROBE + APM data for this service?';
    if (!window.confirm(`${label}\n\n${entity.name}`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/observability/services/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', service: entity.name, scope }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const msg = data.error ?? 'Delete failed';
        setError(msg);
        window.alert(msg);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const menu =
    open && mounted && pos
      ? createPortal(
          <div
            ref={menuRef}
            className="svc-row-menu__dropdown svc-row-menu__dropdown--portal"
            role="menu"
            style={
              pos.openUp
                ? {
                    position: 'fixed',
                    left: pos.left,
                    bottom: typeof window !== 'undefined' ? window.innerHeight - pos.top : 0,
                    top: 'auto',
                  }
                : { position: 'fixed', top: pos.top, left: pos.left }
            }
          >
            <Link
              role="menuitem"
              className="svc-row-menu__item"
              href={entity.href}
              onClick={() => setOpen(false)}
            >
              Open service
            </Link>
            {entity.hasUptime ? (
              <Link
                role="menuitem"
                className="svc-row-menu__item"
                href={servicePath(entity.name, 'uptime')}
                onClick={() => setOpen(false)}
              >
                Edit probe
              </Link>
            ) : null}
            {entity.hasTraces ? (
              <Link
                role="menuitem"
                className="svc-row-menu__item"
                href={servicePath(entity.name, 'traces')}
                onClick={() => setOpen(false)}
              >
                View APM traces
              </Link>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="svc-row-menu__item"
              disabled={busy}
              onClick={() => void rename()}
            >
              Rename…
            </button>
            <div className="svc-row-menu__sep" />
            {entity.hasUptime ? (
              <button
                type="button"
                role="menuitem"
                className="svc-row-menu__item svc-row-menu__item--danger"
                disabled={busy}
                onClick={() => void remove('probe')}
              >
                Delete PROBE
              </button>
            ) : null}
            {entity.hasTraces ? (
              <button
                type="button"
                role="menuitem"
                className="svc-row-menu__item svc-row-menu__item--danger"
                disabled={busy}
                onClick={() => void remove('apm')}
              >
                Delete APM data
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="svc-row-menu__item svc-row-menu__item--danger"
              disabled={busy}
              onClick={() => void remove('all')}
            >
              Delete service…
            </button>
            {error ? <div className="svc-row-menu__error">{error}</div> : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="svc-row-menu">
      <button
        ref={triggerRef}
        type="button"
        className="svc-row-menu__trigger"
        aria-label={`Actions for ${entity.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {menu}
    </div>
  );
}

