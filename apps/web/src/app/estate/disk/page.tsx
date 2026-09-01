import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatBytes, formatPct } from '@/lib/format';
import { ENGINE_LABEL, getDiskUsage, getNotes, type DiskRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  database: 'Database',
  file: 'Archivo',
  tablespace: 'Tablespace',
  volume: 'Volumen',
};

export default async function DiskPage() {
  let rows: DiskRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getDiskUsage(), getNotes('disk')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const volumes = rows.filter((row) => row.kind === 'volume');
  const databases = rows.filter((row) => row.kind === 'database');
  const files = rows.filter((row) => row.kind === 'file');
  const tablespaces = rows.filter((row) => row.kind === 'tablespace');

  const totalData = databases.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  const tightest = volumes
    .filter((row) => row.sizeBytes && row.freeBytes !== null)
    .map((row) => ({ row, pct: ((row.freeBytes ?? 0) / (row.sizeBytes ?? 1)) * 100 }))
    .sort((a, b) => a.pct - b.pct)[0];

  // Un archivo con tope declarado es una bomba de tiempo silenciosa: al llegar
  // al límite las escrituras fallan aunque el disco tenga espacio de sobra.
  const capped = files.filter((row) => row.maxBytes && row.sizeBytes && row.sizeBytes / row.maxBytes > 0.7);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard label="Data in the estate" value={formatBytes(totalData)} hint={`${databases.length} bases`} />
        <StatCard
          label="Tightest volume"
          value={tightest ? formatPct(tightest.pct, 1) : '—'}
          hint={tightest ? `libre en ${tightest.row.alias}` : 'no volume data'}
          tone={tightest && tightest.pct < 10 ? 'error' : tightest && tightest.pct < 20 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Files near their ceiling"
          value={String(capped.length)}
          hint="over 70% of declared max size"
          tone={capped.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Objetos inventariados" value={String(rows.length)} hint="databases, files, tablespaces, and volumes" />
      </div>

      <NotesPanel notes={notes} />

      {volumes.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Volumes</span>
            <span className="font-mono text-[10px] text-foreground-muted">real filesystem space</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Volume</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Libre</th>
                  <th className="text-right">Usage</th>
                  <th>Sistema de archivos</th>
                </tr>
              </thead>
              <tbody>
                {volumes.map((row, index) => {
                  const usedPct =
                    row.sizeBytes && row.freeBytes !== null
                      ? ((row.sizeBytes - (row.freeBytes ?? 0)) / row.sizeBytes) * 100
                      : null;
                  return (
                    <tr key={`${row.instanceId}-${row.name}-${index}`}>
                      <td>
                        <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                      </td>
                      <td className="font-mono text-[11px]">{row.name}</td>
                      <td className="num">{formatBytes(row.sizeBytes)}</td>
                      <td className="num">{formatBytes(row.freeBytes)}</td>
                      <td className="num">
                        <div className="flex items-center justify-end gap-1">
                          <div className="bar" style={{ minWidth: 40, width: 40 }}>
                            <div
                              className={`bar__fill ${
                                (usedPct ?? 0) >= 90 ? 'bar__fill--error' : (usedPct ?? 0) >= 80 ? 'bar__fill--warn' : ''
                              }`}
                              style={{ width: `${Math.min(100, usedPct ?? 0)}%` }}
                            />
                          </div>
                          {formatPct(usedPct, 1)}
                        </div>
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {(row.detail['file_system'] as string) ?? '·'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Databases by size</span>
        </div>
        {databases.length === 0 ? (
          <div className="empty">No size data yet.</div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: '26rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Engine</th>
                  <th>Database</th>
                  <th className="text-right">Size</th>
                  <th className="text-right">Of which log/indexes</th>
                  <th className="text-right">Reclamable</th>
                </tr>
              </thead>
              <tbody>
                {databases.map((row, index) => (
                  <tr key={`${row.instanceId}-${row.name}-${index}`}>
                    <td>
                      <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                        {row.alias}
                      </Link>
                    </td>
                    <td className="text-[11px] text-foreground-secondary">
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </td>
                    <td className="font-mono text-[11px]">{row.name}</td>
                    <td className="num">{formatBytes(row.sizeBytes)}</td>
                    <td className="num">
                      {formatBytes(
                        (row.detail['log_bytes'] as number | undefined) ??
                          (row.detail['index_bytes'] as number | undefined) ??
                          null,
                      )}
                    </td>
                    <td className="num">{row.freeBytes ? formatBytes(row.freeBytes) : '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {files.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Data and log files</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              el tope declarado corta las escrituras aunque sobre disco
            </span>
          </div>
          <div className="table-scroll" style={{ maxHeight: '24rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Database</th>
                  <th>Archivo</th>
                  <th>Tipo</th>
                  <th className="text-right">Size</th>
                  <th className="text-right">Tope</th>
                  <th>Growth</th>
                  <th>Ruta</th>
                </tr>
              </thead>
              <tbody>
                {files.map((row, index) => (
                  <tr key={`${row.instanceId}-${row.container}-${row.name}-${index}`}>
                    <td>{row.alias}</td>
                    <td className="font-mono text-[11px]">{row.container}</td>
                    <td className="font-mono text-[11px]">{row.name}</td>
                    <td className="text-[11px]">{(row.detail['type'] as string) ?? '·'}</td>
                    <td className="num">{formatBytes(row.sizeBytes)}</td>
                    <td className="num">
                      {row.maxBytes ? (
                        <span className={row.sizeBytes && row.sizeBytes / row.maxBytes > 0.7 ? 'tag tag--warn' : ''}>
                          {formatBytes(row.maxBytes)}
                        </span>
                      ) : (
                        'sin tope'
                      )}
                    </td>
                    <td className="text-[11px]">
                      {row.detail['growth']
                        ? `${row.detail['growth']}${row.detail['percent_growth'] ? ' %' : ' pages'}`
                        : '·'}
                    </td>
                    <td className="max-w-0 truncate font-mono text-[10px] text-foreground-muted">
                      {row.location ?? '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tablespaces.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Tablespaces</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: '18rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Nombre</th>
                  <th className="text-right">Size</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {tablespaces.map((row, index) => (
                  <tr key={`${row.instanceId}-${row.name}-${index}`}>
                    <td>{row.alias}</td>
                    <td className="font-mono text-[11px]">{row.name}</td>
                    <td className="num">{formatBytes(row.sizeBytes)}</td>
                    <td className="font-mono text-[10px] text-foreground-muted">{row.location ?? '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
