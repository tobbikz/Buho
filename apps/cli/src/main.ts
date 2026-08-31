/**
 * buho-check — informe de salud de una instancia PostgreSQL.
 *
 * Read-only, sin agente y sin escribir nada: es el mismo catálogo de checks
 * que usa el colector, empaquetado como comando suelto.
 *
 *   npm run check -- postgres://usuario:clave@host:5432/base
 *   PGHOST=... PGDATABASE=... PGUSER=... npm run check
 */
import { runChecks } from '@buho/checks';
import type { CheckResult, Severity } from '@buho/checks';
import {
  capabilityWarnings,
  collectorsFor,
  createPool,
  formatDuration,
  instanceFromEnv,
  instanceFromUrl,
  probeCapabilities,
  runCollectors,
} from '@buho/core';
import type { Capabilities, InstanceConfig } from '@buho/core';

const COLOR = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  green: '\u001B[32m',
  cyan: '\u001B[36m',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: `${COLOR.red}CRÍTICO${COLOR.reset}`,
  warning: `${COLOR.yellow}AVISO  ${COLOR.reset}`,
  info: `${COLOR.cyan}INFO   ${COLOR.reset}`,
};

function resolveTarget(): InstanceConfig {
  const [urlArg] = process.argv.slice(2);
  if (urlArg && !urlArg.startsWith('-')) return instanceFromUrl(urlArg);
  const fromEnv = instanceFromEnv();
  if (fromEnv) return fromEnv;
  throw new Error(
    'Uso: buho-check postgres://usuario:clave@host:puerto/base\n' +
      '     o definir PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD.',
  );
}

function printHeader(instance: InstanceConfig, caps: Capabilities, latencyMs: number): void {
  const version = caps.versionText.split(' ').slice(0, 2).join(' ');
  const uptime = formatDuration((Date.now() - caps.startedAt.getTime()) / 1000);

  console.log(`\n${COLOR.bold}Búho — informe de salud${COLOR.reset}`);
  console.log(`${COLOR.dim}${'─'.repeat(72)}${COLOR.reset}`);
  console.log(`Instancia   ${instance.host}:${instance.port}/${instance.database}`);
  console.log(`Servidor    ${version}${caps.inRecovery ? ' (standby)' : ' (primary)'}`);
  console.log(`Uptime      ${uptime}   ·   latencia ${latencyMs.toFixed(1)} ms`);
  console.log(
    `Permisos    ${caps.hasPgMonitor ? 'pg_monitor' : 'sin pg_monitor'}${caps.isSuperuser ? ' · superuser' : ''}`,
  );
  console.log(`Consultas   pg_stat_statements: ${caps.statStatements}`);
}

function printFindings(results: CheckResult[]): void {
  if (results.length === 0) {
    console.log(`\n${COLOR.green}Sin hallazgos: la instancia pasó todos los checks.${COLOR.reset}`);
    return;
  }

  let lastCheck = '';
  console.log(`\n${COLOR.bold}Hallazgos${COLOR.reset}`);
  console.log(`${COLOR.dim}${'─'.repeat(72)}${COLOR.reset}`);

  for (const result of results) {
    if (result.checkId !== lastCheck) {
      console.log(`\n${COLOR.bold}${result.title}${COLOR.reset} ${COLOR.dim}(${result.checkId})${COLOR.reset}`);
      lastCheck = result.checkId;
    }
    const object = result.object ? ` ${COLOR.dim}${result.object}${COLOR.reset}` : '';
    console.log(`  ${SEVERITY_LABEL[result.severity]}${object}`);
    console.log(`    ${result.message}`);
    console.log(`    ${COLOR.dim}→ ${result.remediation}${COLOR.reset}`);
  }
}

function printScore(score: number, results: CheckResult[]): void {
  const counts = {
    critical: results.filter((r) => r.severity === 'critical').length,
    warning: results.filter((r) => r.severity === 'warning').length,
    info: results.filter((r) => r.severity === 'info').length,
  };
  const color = score >= 85 ? COLOR.green : score >= 60 ? COLOR.yellow : COLOR.red;

  console.log(`\n${COLOR.dim}${'─'.repeat(72)}${COLOR.reset}`);
  console.log(
    `${COLOR.bold}Health score ${color}${score}/100${COLOR.reset}` +
      `   ${counts.critical} críticos · ${counts.warning} avisos · ${counts.info} informativos`,
  );
}

const instance = resolveTarget();
const pool = createPool(instance, { applicationName: 'buho_check' });
let exitCode = 0;

try {
  const caps = await probeCapabilities(pool);
  const collection = await runCollectors(pool, caps, collectorsFor(caps));
  printHeader(instance, caps, collection.latencyMs);

  const warnings = capabilityWarnings(caps);
  if (warnings.length > 0) {
    console.log(`\n${COLOR.bold}Limitaciones de la conexión${COLOR.reset}`);
    for (const warning of warnings) console.log(`  ${COLOR.yellow}·${COLOR.reset} ${warning}`);
  }

  const { results, errors, healthScore } = await runChecks(pool, caps);
  printFindings(results);
  printScore(healthScore, results);

  console.log(
    `${COLOR.dim}${collection.samples.length} métricas recolectadas` +
      `${collection.errors.length > 0 ? `, ${collection.errors.length} colectores con error` : ''}` +
      `${errors.length > 0 ? `, ${errors.length} checks con error` : ''}${COLOR.reset}\n`,
  );

  for (const error of [...collection.errors.map((e) => `colector ${e.collectorId}: ${e.message}`), ...errors.map((e) => `check ${e.checkId}: ${e.message}`)]) {
    console.log(`${COLOR.red}!${COLOR.reset} ${error}`);
  }

  if (results.some((r) => r.severity === 'critical')) exitCode = 2;
  else if (results.some((r) => r.severity === 'warning')) exitCode = 1;
} catch (error) {
  console.error(`${COLOR.red}Error:${COLOR.reset} ${error instanceof Error ? error.message : error}`);
  exitCode = 3;
} finally {
  await pool.end();
}

process.exit(exitCode);
