/** Build list ↔ detail URLs that preserve Discover context (service / window / q / absolute range). */

export type TraceListContext = {
  service?: string | null;
  w?: string | null;
  q?: string | null;
  /** ISO absolute range start (inclusive). */
  from?: string | null;
  /** ISO absolute range end (inclusive). */
  to?: string | null;
};

export function tracesListHref(ctx: TraceListContext = {}): string {
  const p = new URLSearchParams();
  const from = ctx.from?.trim();
  const to = ctx.to?.trim();
  if (from || to) {
    if (from) p.set('from', from);
    if (to) p.set('to', to);
  } else if (ctx.w?.trim()) {
    p.set('w', ctx.w.trim());
  }
  if (ctx.service?.trim()) p.set('service', ctx.service.trim());
  if (ctx.q?.trim()) p.set('q', ctx.q.trim());
  const qs = p.toString();
  return qs ? `/observability/apm/traces?${qs}` : '/observability/apm/traces';
}

export function traceDetailHref(traceId: string, ctx: TraceListContext = {}): string {
  const p = new URLSearchParams();
  const from = ctx.from?.trim();
  const to = ctx.to?.trim();
  if (from || to) {
    if (from) p.set('from', from);
    if (to) p.set('to', to);
  } else if (ctx.w?.trim()) {
    p.set('w', ctx.w.trim());
  }
  if (ctx.service?.trim()) p.set('service', ctx.service.trim());
  if (ctx.q?.trim()) p.set('q', ctx.q.trim());
  const qs = p.toString();
  return qs
    ? `/observability/apm/${encodeURIComponent(traceId)}?${qs}`
    : `/observability/apm/${encodeURIComponent(traceId)}`;
}
