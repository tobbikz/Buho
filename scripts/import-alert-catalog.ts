#!/usr/bin/env npx tsx
/**
 * Import catalog/alert-definitions.db.json into buho.alert_definitions.
 *
 *   BUHO_STORE_URL=postgres://... npx tsx scripts/import-alert-catalog.ts
 *   BUHO_STORE_URL=... npx tsx scripts/import-alert-catalog.ts --engine mssql
 *   BUHO_STORE_URL=... npx tsx scripts/import-alert-catalog.ts --instance mssql-lab
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Store } from '../packages/store/src/index.ts';
import type { CustomThresholdType } from '../packages/checks/src/custom-alerts.ts';

type CatalogAlert = {
  name: string;
  title: string;
  match_engine: string;
  severity: 'critical' | 'warning' | 'info';
  threshold_type: CustomThresholdType;
  threshold: Record<string, unknown>;
  display_columns?: string[];
  message_template: string;
  remediation?: string;
  sql: string;
  enabled?: boolean;
};

function parseArgs(argv: string[]) {
  let engine: string | null = null;
  let instanceAlias: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--engine') engine = argv[++i] ?? null;
    else if (a === '--instance') instanceAlias = argv[++i] ?? null;
    else if (a === '--file') file = argv[++i] ?? null;
  }
  return { engine, instanceAlias, file };
}

async function main() {
  const url = process.env.BUHO_STORE_URL;
  if (!url) throw new Error('BUHO_STORE_URL required');
  const { engine, instanceAlias, file } = parseArgs(process.argv.slice(2));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const path = file ?? join(root, 'catalog/alert-definitions.db.json');
  const catalog = JSON.parse(await readFile(path, 'utf8')) as { alerts: CatalogAlert[] };

  const store = new Store(url);
  await store.migrate();
  const pool = new Pool({ connectionString: url, max: 2 });

  let instanceId: number | null = null;
  if (instanceAlias) {
    const rows = await pool.query<{ instance_id: string }>(
      `select instance_id::text from buho.instances where alias = $1`,
      [instanceAlias],
    );
    instanceId = rows.rows[0] ? Number(rows.rows[0].instance_id) : null;
    if (!instanceId) throw new Error(`instance alias not found: ${instanceAlias}`);
  }

  // Upsert by name: load existing ids
  const existing = await store.listAlertDefinitions();
  const byName = new Map(existing.map((d) => [d.name, d.definitionId]));

  let imported = 0;
  for (const alert of catalog.alerts) {
    if (engine && alert.match_engine !== engine) continue;
    if (!alert.sql?.trim()) {
      console.warn(`skip ${alert.name}: empty sql`);
      continue;
    }
    const id = await store.upsertAlertDefinition({
      definitionId: byName.get(alert.name),
      name: alert.name,
      title: alert.title,
      enabled: alert.enabled ?? true,
      matchEngine: alert.match_engine,
      matchInstanceId: instanceId,
      severity: alert.severity,
      sql: alert.sql,
      thresholdType: alert.threshold_type,
      threshold: alert.threshold,
      messageTemplate: alert.message_template,
      remediation: alert.remediation ?? '',
      displayColumns: alert.display_columns ?? [],
      sendRecovery: true,
      updatedBy: 'import-alert-catalog',
    });
    console.log(`upserted ${alert.name} → definition ${id} (engine=${alert.match_engine})`);
    imported += 1;
  }

  console.log(`done: ${imported} alert definition(s)`);
  await store.close();
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
