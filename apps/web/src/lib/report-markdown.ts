import { formatBytes, formatNumber } from './format';
import type { BackupState } from './estate';
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

const BACKUP_STATE: Record<BackupState, string> = {
  sin_recuperacion: 'sin recuperación',
  atrasado: 'atrasado',
  no_verificable: 'no verificable',
  ok: 'al día',
};

const BACKUP_KIND: Record<string, string> = {
  full: 'completo',
  differential: 'diferencial',
  log: 'log',
  wal_archive: 'archivado de WAL',
};

const DATE = new Intl.DateTimeFormat('es-CR', { dateStyle: 'long' });
const DATETIME = new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeStyle: 'short' });

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)} %`;
}

function delta(metric: ReportMetric | null, digits = 1, suffix = ' %'): string {
  if (!metric || metric.avg === null || metric.prevAvg === null) return '';
  const diff = metric.avg - metric.prevAvg;
  if (Math.abs(diff) < 0.05) return ' (igual que la semana anterior)';
  const sign = diff > 0 ? '+' : '−';
  return ` (${sign}${Math.abs(diff).toFixed(digits)}${suffix} vs. semana anterior)`;
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
      `Hay ${totals.critical} hallazgo${totals.critical === 1 ? '' : 's'} crítico${
        totals.critical === 1 ? '' : 's'
      } abierto${totals.critical === 1 ? '' : 's'} al cierre de la semana`,
    );
  } else if (totals.warning > 0) {
    partes.push(
      `Sin hallazgos críticos; quedan ${totals.warning} advertencia${totals.warning === 1 ? '' : 's'}`,
    );
  } else {
    partes.push('La semana cierra sin hallazgos críticos ni advertencias');
  }

  if (trend !== null) {
    if (Math.abs(trend) < 1) partes.push('la salud del parque se mantuvo estable');
    else if (trend > 0) partes.push(`la salud del parque mejoró ${trend.toFixed(0)} puntos`);
    else partes.push(`la salud del parque cayó ${Math.abs(trend).toFixed(0)} puntos`);
  }

  if (totals.deadlocks > 0) {
    partes.push(totals.deadlocks === 1
        ? 'se registró un deadlock en el log'
        : `se registraron ${totals.deadlocks} deadlocks en el log`);
  }
  if (totals.lockEpisodes > 0) {
    partes.push(totals.lockEpisodes === 1
        ? 'una sesión estuvo esperando un lock'
        : `${totals.lockEpisodes} sesiones estuvieron esperando un lock`);
  }
  if (totals.growthBytes !== null && totals.growthBytes > 0) {
    partes.push(`los datos crecieron ${formatBytes(totals.growthBytes)}`);
  }

  return `${partes.join(', ')}.`;
}

function instanceSection(row: ReportInstance): string {
  const lines: string[] = [];
  lines.push(`### ${row.alias}`);
  lines.push('');
  lines.push(
    `Entorno ${row.environment} · motor ${row.engine} · salud ${
      row.scoreEnd === null ? '—' : row.scoreEnd
    }${
      row.scoreStart !== null && row.scoreEnd !== null && row.scoreStart !== row.scoreEnd
        ? ` (empezó la semana en ${row.scoreStart})`
        : ''
    }`,
  );
  lines.push('');

  if (row.coveragePct !== null && row.coveragePct < 95) {
    lines.push(
      `> Cobertura del monitoreo: ${pct(row.coveragePct, 0)} de las horas de la semana. ` +
        'Los promedios de abajo excluyen las horas sin muestras, así que hay que leerlos con eso en mente.',
    );
    lines.push('');
  }

  lines.push('| Indicador | Promedio | Pico | Semana anterior |');
  lines.push('| --- | --- | --- | --- |');
  const filas: [string, ReportMetric | null, (value: number | null) => string][] = [
    ['Conexiones usadas', row.connectionsPct, (value) => pct(value)],
    ['Aciertos de caché', row.cacheHitPct, (value) => pct(value)],
    ['CPU del host', row.cpuPct, (value) => pct(value)],
    ['Memoria del host', row.memPct, (value) => pct(value)],
    ['Disco usado', row.diskPct, (value) => pct(value)],
    ['Commits por segundo', row.commitsPerSec, (value) => formatNumber(value, 1)],
    ['Edad del XID', row.xidAgePct, (value) => pct(value)],
    ['Lag de replicación', row.replicationLag, (value) => seconds(value)],
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
      `**Crecimiento.** De ${formatBytes(row.sizeStartBytes)} a ${formatBytes(row.sizeEndBytes)}: ` +
        `${growth >= 0 ? '+' : '−'}${formatBytes(Math.abs(growth))}` +
        `${rate === null ? '' : ` (${rate >= 0 ? '+' : '−'}${Math.abs(rate).toFixed(1)} % semanal)`}.`,
    );
    lines.push('');
  }

  const incidentes: string[] = [];
  if (row.lockEpisodes > 0) {
    incidentes.push(
      `${row.lockEpisodes} episodio${row.lockEpisodes === 1 ? '' : 's'} de bloqueo` +
        `${row.lockWorstSeconds === null ? '' : `, el peor esperó ${seconds(row.lockWorstSeconds)}`}`,
    );
  }
  if (row.logAvailable) {
    if (row.logDeadlocks > 0) {
      incidentes.push(
        row.logDeadlocks === 1 ? 'un deadlock en el log' : `${row.logDeadlocks} deadlocks en el log`,
      );
    }
    if (row.logErrors > 0) {
      incidentes.push(
        row.logErrors === 1 ? 'un error en el log' : `${row.logErrors} errores en el log`,
      );
    }
  }
  lines.push(
    incidentes.length > 0
      ? `**Incidentes.** ${incidentes.join('; ')}.`
      : row.logAvailable
        ? '**Incidentes.** Ninguno: ni bloqueos ni errores en el log.'
        : '**Incidentes.** Sin bloqueos registrados. El log de la instancia no se está leyendo, así que los deadlocks y los errores de la aplicación no entran en este informe.',
  );
  lines.push('');

  if (row.worstTables.length > 0) {
    lines.push('**Mantenimiento pendiente.**');
    lines.push('');
    lines.push('| Tabla | Tuplas muertas | Bloat | Último vacuum |');
    lines.push('| --- | --- | --- | --- |');
    for (const table of row.worstTables) {
      lines.push(
        `| \`${table.schema}.${table.table}\` | ${pct(table.deadPct, 1)} | ${pct(table.bloatPct, 1)}` +
          `${table.bloatBytes === null ? '' : ` (${formatBytes(table.bloatBytes)})`} | ` +
          `${table.lastVacuum ? DATE.format(table.lastVacuum) : 'nunca'} |`,
      );
    }
    lines.push('');
  }

  if (row.waitProfile && row.waitProfile.length > 0) {
    lines.push(
      `**En qué se esperó** (${row.waitSamples} fotos). ` +
        row.waitProfile
          .slice(0, 5)
          .map((w) => `${w.waitType} ${(w.share * 100).toFixed(0)} %`)
          .join(' · ') +
        '.',
    );
    lines.push('');
  }

  if (row.topQueries.length > 0) {
    lines.push('**Consultas que más tiempo consumieron.**');
    lines.push('');
    for (const q of row.topQueries) {
      const texto = (q.text ?? '(sin texto)').replace(/\s+/g, ' ').slice(0, 160);
      lines.push(
        `- ${formatNumber(q.execMs / 1000, 1)} s en total, ${formatNumber(q.calls, 0)} llamadas, ` +
          `${q.meanMs.toFixed(2)} ms de media — \`${texto}\``,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function reportToMarkdown(report: WeeklyReport): string {
  const { window: w, totals } = report;
  const lines: string[] = [];

  lines.push(`# Informe semanal de bases de datos`);
  lines.push('');
  lines.push(`Del ${DATE.format(w.from)} al ${DATE.format(w.to)}`);
  lines.push('');
  lines.push(
    `${totals.instances} instancia${totals.instances === 1 ? '' : 's'} monitoreada${
      totals.instances === 1 ? '' : 's'
    } · generado el ${DATETIME.format(report.generatedAt)} por Búho`,
  );
  lines.push('');

  lines.push('## Lo que hay que saber');
  lines.push('');
  lines.push(verdict(report));
  lines.push('');

  if (report.plan.length > 0) {
    lines.push('## Plan de trabajo de la semana');
    lines.push('');
    lines.push(
      'Tres cosas, en orden. Es el entregable de la consultoría: qué hacer el lunes, ' +
        'no un dump de métricas.',
    );
    lines.push('');
    let n = 1;
    for (const item of report.plan) {
      lines.push(`${n}. ${item}`);
      n += 1;
    }
    lines.push('');
  }
  lines.push('| | Esta semana | Anterior |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| Salud promedio | ${totals.scoreAvg === null ? '—' : totals.scoreAvg.toFixed(0)} | ${
      totals.scorePrevAvg === null ? '—' : totals.scorePrevAvg.toFixed(0)
    } |`,
  );
  lines.push(`| Hallazgos críticos | ${totals.critical} | — |`);
  lines.push(`| Advertencias | ${totals.warning} | — |`);
  lines.push(`| Episodios de bloqueo | ${totals.lockEpisodes} | — |`);
  lines.push(`| Deadlocks | ${totals.deadlocks} | — |`);
  lines.push(
    `| Tiempo de sesión en Lock | ${
      totals.lockWaitShare === null ? '—' : pct(totals.lockWaitShare * 100, 0)
    } | — |`,
  );
  lines.push(
    `| Tiempo de sesión en IO | ${
      totals.ioWaitShare === null ? '—' : pct(totals.ioWaitShare * 100, 0)
    } | — |`,
  );
  lines.push(
    `| Crecimiento de datos | ${
      totals.growthBytes === null ? '—' : formatBytes(totals.growthBytes)
    } | — |`,
  );
  lines.push('');

  if (report.actions.length > 0) {
    lines.push('## Acciones recomendadas');
    lines.push('');
    lines.push(
      'Ordenadas por severidad y por cuántas instancias toca cada una: arreglar lo de arriba ' +
        'resuelve más con el mismo esfuerzo.',
    );
    lines.push('');
    let n = 1;
    for (const action of report.actions) {
      lines.push(
        `${n}. **${action.title}** — ${action.severity === 'critical' ? 'crítico' : 'advertencia'} · ` +
          `${action.instances.length} instancia${action.instances.length === 1 ? '' : 's'} ` +
          `(${action.instances.join(', ')})`,
      );
      lines.push(`   - Qué pasa: ${action.message}`);
      lines.push(`   - Qué hacer: ${action.remediation}`);
      n += 1;
    }
    lines.push('');
  }

  if (report.backups.length > 0) {
    lines.push('## Respaldos');
    lines.push('');
    lines.push('| Instancia | Base | Tipo | Estado | Último | Origen del dato |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const backup of report.backups) {
      lines.push(
        `| ${backup.alias} | ${backup.database} | ${BACKUP_KIND[backup.kind] ?? backup.kind} | ` +
          `${BACKUP_STATE[backup.state]} | ` +
          `${backup.finishedAt ? DATETIME.format(backup.finishedAt) : 'sin registro'} | ${backup.source} |`,
      );
    }
    lines.push('');
    lines.push(
      '> Búho reporta lo que el motor sabe de sus propios respaldos. Un respaldo hecho por ' +
        'una herramienta externa que no deja rastro en el motor no aparece aquí, y eso no ' +
        'significa que no exista.',
    );
    lines.push('');
  }

  lines.push('## Instancia por instancia');
  lines.push('');
  for (const row of report.instances) {
    lines.push(instanceSection(row));
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'Informe generado por Búho a partir de las muestras del periodo. Los promedios son de ' +
      'resolución horaria; los picos, del valor máximo observado en cada hora.',
  );
  lines.push('');

  return lines.join('\n');
}

/** Nombre de archivo estable y ordenable, que es lo que se archiva. */
export function reportFilename(report: WeeklyReport): string {
  const iso = report.window.to.toISOString().slice(0, 10);
  return `buho-informe-semanal-${iso}.md`;
}

export { delta };
