'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { settingStatus, type SettingGuide } from '@/lib/setting-guides';

export interface ConfigurationInstanceValue {
  instanceId: number;
  alias: string;
  value: string;
  unit: string | null;
  isDefault: boolean | null;
  requiresRestart: boolean | null;
  category: string | null;
}

export interface ConfigurationSetting {
  name: string;
  diverges: boolean;
  allDefault: boolean;
  requiresRestart: boolean;
  instances: ConfigurationInstanceValue[];
  guide: SettingGuide | null;
}

const STATUS_TAG = {
  ok: 'tag--ok',
  review: 'tag--warn',
  neutral: 'tag--muted',
} as const;

const STATUS_LABEL = {
  ok: 'matches',
  review: 'review',
  neutral: '—',
} as const;

function formatValue(value: string, unit: string | null): string {
  const base = value === '' ? '(empty)' : value;
  return unit ? `${base} ${unit}` : base;
}

function rowSummary(setting: ConfigurationSetting): string {
  if (setting.diverges) return 'Values differ across instances';
  if (setting.allDefault) return 'Default on all instances';
  return `Same on ${setting.instances.length} instance(s)`;
}

export function ConfigurationTable({
  engine,
  settings,
}: {
  engine: string;
  aliases: string[];
  settings: ConfigurationSetting[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (settings.length === 0) {
    return <div className="empty">No settings for this engine.</div>;
  }

  return (
    <div className="table-scroll" style={{ maxHeight: '40rem' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: '34%' }}>Parameter</th>
            <th>Summary</th>
            <th style={{ width: '5rem' }}>Restart</th>
          </tr>
        </thead>
        <tbody>
          {settings.map((setting) => {
            const isOpen = expanded === setting.name;
            return (
              <Fragment key={setting.name}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : setting.name)}
                  style={{
                    cursor: 'pointer',
                    background: isOpen
                      ? 'var(--accent-subtle)'
                      : setting.diverges
                        ? 'var(--warning-subtle, #fff8e1)'
                        : undefined,
                  }}
                >
                  <td className="font-mono text-[11px]">
                    <span className="mr-1 text-foreground-muted">{isOpen ? '▾' : '▸'}</span>
                    {setting.name}
                  </td>
                  <td className="text-[11px] text-foreground-secondary">
                    <span className="mr-2">{rowSummary(setting)}</span>
                    {setting.diverges ? <span className="tag tag--warn">diverges</span> : null}
                    {setting.allDefault ? (
                      <span className="tag tag--muted" title="No instance has it set explicitly">
                        default
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {setting.requiresRestart ? <span className="tag tag--muted">yes</span> : '·'}
                  </td>
                </tr>
                {isOpen ? (
                  <tr>
                    <td colSpan={3} style={{ background: 'var(--surface-raised)', padding: 0 }}>
                      <div className="config-detail">
                        {setting.guide ? (
                          <div className="config-detail__guide">
                            <div>
                              <div className="config-detail__label">Recommended</div>
                              <div className="font-mono text-[11.5px]">{setting.guide.recommended}</div>
                            </div>
                            <div className="text-[12px] text-foreground-secondary">{setting.guide.hint}</div>
                          </div>
                        ) : (
                          <p className="text-[12px] text-foreground-muted">
                            No built-in recommendation for this parameter on {engine}.
                          </p>
                        )}

                        <div className="config-detail__label">Values by instance</div>
                        <div className="config-detail__grid">
                          {setting.instances.map((row) => {
                            const status = settingStatus(row.value, setting.guide);
                            return (
                              <div key={row.instanceId} className="config-instance-card">
                                <div className="config-instance-card__header">
                                  <Link
                                    href={`/instances/${row.instanceId}/inventory`}
                                    className="font-semibold underline decoration-dotted"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    {row.alias}
                                  </Link>
                                  <span className={`tag ${STATUS_TAG[status]}`}>{STATUS_LABEL[status]}</span>
                                </div>
                                <div className="config-instance-card__value font-mono">
                                  {formatValue(row.value, row.unit)}
                                </div>
                                <div className="config-instance-card__meta">
                                  {row.isDefault ? (
                                    <span className="tag tag--muted">default</span>
                                  ) : (
                                    <span className="tag tag--ok">configured</span>
                                  )}
                                  {row.requiresRestart ? (
                                    <span className="tag tag--warn">restart required</span>
                                  ) : null}
                                  {row.category ? (
                                    <span className="text-[10px] text-foreground-muted">{row.category}</span>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
