'use client';

import Link from 'next/link';
import { useState } from 'react';

export interface InstanceEventView {
  eventId: number;
  ts: string;
  firstTs: string | null;
  level: 'info' | 'warn' | 'error';
  component: string;
  message: string;
  occurrences: number;
  detail: unknown | null;
}

const LEVEL_TAG = {
  error: 'tag--error',
  warn: 'tag--warn',
  info: 'tag--muted',
} as const;

const LEVEL_STRIPE = {
  error: 'event-card--error',
  warn: 'event-card--warn',
  info: 'event-card--info',
} as const;

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
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

function formatDetail(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail.trim() || null;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export function InstanceEvents({ events }: { events: InstanceEventView[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (events.length === 0) return <div className="empty">No events recorded.</div>;

  return (
    <div className="events-list">
      {events.map((event) => {
        const open = openId === event.eventId;
        const detailText = formatDetail(event.detail);
        return (
          <article key={event.eventId} className={`event-card ${LEVEL_STRIPE[event.level]} ${open ? 'is-open' : ''}`}>
            <button
              type="button"
              className="event-card__summary"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : event.eventId)}
            >
              <span className="event-card__chevron" aria-hidden />
              <span className="min-w-0">
                <div className="event-card__meta">
                  <time className="event-card__time" dateTime={event.ts}>
                    {formatWhen(event.ts)}
                  </time>
                  <span className={`tag ${LEVEL_TAG[event.level]}`}>{event.level}</span>
                  <span className="event-card__component">{event.component}</span>
                  {event.occurrences > 1 ? <span className="event-card__count">×{event.occurrences}</span> : null}
                </div>
                <p className="event-card__preview">{event.message}</p>
              </span>
            </button>
            {open ? (
              <div className="event-card__body">
                <dl className="event-card__facts">
                  <div>
                    <dt>Last seen</dt>
                    <dd>{formatWhen(event.ts)}</dd>
                  </div>
                  {event.firstTs && event.occurrences > 1 ? (
                    <div>
                      <dt>First seen</dt>
                      <dd>{formatWhen(event.firstTs)}</dd>
                    </div>
                  ) : null}
                  {event.occurrences > 1 ? (
                    <div>
                      <dt>Occurrences</dt>
                      <dd>{event.occurrences}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Component</dt>
                    <dd className="font-mono">{event.component}</dd>
                  </div>
                  <div>
                    <dt>Event ID</dt>
                    <dd className="font-mono">{event.eventId}</dd>
                  </div>
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
                  <p className="event-card__nodetail">No extra payload was stored with this event.</p>
                )}
                <div className="event-card__links">
                  <Link href="/events" className="link">
                    Open the full event feed
                  </Link>
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
