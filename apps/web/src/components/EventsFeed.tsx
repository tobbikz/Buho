'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
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

function previewMessage(message: string, max = 140): string {
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
  const [expandedId, setExpandedId] = useState<number | null>(null);
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

  function toggle(eventId: number) {
    setExpandedId((current) => (current === eventId ? null : eventId));
  }

  function ack(eventId: number) {
    startTransition(async () => {
      await onAcknowledge([eventId]);
      if (expandedId === eventId) setExpandedId(null);
      router.refresh();
    });
  }

  function ackAll() {
    startTransition(async () => {
      await onAcknowledgeAll();
      setExpandedId(null);
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
            const open = expandedId === event.eventId;
            const detailText = formatDetail(event.detail);
            const occurrences = event.occurrences ?? 1;

            return (
              <article
                key={`${view}:${event.eventId}`}
                className={`event-card ${LEVEL_STRIPE[event.level]} ${open ? 'is-open' : ''}`}
              >
                <div className="event-card__head">
                  <button
                    type="button"
                    className="event-card__toggle"
                    aria-expanded={open}
                    aria-label={open ? 'Collapse details' : 'Expand details'}
                    onClick={() => toggle(event.eventId)}
                  >
                    <span className="event-card__chevron" aria-hidden />
                  </button>

                  <button
                    type="button"
                    className="event-card__summary"
                    onClick={() => toggle(event.eventId)}
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

                {open ? (
                  <div className="event-card__body">
                    <dl className="event-card__facts">
                      <div>
                        <dt>Last seen</dt>
                        <dd>{formatWhen(event.ts)}</dd>
                      </div>
                      {view === 'open' && event.firstTs && occurrences > 1 ? (
                        <div>
                          <dt>First seen</dt>
                          <dd>{formatWhen(event.firstTs)}</dd>
                        </div>
                      ) : null}
                      {view === 'open' && occurrences > 1 ? (
                        <div>
                          <dt>Occurrences</dt>
                          <dd>{occurrences}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Event ID</dt>
                        <dd className="font-mono">{event.eventId}</dd>
                      </div>
                      {view === 'history' && event.ackedBy ? (
                        <div>
                          <dt>Acknowledged</dt>
                          <dd>
                            {event.ackedBy} · {formatWhen(event.ackedAt)}
                          </dd>
                        </div>
                      ) : null}
                    </dl>

                    <div className="event-card__section">
                      <span className="event-card__section-label">Message</span>
                      <p className="event-card__message">{event.message}</p>
                    </div>

                    {detailText ? (
                      <div className="event-card__section">
                        <span className="event-card__section-label">Detail</span>
                        <pre className="event-card__detail">{detailText}</pre>
                      </div>
                    ) : (
                      <p className="event-card__nodetail">No additional detail recorded for this event.</p>
                    )}

                    {event.instanceId ? (
                      <div className="event-card__links">
                        <Link href={`/instances/${event.instanceId}`} className="link">
                          Open instance · {event.instanceAlias ?? event.instanceId}
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
