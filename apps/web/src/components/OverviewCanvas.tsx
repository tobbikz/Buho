'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { OverviewAddWidget } from '@/components/OverviewAddWidget';
import {
  resetOverviewLayoutAction,
  saveOverviewLayoutAction,
} from '@/lib/overview-actions';
import {
  OVERVIEW_GRID_COLS,
  OVERVIEW_ROW_HEIGHT,
  PG_OVERVIEW_BUILTIN_LABEL,
  isPgOverviewBuiltinId,
} from '@/lib/overview-builtins';
import { OVERVIEW_MIN_H, OVERVIEW_MIN_W, placeOverviewWidget } from '@/lib/overview-grid';
import type { OverviewLayout, OverviewWidget } from '@/lib/overview-layout-types';

const COL_GAP = 14;
const ROW_GAP = 14;

function widgetLabel(w: OverviewWidget): string {
  if (w.title) return w.title;
  if (w.kind === 'builtin' && isPgOverviewBuiltinId(w.id)) return PG_OVERVIEW_BUILTIN_LABEL[w.id];
  if (w.kind === 'metric') return (w.metrics ?? []).join(' · ') || 'Metric widget';
  return 'SQL widget';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

type DragMode = 'move' | 'resize';

export function OverviewCanvas({
  instanceId,
  canEdit,
  initialLayout,
  availableMetrics,
  slots,
}: {
  instanceId: number;
  canEdit: boolean;
  initialLayout: OverviewLayout;
  availableMetrics: string[];
  slots: Record<string, ReactNode>;
}) {
  const router = useRouter();
  const boardRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<OverviewLayout>(initialLayout);
  const [addOpen, setAddOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    mode: DragMode;
    startX: number;
    startY: number;
    orig: OverviewWidget;
    colW: number;
    /** Layout at pointer-down — resolve collisions from this so shrink does not compound. */
    snapshot: OverviewWidget[];
  } | null>(null);

  useEffect(() => {
    setLayout(initialLayout);
  }, [initialLayout]);

  const visible = useMemo(
    () => (editing ? layout.widgets : layout.widgets.filter((w) => !w.hidden)),
    [editing, layout.widgets],
  );

  const measureColW = useCallback(() => {
    const el = boardRef.current;
    if (!el) return 80;
    const width = el.clientWidth;
    return (width - COL_GAP * (OVERVIEW_GRID_COLS - 1)) / OVERVIEW_GRID_COLS;
  }, []);

  function onPointerDown(id: string, mode: DragMode, event: ReactPointerEvent) {
    if (!editing) return;
    event.preventDefault();
    event.stopPropagation();
    const widget = layout.widgets.find((w) => w.id === id);
    if (!widget) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setActiveId(id);
    dragRef.current = {
      id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      orig: { ...widget },
      colW: measureColW(),
      snapshot: layout.widgets.map((w) => ({ ...w })),
    };
  }

  function onPointerMove(event: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const colStep = drag.colW + COL_GAP;
    const rowStep = OVERVIEW_ROW_HEIGHT + ROW_GAP;

    let patch: Partial<Pick<OverviewWidget, 'x' | 'y' | 'w' | 'h'>>;
    if (drag.mode === 'move') {
      const dCol = Math.round(dx / colStep);
      const dRow = Math.round(dy / rowStep);
      patch = {
        x: clamp(drag.orig.x + dCol, 0, OVERVIEW_GRID_COLS - drag.orig.w),
        y: Math.max(0, drag.orig.y + dRow),
        w: drag.orig.w,
        h: drag.orig.h,
      };
    } else {
      const dCol = Math.round(dx / colStep);
      const dRow = Math.round(dy / rowStep);
      patch = {
        x: drag.orig.x,
        y: drag.orig.y,
        w: clamp(drag.orig.w + dCol, OVERVIEW_MIN_W, OVERVIEW_GRID_COLS - drag.orig.x),
        h: clamp(drag.orig.h + dRow, OVERVIEW_MIN_H, 24),
      };
    }

    const widgets = placeOverviewWidget(drag.snapshot, drag.id, patch);
    setLayout((prev) => ({ ...prev, widgets }));
  }

  function onPointerUp(event: ReactPointerEvent) {
    if (!dragRef.current) return;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    dragRef.current = null;
    setActiveId(null);
  }

  function toggleHidden(id: string) {
    setLayout((prev) => ({
      ...prev,
      widgets: prev.widgets.map((w) => (w.id === id ? { ...w, hidden: !w.hidden } : w)),
    }));
  }

  function removeCustom(id: string) {
    setLayout((prev) => ({
      ...prev,
      widgets: prev.widgets.filter((w) => !(w.id === id && w.kind !== 'builtin')),
    }));
  }

  function addWidget(widget: OverviewWidget) {
    setLayout((prev) => ({ ...prev, widgets: [...prev.widgets, widget] }));
    setMessage('Widget added — Save to persist and load data.');
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveOverviewLayoutAction(instanceId, layout);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setLayout(result.layout);
      setEditing(false);
      setMessage('Layout saved.');
      router.refresh();
    });
  }

  function reset() {
    setMessage(null);
    startTransition(async () => {
      const result = await resetOverviewLayoutAction(instanceId);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setLayout(result.layout);
      setEditing(false);
      setMessage('Reset to defaults.');
      router.refresh();
    });
  }

  function cancelEdit() {
    setLayout(initialLayout);
    setEditing(false);
    setMessage(null);
  }

  return (
    <div className="overview-canvas-root flex flex-col gap-[0.875rem]">
      {canEdit ? (
        <div className="overview-canvas__toolbar">
          {!editing ? (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit layout
            </button>
          ) : (
            <>
              <button type="button" className="btn btn--primary" disabled={pending} onClick={save}>
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn" onClick={() => setAddOpen(true)}>
                Add widget
              </button>
              <button type="button" className="btn" disabled={pending} onClick={reset}>
                Reset to defaults
              </button>
              <button type="button" className="btn" onClick={cancelEdit}>
                Cancel
              </button>
              <span className="font-mono text-[10px] text-foreground-muted">
                Drag header to move · SE corner to resize · neighbors shrink / yield
              </span>
            </>
          )}
          {message ? (
            <span className="font-mono text-[10px] text-foreground-secondary">{message}</span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={boardRef}
        className={`overview-board${editing ? ' overview-board--editing' : ''}`}
      >
        {visible.map((widget) => {
          const body = slots[widget.id];
          const missingCustom =
            !body && (widget.kind === 'metric' || widget.kind === 'sql') && editing;
          return (
            <div
              key={widget.id}
              className={`overview-tile${widget.hidden ? ' overview-tile--hidden' : ''}${
                activeId === widget.id ? ' overview-tile--active' : ''
              }`}
              style={{
                gridColumn: `${widget.x + 1} / span ${widget.w}`,
                gridRow: `${widget.y + 1} / span ${widget.h}`,
              }}
            >
              {editing ? (
                <div
                  className="overview-tile__chrome"
                  onPointerDown={(e) => onPointerDown(widget.id, 'move', e)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  <span className="overview-tile__drag">⋮⋮ {widgetLabel(widget)}</span>
                  <div className="overview-tile__actions">
                    <span className="font-mono text-[9px] text-foreground-muted">
                      {widget.w}×{widget.h}
                    </span>
                    {widget.kind === 'builtin' ? (
                      <button
                        type="button"
                        className="tag tag--muted"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => toggleHidden(widget.id)}
                      >
                        {widget.hidden ? 'Show' : 'Hide'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="tag tag--error"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => removeCustom(widget.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="overview-tile__body">
                {body ??
                  (missingCustom ? (
                    <section className="panel">
                      <div className="panel-header">
                        <span className="panel-title">{widgetLabel(widget)}</span>
                      </div>
                      <div className="panel-body text-[12px] text-foreground-secondary">
                        Save layout to load this widget&apos;s data.
                      </div>
                    </section>
                  ) : widget.kind === 'builtin' && widget.hidden && editing ? (
                    <section className="panel overview-canvas__placeholder">
                      <div className="panel-body text-[12px] text-foreground-muted">
                        Hidden: {widgetLabel(widget)}
                      </div>
                    </section>
                  ) : null)}
              </div>
              {editing ? (
                <button
                  type="button"
                  className="overview-tile__resize"
                  aria-label="Resize widget"
                  title="Drag to resize"
                  onPointerDown={(e) => onPointerDown(widget.id, 'resize', e)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {canEdit ? (
        <OverviewAddWidget
          open={addOpen}
          onClose={() => setAddOpen(false)}
          instanceId={instanceId}
          availableMetrics={availableMetrics}
          widgets={layout.widgets}
          onAdd={addWidget}
        />
      ) : null}
    </div>
  );
}
