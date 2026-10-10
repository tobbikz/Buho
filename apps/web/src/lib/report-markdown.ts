import { formatBytes, formatNumber } from './format';
import type { ReportInstance, ReportMetric, WeeklyReport } from './report';

/**
 * El informe en Markdown.
 *
 * Es el formato del entregable porque sobrevive a todo: se pega en un correo,
 * se abre en cualquier editor, se convierte a PDF y se puede versionar junto
 * con el resto de la documentación del cliente. Un PDF generado sería más
 * bonito y mucho menos útil.
 *
 * Se comparte con la pantalla: lo que se lee en la consola y lo que recibe el
 * cliente salen de la misma consulta, así que no pueden discrepar.
 */

const BACKUP_KIND: Record<string, string> = {
  full: 'full',
  differential: 'differential',
  log: 'log',
  wal_archive: 'Binlog / WAL archive',
};

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' });
const DATETIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)} %`;
}

function delta(metric: ReportMetric | null, digits = 1, suffix = ' %'): string {
  if (!metric || metric.avg === null || metric.prevAvg === null) return '';
  const diff = metric.avg - metric.prevAvg;
  if (Math.abs(diff) < 0.05) return ' (same as previous week)';
  const sign = diff > 0 ? '+' : '−';
  return ` (${sign}${Math.abs(diff).toFixed(digits)}${suffix} vs previous week)`;
}

function seconds(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${value.toFixed(1)} s`;
  if (value < 3600) return `${(value / 60).toFixed(1)} min`;
  return `${(value / 3600).toFixed(1)} h`;
}

/** Una línea de conclusión, no un número: es lo que se lee primero. */
function verdict(report: WeeklyReport): string {
  const { totals } = report;
  const trend =
    totals.scoreAvg !== null && totals.scorePrevAvg !== null
      ? totals.scoreAvg - totals.scorePrevAvg
      : null;

  const partes: string[] = [];

  if (totals.critical > 0) {
    partes.push(
      `There ${totals.critical === 1 ? 'is' : 'are'} ${totals.critical} critical finding${
        totals.critical === 1 ? '' : 's'
      } open at week close`,
    );
  } else if (totals.warning > 0) {
    partes.push(
      `No critical findings; ${totals.warning} warning${totals.warning === 1 ? '' : 's'} remain`,
    );
  } else {
    partes.push('The week closes with no critical findings or warnings');
  }

  if (trend !== null) {
    if (Math.abs(trend) < 1) partes.push('estate health stayed stable');
    else if (trend > 0) partes.push(`estate health improved ${trend.toFixed(0)} points`);
    else partes.push(`estate health dropped ${Math.abs(trend).toFixed(0)} points`);
  }

  if (totals.deadlocks > 0) {
    partes.push(totals.deadlocks === 1
        ? 'one deadlock was logged'
        : `${totals.deadlocks} deadlocks were logged`);
  }
  if (totals.lockEpisodes > 0) {
    partes.push(totals.lockEpisodes === 1
        ? 'one session waited on a lock'
        : `${totals.lockEpisodes} sessions waited on a lock`);
  }
  if (totals.growthBytes !== null && totals.growthBytes > 0) {
    partes.push(`data grew by ${formatBytes(totals.growthBytes)}`);
  }

  return `${partes.join(', ')}.`;
}

function instanceSection(row: ReportInstance): string {
  const lines: string[] = [];
  lines.push(`### ${row.alias}`);
  lines.push('');
  lines.push(
    `Environment ${row.environment} · engine ${row.engine} · health ${
      row.scoreEnd === null ? '—' : row.scoreEnd
    }${
      row.scoreStart !== null && row.scoreEnd !== null && row.scoreStart !== row.scoreEnd
        ? ` (started the week at ${row.scoreStart})`
        : ''
    }`,
  );
  lines.push('');

  if (row.coveragePct !== null && row.coveragePct < 95) {
    lines.push(
      `> Monitoring coverage: ${pct(row.coveragePct, 0)} of the week's hours. ` +
        'Averages below exclude hours without samples, so read them with that in mind.',
    );
    lines.push('');
  }

  lines.push('| Indicator | Average | Peak | Previous week |');
  lines.push('| --- | --- | --- | --- |');
  const filas: [string, ReportMetric | null, (value: number | null) => string][] = [
    ['Connections used', row.connectionsPct, (value) => pct(value)],
    ['Cache hit', row.cacheHitPct, (value) => pct(value)],
    ['Host CPU', row.cpuPct, (value) => pct(value)],
    ['Host memory', row.memPct, (value) => pct(value)],
    ['Disk used', row.diskPct, (value) => pct(value)],
    ['Commits per second', row.commitsPerSec, (value) => formatNumber(value, 1)],
    ['XID age', row.xidAgePct, (value) => pct(value)],
    ['Replication lag', row.replicationLag, (value) => seconds(value)],
  ];
  for (const [label, metric, fmt] of filas) {
    if (!metric || metric.avg === null) continue;
    lines.push(`| ${label} | ${fmt(metric.avg)} | ${fmt(metric.max)} | ${fmt(metric.prevAvg)} |`);
  }
  lines.push('');

  if (row.sizeStartBytes !== null && row.sizeEndBytes !== null) {
    const growth = row.sizeEndBytes - row.sizeStartBytes;
    const rate = row.sizeStartBytes > 0 ? (growth / row.sizeStartBytes) * 100 : null;
    lines.push(
      `**Growth.** From ${formatBytes(row.sizeStartBytes)} to ${formatBytes(row.sizeEndBytes)}: ` +
        `${growth >= 0 ? '+' : '−'}${formatBytes(Math.abs(growth))}` +
        `${rate === null ? '' : ` (${rate >= 0 ? '+' : '−'}${Math.abs(rate).toFixed(1)} % weekly)`}.`,
    );
    lines.push('');
  }

  const incidentes: string[] = [];
  if (row.lockEpisodes > 0) {
    incidentes.push(
      `${row.lockEpisodes} lock episode${row.lockEpisodes === 1 ? '' : 's'}` +
        `${row.lockWorstSeconds === null ? '' : `, worst waited ${seconds(row.lockWorstSeconds)}`}`,
    );
  }
  if (row.logAvailable) {
    if (row.logDeadlocks > 0) {
      incidentes.push(
        row.logDeadlocks === 1 ? 'one deadlock in the log' : `${row.logDeadlocks} deadlocks in the log`,
      );
    }
    if (row.logErrors > 0) {
      incidentes.push(
        row.logErrors === 1 ? 'one error in the log' : `${row.logErrors} errors in the log`,
      );
    }
  }
  lines.push(
    incidentes.length > 0
      ? `**Incidents.** ${incidentes.join('; ')}.`
      : row.logAvailable
        ? '**Incidents.** None: no locks and no log errors.'
        : '**Incidents.** No locks recorded. This instance log is not being read, so deadlocks and application errors are not in this report.',
  );
  lines.push('');

  if (row.worstTables.length > 0) {
    lines.push('**Pending maintenance.**');
    lines.push('');
    lines.push('| Table | Dead tuples | Bloat | Last vacuum |');
    lines.push('| --- | --- | --- | --- |');
    for (const table of row.worstTables) {
      lines.push(
        `| \`${table.schema}.${table.table}\` | ${pct(table.deadPct, 1)} | ${pct(table.bloatPct, 1)}` +
          `${table.bloatBytes === null ? '' : ` (${formatBytes(table.bloatBytes)})`} | ` +
          `${table.lastVacuum ? DATE.format(table.lastVacuum) : 'never'} |`,
      );
    }
    lines.push('');
  }

  if (row.waitProfile && row.waitProfile.length > 0) {
    lines.push(
      `**Where time was spent waiting** (${row.waitSamples} samples). ` +
        row.waitProfile
          .slice(0, 5)
          .map((w) => `${w.waitType} ${(w.share * 100).toFixed(0)} %`)
          .join(' · ') +
        '.',
    );
    lines.push('');
  }

  if (row.topQueries.length > 0) {
    lines.push('**Queries that consumed the most time.**');
    lines.push('');
    for (const q of row.topQueries) {
      const texto = (q.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 160);
      lines.push(
        `- ${formatNumber(q.execMs / 1000, 1)} s total, ${formatNumber(q.calls, 0)} calls, ` +
          `${q.meanMs.toFixed(2)} ms mean — \`${texto}\``,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function reportToMarkdown(report: WeeklyReport): string {
  const { window: w, totals } = report;
  const lines: string[] = [];

  lines.push(`# Weekly database report`);
  lines.push('');
  lines.push(`From ${DATE.format(w.from)} to ${DATE.format(w.to)}`);
  lines.push('');
  lines.push(
    `${totals.instances} monitored instance${
      totals.instances === 1 ? '' : 's'
    } · generated ${DATETIME.format(report.generatedAt)} by Búho`,
  );
  lines.push('');

  lines.push('## What you need to know');
  lines.push('');
  lines.push(verdict(report));
  lines.push('');

  if (report.plan.length > 0) {
    lines.push('## Work plan for the week');
    lines.push('');
    lines.push(
      'Three things, in order. This is the consulting deliverable: what to do on Monday, ' +
        'not a metric dump.',
    );
    lines.push('');
    let n = 1;
    for (const item of report.plan) {
      lines.push(`${n}. ${item}`);
      n += 1;
    }
    lines.push('');
  }
  lines.push('| | This week | Previous |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| Average health | ${totals.scoreAvg === null ? '—' : totals.scoreAvg.toFixed(0)} | ${
      totals.scorePrevAvg === null ? '—' : totals.scorePrevAvg.toFixed(0)
    } |`,
  );
  lines.push(`| Critical findings | ${totals.critical} | — |`);
  lines.push(`| Warnings | ${totals.warning} | — |`);
  lines.push(`| Lock episodes | ${totals.lockEpisodes} | — |`);
  lines.push(`| Deadlocks | ${totals.deadlocks} | — |`);
  lines.push(
    `| Session time on Lock | ${
      totals.lockWaitShare === null ? '—' : pct(totals.lockWaitShare * 100, 0)
    } | — |`,
  );
  lines.push(
    `| Session time on IO | ${
      totals.ioWaitShare === null ? '—' : pct(totals.ioWaitShare * 100, 0)
    } | — |`,
  );
  lines.push(
    `| Data growth | ${
      totals.growthBytes === null ? '—' : formatBytes(totals.growthBytes)
    } | — |`,
  );
  lines.push('');

  if (report.actions.length > 0) {
    lines.push('## Recommended actions');
    lines.push('');
    lines.push(
      'Ordered by severity and how many instances each one touches: fixing the top items ' +
        'resolves more with the same effort.',
    );
    lines.push('');
    let n = 1;
    for (const action of report.actions) {
      lines.push(
        `${n}. **${action.title}** — ${action.severity === 'critical' ? 'critical' : 'warning'} · ` +
          `${action.instances.length} instance${action.instances.length === 1 ? '' : 's'} ` +
          `(${action.instances.join(', ')})`,
      );
      lines.push(`   - What is happening: ${action.message}`);
      lines.push(`   - What to do: ${action.remediation}`);
      n += 1;
    }
    lines.push('');
  }

  if (report.backups.length > 0) {
    lines.push('## Backups');
    lines.push('');
    lines.push('| Instance | Database | Type | State | Last | Data source |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const backup of report.backups) {
      lines.push(
        `| ${backup.alias} | ${backup.database} | ${BACKUP_KIND[backup.kind] ?? backup.kind} | ` +
          `${backup.stateLabel} | ` +
          `${backup.finishedAt ? DATETIME.format(backup.finishedAt) : 'no record'} | ${backup.source} |`,
      );
    }
    lines.push('');
    lines.push(
      '> WAL archive rows reflect archive_mode (PITR), not streaming replication. External backup tools with no engine trail do not appear here.',
    );
    lines.push('');
  }

  lines.push('## Instance by instance');
  lines.push('');
  for (const row of report.instances) {
    lines.push(instanceSection(row));
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'Report generated by Búho from samples in the period. Averages are hourly resolution; ' +
      'peaks are the maximum value observed in each hour.',
  );
  lines.push('');

  return lines.join('\n');
}

/** Nombre de archivo estable y ordenable, que es lo que se archiva. */
export function reportFilename(report: WeeklyReport): string {
  const iso = report.window.to.toISOString().slice(0, 10);
  return `buho-weekly-report-${iso}.md`;
}

export { delta };
