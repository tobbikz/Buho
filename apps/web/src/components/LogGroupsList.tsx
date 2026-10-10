'use client';

import { formatAgo, formatClock, formatNumber } from '@/lib/format';
import { ListPager, useListPage } from '@/components/ListPager';

type LogKind =
  | 'deadlock'
  | 'lock_wait'
  | 'error'
  | 'fatal'
  | 'connection'
  | 'checkpoint'
  | 'autovacuum'
  | 'temp_file'
  | 'cancelled'
  | 'other';

const KIND_LABEL: Record<LogKind, string> = {
  deadlock: 'Deadlock',
  lock_wait: 'Lock wait',
  error: 'Error',
  fatal: 'Fatal',
  connection: 'Connection',
  checkpoint: 'Checkpoint',
  autovacuum: 'Autovacuum',
  temp_file: 'Temp file',
  cancelled: 'Cancelled',
  other: 'Other',
};

/** Serializable shape from the server (Dates → ISO). */
export type LogGroupView = {
  fingerprint: string;
  kind: LogKind;
  level: string;
  times: number;
  firstAt: string;
  lastAt: string;
  sample: string;
  detail: string | null;
  hint: string | null;
  sampleQuery: string | null;
  context: string | null;
  sqlstate: string | null;
  databases: string[];
  users: string[];
};

function kindTone(kind: LogKind): string {
  if (kind === 'fatal' || kind === 'deadlock') return 'tag--error';
  if (kind === 'error' || kind === 'cancelled' || kind === 'lock_wait') return 'tag--warn';
  return 'tag--muted';
}

type LogGroupHydrated = Omit<LogGroupView, 'firstAt' | 'lastAt'> & {
  firstAt: Date;
  lastAt: Date;
};

function GroupRow({ group }: { group: LogGroupHydrated }) {
  const alwaysOpen = group.kind === 'deadlock';

  return (
    <details className="log-group" open={alwaysOpen}>
      <summary className="log-group__head">
        <span className={`tag ${kindTone(group.kind)}`}>{KIND_LABEL[group.kind]}</span>
        <span className="log-group__times font-mono">{formatNumber(group.times)}×</span>
        <span className="log-group__message">{group.sample}</span>
        <span className="log-group__when font-mono">{formatAgo(group.lastAt)}</span>
      </summary>

      <div className="log-group__body">
        <div className="log-group__meta">
          <span>
            first seen <span className="font-mono">{formatClock(group.firstAt)}</span>
          </span>
          <span>
            last seen <span className="font-mono">{formatClock(group.lastAt)}</span>
          </span>
          <span>
            level <span className="font-mono">{group.level}</span>
          </span>
          {group.sqlstate && (
            <span>
              SQLSTATE <span className="font-mono">{group.sqlstate}</span>
            </span>
          )}
          {group.databases.length > 0 && <span>database {group.databases.join(', ')}</span>}
          {group.users.length > 0 && <span>role {group.users.join(', ')}</span>}
        </div>

        {group.detail && (
          <div>
            <div className="log-group__label">Detail</div>
            <div className="query-block">{group.detail}</div>
          </div>
        )}

        {group.sampleQuery && (
          <div>
            <div className="log-group__label">Statement from the last occurrence</div>
            <div className="query-block">{group.sampleQuery}</div>
          </div>
        )}

        {group.context && (
          <div>
            <div className="log-group__label">Contexto</div>
            <div className="query-block">{group.context}</div>
          </div>
        )}

        {group.hint && (
          <p className="text-[11.5px] text-foreground-secondary">Server hint: {group.hint}</p>
        )}
      </div>
    </details>
  );
}

export function LogGroupsList({
  title,
  empty,
  groups,
}: {
  title: string;
  empty: string;
  groups: LogGroupView[];
}) {
  const hydrated = groups.map((group) => ({
    ...group,
    firstAt: new Date(group.firstAt),
    lastAt: new Date(group.lastAt),
  }));
  const { page, setPage, pageCount, rows, pageSize } = useListPage(hydrated, 10);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="font-mono text-[10px] text-foreground-muted">most repeated first</span>
      </div>
      {hydrated.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <>
          <div className="log-list">
            {rows.map((group) => (
              <GroupRow key={`${group.kind}:${group.fingerprint}`} group={group} />
            ))}
          </div>
          <ListPager
            page={page}
            pageCount={pageCount}
            total={hydrated.length}
            pageSize={pageSize}
            onPageChange={setPage}
          />
        </>
      )}
    </section>
  );
}
