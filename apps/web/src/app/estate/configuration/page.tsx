import { ConfigurationTable, type ConfigurationSetting } from '@/components/ConfigurationTable';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { settingGuide } from '@/lib/setting-guides';
import { ENGINE_LABEL, getNotes, getSettings, type SettingRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Configuration · Estate · Búho' };

export default async function ConfigurationPage() {
  let rows: SettingRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getSettings(), getNotes('settings')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const byEngine = new Map<string, SettingRow[]>();
  for (const row of rows) {
    const list = byEngine.get(row.engine) ?? [];
    list.push(row);
    byEngine.set(row.engine, list);
  }

  let divergent = 0;
  let defaults = 0;

  const sections = [...byEngine.entries()].map(([engine, engineRows]) => {
    const aliases = [...new Set(engineRows.map((row) => row.alias))].sort();
    const names = [...new Set(engineRows.map((row) => row.name))].sort();
    const lookup = new Map(engineRows.map((row) => [`${row.alias}|${row.name}`, row]));

    const settings: ConfigurationSetting[] = names.map((name) => {
      const instances = aliases
        .map((alias) => lookup.get(`${alias}|${name}`))
        .filter((row): row is SettingRow => row !== undefined)
        .map((row) => ({
          instanceId: row.instanceId,
          alias: row.alias,
          value: row.value,
          unit: row.unit,
          isDefault: row.isDefault,
          requiresRestart: row.requiresRestart,
          category: row.category,
        }));

      const distinct = new Set(instances.map((row) => row.value));
      const diverges = distinct.size > 1;
      const allDefault = instances.every((row) => row.isDefault === true);
      const requiresRestart = instances.some((row) => row.requiresRestart === true);
      if (diverges) divergent += 1;
      if (allDefault) defaults += 1;

      return {
        name,
        diverges,
        allDefault,
        requiresRestart,
        instances,
        guide: settingGuide(engine, name),
      };
    });

    return { engine, aliases, settings };
  });

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Divergent parameters"
          value={String(divergent)}
          hint="differ across instances of the same engine"
          tone={divergent > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="At default value" value={String(defaults)} hint="never explicitly set" />
        <StatCard label="Audited parameters" value={String(new Set(rows.map((r) => r.name)).size)} />
        <StatCard label="Engines compared" value={String(byEngine.size)} />
      </div>

      <NotesPanel notes={notes} />

      {sections.length === 0 ? (
        <section className="panel">
          <div className="empty">No inventoried configuration yet.</div>
        </section>
      ) : null}

      {sections.map((section) => (
        <section key={section.engine} className="panel">
          <div className="panel-header">
            <span className="panel-title">{ENGINE_LABEL[section.engine] ?? section.engine}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {section.aliases.length} instance(s) · click a row for per-server detail and recommendations
            </span>
          </div>
          <ConfigurationTable
            engine={section.engine}
            aliases={section.aliases}
            settings={section.settings}
          />
        </section>
      ))}
    </div>
  );
}
