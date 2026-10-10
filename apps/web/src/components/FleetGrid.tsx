'use client';

import Link from 'next/link';
import { FleetInstanceCard } from '@/components/FleetInstanceCard';
import type { FleetCardDensity } from '@/components/FleetCardDensity';
import type { Group } from '@/lib/grouping';
import type { FleetInstance, Severity } from '@/lib/queries';

export function FleetGrid({
  groups,
  groupKey,
  density = 'medium',
  postureHeavyIds,
  onBadgeClick,
}: {
  groups: Group<FleetInstance>[];
  groupKey: string;
  density?: FleetCardDensity;
  postureHeavyIds?: Set<number>;
  onBadgeClick?: (severity: Severity, instance: FleetInstance) => void;
}) {
  return (
    <div className="fleet-grid">
      {groups.map((group) => {
        const criticals = group.instances.reduce((sum, item) => sum + item.critical, 0);
        return (
          <section key={group.value || 'all'} className="fleet-grid__section">
            {group.value ? (
              <header className="fleet-grid__header">
                <Link
                  href={`/?agrupar=${encodeURIComponent(groupKey)}&filtro=${encodeURIComponent(`${groupKey}:${group.value}`)}`}
                  className="fleet-grid__group-name"
                >
                  {group.value}
                </Link>
                <span className="fleet-grid__group-meta">
                  {group.instances.length} instance{group.instances.length === 1 ? '' : 's'}
                  {criticals > 0 ? ` · ${criticals} critical` : ''}
                </span>
              </header>
            ) : null}

            <div className={`fleet-grid__cards fleet-grid__cards--${density}`}>
              {group.instances.map((instance) => (
                <FleetInstanceCard
                  key={instance.instanceId}
                  instance={instance}
                  density={density}
                  postureHeavy={postureHeavyIds?.has(instance.instanceId) ?? false}
                  onBadgeClick={onBadgeClick}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
