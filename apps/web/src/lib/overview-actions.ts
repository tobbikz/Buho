'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/session';
import { getInstanceEngine } from '@/lib/estate';
import {
  mergeWithDefaults,
  resetOverviewLayout,
  saveOverviewLayout,
  type OverviewLayout,
} from '@/lib/overview-layout';
import type { OverviewSqlMode } from '@/lib/overview-layout-types';
import {
  runOverviewSql,
  testOverviewSql,
  type SqlTestResult,
  type SqlWidgetResult,
} from '@/lib/overview-sql';

async function layoutEngine(instanceId: number): Promise<string> {
  return (await getInstanceEngine(instanceId)) ?? 'postgres';
}

export async function saveOverviewLayoutAction(
  instanceId: number,
  layout: OverviewLayout,
): Promise<{ ok: true; layout: OverviewLayout } | { ok: false; error: string }> {
  try {
    const session = await requireAdmin();
    const engine = await layoutEngine(instanceId);
    const saved = await saveOverviewLayout(
      session.username,
      instanceId,
      mergeWithDefaults(layout, engine),
      engine,
    );
    revalidatePath(`/instances/${instanceId}`);
    return { ok: true, layout: saved };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function resetOverviewLayoutAction(
  instanceId: number,
): Promise<{ ok: true; layout: OverviewLayout } | { ok: false; error: string }> {
  try {
    const session = await requireAdmin();
    const engine = await layoutEngine(instanceId);
    const layout = await resetOverviewLayout(session.username, instanceId, engine);
    revalidatePath(`/instances/${instanceId}`);
    return { ok: true, layout };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function testOverviewSqlAction(
  instanceId: number,
  sql: string,
  mode: OverviewSqlMode,
): Promise<{ ok: true; result: SqlTestResult } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    const result = await testOverviewSql(instanceId, sql, mode);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizePreview(result: SqlWidgetResult): string {
  switch (result.mode) {
    case 'table':
      return `Valid · ${result.rows.length} row(s) · ${result.columns.join(', ') || '(no columns)'}`;
    case 'timeseries':
      return `Valid · ${result.points.length} points · series: ${result.seriesKeys.join(', ') || '(none)'}`;
    case 'big_number':
      return `Valid · big number ${result.label}=${result.display}`;
    case 'bar':
      return `Valid · ${result.rows.length} bar(s)`;
    default:
      return 'Valid · query executed';
  }
}

/** Preview = EXPLAIN + shape validation + sample rows (full Superset-style check). */
export async function previewOverviewSqlAction(
  instanceId: number,
  sql: string,
  mode: OverviewSqlMode,
): Promise<{ ok: true; result: SqlWidgetResult; tested: string } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    const result = await runOverviewSql(instanceId, sql, mode);
    return { ok: true, result, tested: summarizePreview(result) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
