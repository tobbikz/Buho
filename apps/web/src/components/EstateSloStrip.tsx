import Link from 'next/link';
import { getEstateRecoverySlo, type ShieldTone } from '@/lib/dba-shield';
import { ENGINE_LABEL } from '@/lib/estate';

function tag(tone: ShieldTone): string {
  return tone === 'error'
    ? 'tag--error'
    : tone === 'warn'
      ? 'tag--warn'
      : tone === 'ok'
        ? 'tag--ok'
        : 'tag--muted';
}

/**
 * Fleet recovery SLO: RPO posture per instance so platform/DBA share one picture.
 */
export async function EstateSloStrip() {
  const rows = await getEstateRecoverySlo().catch(() => []);
  if (rows.length === 0) return null;

  const broken = rows.filter((r) => r.tone === 'error').length;
  const warn = rows.filter((r) => r.tone === 'warn').length;
  const ok = rows.filter((r) => r.tone === 'ok').length;

  return (
    <section className="panel estate-accent-panel">
      <div className="panel-header">
        <span className="panel-title">Recovery SLO · fleet</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          RPO posture · {broken} broken · {warn} at risk · {ok} ok ·{' '}
          <Link href="/estate/rpo" className="underline decoration-dotted">
            open RPO tab →
          </Link>
        </span>
      </div>
      <div className="panel-body">
        <div className="table-scroll" style={{ maxHeight: 280 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Engine</th>
                <th>Score</th>
                <th>RPO age</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .slice()
                .sort((a, b) => a.score - b.score)
                .map((row) => (
                  <tr key={row.instanceId}>
                    <td>
                      <Link
                        href={`/instances/${row.instanceId}`}
                        className="underline decoration-dotted"
                      >
                        {row.alias}
                      </Link>
                    </td>
                    <td className="text-[11px] text-foreground-secondary">
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </td>
                    <td>
                      <span className={`tag ${tag(row.tone)}`}>{row.score}/100</span>
                    </td>
                    <td className="num text-[11px]">
                      {row.rpoHours === null ? '·' : `${row.rpoHours.toFixed(1)} h`}
                    </td>
                    <td className="text-[11px] text-foreground-secondary">{row.label}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
