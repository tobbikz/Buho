import Link from 'next/link';

export type ProveRestoreItem = {
  id: string;
  label: string;
  detail: string;
  href?: string;
  doneHint: string;
};

/**
 * Operational prove-restore checklist — not an automated restore test.
 * Gives DBA a shared board for “have we proven we can recover?”.
 */
export function ProveRestore({
  items,
  title = 'Prove restore',
  subtitle = 'ops checklist',
  compact = false,
}: {
  items: ProveRestoreItem[];
  title?: string;
  subtitle?: string;
  /** Tighter list for Blame (label + doneHint only). */
  compact?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="font-mono text-[10px] text-foreground-muted">{subtitle}</span>
      </div>
      <div className="panel-body">
        {!compact ? (
          <p className="text-[12px] text-foreground-secondary m-0 mb-2">
            Inventory proves backup age; this board tracks whether someone has actually restored.
          </p>
        ) : null}
        <ol className="m-0 pl-4 flex flex-col gap-1.5 text-[12px] text-foreground-secondary">
          {items.map((item) => (
            <li key={item.id} className="leading-snug">
              {item.href ? (
                <Link href={item.href} className="underline decoration-dotted text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span className="text-foreground">{item.label}</span>
              )}
              {!compact && item.detail ? (
                <span className="text-foreground-muted"> — {item.detail}</span>
              ) : null}
              <span className="block font-mono text-[10px] text-foreground-muted">
                {item.doneHint}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function fleetProveRestoreItems(): ProveRestoreItem[] {
  return [
    {
      id: 'rpo-tab',
      label: 'Review Estate RPO for breached / broken instances',
      detail: 'Confirm every SQL engine has a provable continuous recovery signal.',
      href: '/estate/rpo',
      doneHint: 'Done when: no unexplained broken rows',
    },
    {
      id: 'restore-drill',
      label: 'Quarterly restore drill (full or PITR sample)',
      detail: 'Restore to a throwaway host; record wall-clock and data loss vs RPO target.',
      doneHint: 'Done when: dated note in runbook + RPO met in drill',
    },
    {
      id: 'archive-dest',
      label: 'Verify archive / log backup destination is readable',
      detail: 'WAL/binlog/RMAN dest must be mountable by the restore host.',
      doneHint: 'Done when: restore host listed the files',
    },
    {
      id: 'owner-tags',
      label: 'Set rpo_seconds (or rpo_hours) tags on critical instances',
      detail: 'Default target is 15m; override per instance so pack.rpo_exposure matches reality.',
      href: '/admin/instances',
      doneHint: 'Done when: tag present on prod instances',
    },
  ];
}

export function instanceProveRestoreItems(instanceId: number): ProveRestoreItem[] {
  return [
    {
      id: 'backups-tab',
      label: 'Confirm latest full / log / archive signal on Backups',
      detail: 'Age and state must match your RPO target tag.',
      href: `/instances/${instanceId}/backups`,
      doneHint: 'Done when: exposure ≤ target on Estate RPO',
    },
    {
      id: 'restore-smoke',
      label: 'Smoke restore (one table or one PDB / DB)',
      detail: 'Prove credentials + backup media; capture duration.',
      doneHint: 'Done when: dated note with duration',
    },
    {
      id: 'pitr',
      label: 'PITR to a known timestamp (if archive on)',
      detail: 'Validate continuous recovery chain, not only full dumps.',
      doneHint: 'Done when: restored to T−target',
    },
    {
      id: 'estate-rpo',
      label: 'Cross-check Estate RPO row for this instance',
      detail: 'Broken / breached means the war-room story is recovery, not app latency.',
      href: '/estate/rpo',
      doneHint: 'Done when: status is Met (or accepted exception)',
    },
  ];
}
