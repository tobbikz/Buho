import { OVERVIEW_GRID_COLS } from './overview-builtins';
import type { OverviewWidget } from './overview-layout-types';

export const OVERVIEW_MIN_W = 2;
export const OVERVIEW_MIN_H = 2;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function rectsOverlap(a: OverviewWidget, b: OverviewWidget): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function clampToGrid(w: OverviewWidget): void {
  w.w = clamp(w.w, OVERVIEW_MIN_W, OVERVIEW_GRID_COLS);
  w.h = clamp(w.h, OVERVIEW_MIN_H, 24);
  w.x = clamp(w.x, 0, OVERVIEW_GRID_COLS - w.w);
  w.y = Math.max(0, w.y);
}

/** Shift/shrink `other` so it no longer overlaps `blocker` (prefer horizontal). */
function yieldTo(blocker: OverviewWidget, other: OverviewWidget): void {
  if (other.x >= blocker.x) {
    const newX = blocker.x + blocker.w;
    const oldRight = other.x + other.w;
    if (newX + OVERVIEW_MIN_W <= OVERVIEW_GRID_COLS) {
      other.x = newX;
      other.w = clamp(Math.max(oldRight - newX, OVERVIEW_MIN_W), OVERVIEW_MIN_W, OVERVIEW_GRID_COLS - other.x);
      if (rectsOverlap(blocker, other)) other.y = blocker.y + blocker.h;
    } else {
      other.y = blocker.y + blocker.h;
    }
    return;
  }

  const maxW = blocker.x - other.x;
  if (maxW >= OVERVIEW_MIN_W) {
    other.w = maxW;
    if (rectsOverlap(blocker, other)) other.y = blocker.y + blocker.h;
  } else {
    other.y = blocker.y + blocker.h;
  }
}

/**
 * After moving/resizing `activeId`, push/shrink overlapping tiles so the board
 * never stacks two widgets on the same cells (Superset-style).
 */
export function resolveOverviewCollisions(
  widgets: OverviewWidget[],
  activeId: string,
): OverviewWidget[] {
  const next = widgets.map((w) => ({ ...w }));
  const active = next.find((w) => w.id === activeId);
  if (!active) return next;
  clampToGrid(active);

  for (let pass = 0; pass < 32; pass++) {
    let changed = false;

    for (const other of next) {
      if (other.id === activeId || other.hidden) continue;
      clampToGrid(other);
      if (!rectsOverlap(active, other)) continue;
      const before = `${other.x},${other.y},${other.w},${other.h}`;
      yieldTo(active, other);
      clampToGrid(other);
      if (`${other.x},${other.y},${other.w},${other.h}` !== before) changed = true;
    }

    // Cascade: neighbors that now collide with each other (not only with active).
    const others = next
      .filter((w) => w.id !== activeId && !w.hidden)
      .sort((a, b) => a.y - b.y || a.x - b.x);

    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const a = others[i]!;
        const b = others[j]!;
        if (!rectsOverlap(a, b)) continue;
        const before = `${b.x},${b.y},${b.w},${b.h}`;
        yieldTo(a, b);
        clampToGrid(b);
        if (`${b.x},${b.y},${b.w},${b.h}` !== before) changed = true;
      }
    }

    if (!changed) break;
  }

  return next;
}

/** Place `activeId` with `patch` on a snapshot, then resolve overlaps. */
export function placeOverviewWidget(
  snapshot: OverviewWidget[],
  activeId: string,
  patch: Partial<Pick<OverviewWidget, 'x' | 'y' | 'w' | 'h'>>,
): OverviewWidget[] {
  const next = snapshot.map((w) => (w.id === activeId ? { ...w, ...patch } : { ...w }));
  return resolveOverviewCollisions(next, activeId);
}
