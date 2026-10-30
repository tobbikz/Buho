import { LabeledBars } from '@/components/LabeledBars';

export function OverviewSqlBigNumber({
  title,
  label,
  display,
}: {
  title: string;
  label: string;
  display: string;
}) {
  return (
    <section className="panel overview-sql-bignum">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="font-mono text-[10px] text-foreground-muted">custom SQL</span>
      </div>
      <div className="panel-body overview-sql-bignum__body">
        <div className="overview-sql-bignum__value">{display}</div>
        <div className="overview-sql-bignum__label font-mono">{label}</div>
      </div>
    </section>
  );
}

export function OverviewSqlBars({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: number; display: string }[];
}) {
  return (
    <LabeledBars
      title={title}
      footer="custom SQL · bar"
      emptyMessage="No bar rows."
      rows={rows.map((row) => ({
        label: row.label,
        value: row.value,
        display: row.display,
        tone: 'accent' as const,
      }))}
    />
  );
}
