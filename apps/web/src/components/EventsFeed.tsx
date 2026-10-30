'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { Modal } from '@/components/Modal';
import { formatClock } from '@/lib/format';
import type { CollectorEvent, EventFeedView } from '@/lib/queries';

const LEVELS = ['all', 'error', 'warn', 'info'] as const;
type LevelFilter = (typeof LEVELS)[number];

const LEVEL_TAG: Record<CollectorEvent['level'], string> = {
  error: 'tag--error',
  warn: 'tag--warn',
  info: 'tag--muted',
};

const LEVEL_STRIPE: Record<CollectorEvent['level'], string> = {
  error: 'event-card--error',
  warn: 'event-card--warn',
  info: 'event-card--info',
};

const STATUS_LABEL: Record<CollectorEvent['status'], string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
};

function formatWhen(at: Date | string | null): string {
  if (!at) return '—';
  const date = at instanceof Date ? at : new Date(at);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function previewMessage(message: string, max = 120): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function formatDetail(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail.trim() || null;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export function EventsFeed({
  events,
  view,
  canAcknowledge,
  onAcknowledge,
  onAcknowledgeAll,
}: {
  events: CollectorEvent[];
  view: EventFeedView;
  canAcknowledge: boolean;
  onAcknowledge: (eventIds: number[]) => Promise<void>;
  onAcknowledgeAll: () => Promise<void>;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [selected, setSelected] = useState<CollectorEvent | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((event) => event.level === filter);
  }, [events, filter]);

  const counts = useMemo(() => {
    const base = { error: 0, warn: 0, info: 0 };
    for (const event of events) base[event.level] += 1;
    return base;
  }, [events]);

  function switchView(next: EventFeedView) {
    const params = new URLSearchParams(window.location.search);
    if (next === 'open') params.delete('view');
    else params.set('view', next);
    const query = params.toString();
    router.push(query ? `/events?${query}` : '/events');
  }

  function ack(eventId: number) {
    startTransition(async () => {
      await onAcknowledge([eventId]);
      if (selected?.eventId === eventId) setSelected(null);
      router.refresh();
    });
  }

  function ackAll() {
    startTransition(async () => {
      await onAcknowledgeAll();
      setSelected(null);
      router.refresh();
    });
  }

  return (
    <>
      <div className="events-toolbar">
        <div className="events-view-tabs" role="tablist" aria-label="Event feed">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'open'}
            className={`tag ${view === 'open' ? 'tag--info' : 'tag--muted'}`}
            onClick={() => switchView('open')}
          >
            Open
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'history'}
            className={`tag ${view === 'history' ? 'tag--info' : 'tag--muted'}`}
            onClick={() => switchView('history')}
          >
            History
          </button>
        </div>

        <div className="events-toolbar__actions">
          <div className="events-filters" role="group" aria-label="Filter by level">
            {LEVELS.map((level) => {
              const label =
                level === 'all'
                  ? `All ${events.length}`
                  : level === 'error'
                    ? `Error ${counts.error}`
                    : level === 'warn'
                      ? `Warn ${counts.warn}`
                      : `Info ${counts.info}`;
              return (
                <button
                  key={level}
                  type="button"
                  className={`tag ${filter === level ? 'tag--info' : 'tag--muted'}`}
                  onClick={() => setFilter(level)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {view === 'open' && canAcknowledge && events.length > 0 ? (
            <button type="button" className="btn btn--sm" disabled={pending} onClick={ackAll}>
              Acknowledge all
            </button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {view === 'open' ? 'No open events. Check History for the full log.' : 'No events in history yet.'}
        </div>
      ) : (
        <div className="events-list">
          {visible.map((event) => {
            const occurrences = event.occurrences ?? 1;
            return (
              <article
                key={`${view}:${event.eventId}`}
                className={`event-card event-card--compact ${LEVEL_STRIPE[event.level]}`}
              >
                <div className="event-card__head">
                  <button
                    type="button"
                    className="event-card__summary"
                    onClick={() => setSelected(event)}
                  >
                    <div className="event-card__meta">
                      <time className="event-card__time" dateTime={new Date(event.ts).toISOString()}>
                        {formatClock(event.ts)}
                      </time>
                      <span className={`tag ${LEVEL_TAG[event.level]}`}>{event.level}</span>
                      {view === 'history' && event.status !== 'open' ? (
                        <span className="tag tag--muted">{STATUS_LABEL[event.status]}</span>
                      ) : null}
                      <span className="event-card__component">{event.component}</span>
                      {event.instanceAlias && event.instanceId ? (
                        <Link
                          href={`/instances/${event.instanceId}`}
                          className="event-card__instance"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {event.instanceAlias}
                        </Link>
                      ) : (
                        <span className="event-card__instance event-card__instance--muted">fleet</span>
                      )}
                      {view === 'open' && occurrences > 1 ? (
                        <span className="event-card__count">×{occurrences}</span>
                      ) : null}
                    </div>
                    <p className="event-card__preview">{previewMessage(event.message)}</p>
                  </button>

                  {view === 'open' && canAcknowledge ? (
                    <button
                      type="button"
                      className="btn btn--sm event-card__ack"
                      disabled={pending}
                      onClick={() => ack(event.eventId)}
                      title="Mark as acknowledged (hides all matching repeats)"
                    >
                      Acknowledge
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={selected !== null}
        title={selected?.component ?? 'Event'}
        subtitle={
          selected
            ? `${selected.level} · ${selected.instanceAlias ?? 'fleet'} · ${formatWhen(selected.ts)}`
            : undefined
        }
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="flex flex-wrap gap-2">
              <span className={`tag ${LEVEL_TAG[selected.level]}`}>{selected.level}</span>
              {view === 'history' ? (
                <span className="tag tag--muted">{STATUS_LABEL[selected.status]}</span>
              ) : null}
              {(selected.occurrences ?? 1) > 1 ? (
                <span className="font-mono text-[10px] text-foreground-muted">
                  ×{selected.occurrences} occurrences
                </span>
              ) : null}
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                Message
              </div>
              <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                {selected.message}
              </p>
            </div>
            {formatDetail(selected.detail) ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                  Detail
                </div>
                <pre className="m-0 text-[11px] whitespace-pre-wrap break-words text-foreground-secondary">
                  {formatDetail(selected.detail)}
                </pre>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {selected.instanceId ? (
                <Link href={`/instances/${selected.instanceId}`} className="btn text-[11px]">
                  Open instance
                </Link>
              ) : null}
              {view === 'open' && canAcknowledge ? (
                <button
                  type="button"
                  className="btn text-[11px]"
                  disabled={pending}
                  onClick={() => ack(selected.eventId)}
                >
                  Acknowledge
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
