import { revalidatePath } from 'next/cache';
import { EventsFeed } from '@/components/EventsFeed';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import {
  acknowledgeAllOpenEvents,
  acknowledgeEvents,
  getEvents,
  type EventFeedView,
} from '@/lib/queries';
import { currentSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function ackEvents(eventIds: number[]) {
  'use server';
  const session = await currentSession();
  if (session.role !== 'admin') throw new Error('Administrator role required.');
  await acknowledgeEvents(eventIds, session.username);
  revalidatePath('/events');
}

async function ackAllEvents() {
  'use server';
  const session = await currentSession();
  if (session.role !== 'admin') throw new Error('Administrator role required.');
  await acknowledgeAllOpenEvents(session.username);
  revalidatePath('/events');
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: viewParam } = await searchParams;
  const view: EventFeedView = viewParam === 'history' ? 'history' : 'open';
  const session = await currentSession();

  let events;
  try {
    events = await getEvents(null, view === 'history' ? 250 : 100, view);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Events' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const openCount = view === 'open' ? events.length : null;

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Events' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Collector events</h1>
            <p className="page-sub">
              {view === 'open'
                ? `${openCount ?? events.length} open group(s) — click a row to expand details. Acknowledge to triage; History keeps the full log.`
                : `Full event log (${events.length} entries). Click any row for message and detail.`}
            </p>
          </div>
        </header>

        <section className="panel">
          <EventsFeed
            events={events}
            view={view}
            canAcknowledge={session.role === 'admin'}
            onAcknowledge={ackEvents}
            onAcknowledgeAll={ackAllEvents}
          />
        </section>
      </div>
    </>
  );
}

export const metadata = { title: 'Events · Búho' };
