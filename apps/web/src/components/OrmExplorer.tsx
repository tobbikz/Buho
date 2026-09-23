'use client';

import Link from 'next/link';
import { useState } from 'react';
import { OrmGraph } from '@/components/OrmGraph';
import type { OrmLayer, OrmModel } from '@/lib/orm-types';
import { formatUnit, type Unit } from '@/lib/units';
import type { FlowWeight } from '@buho/core';

const LAYERS: { key: OrmLayer; label: string; hint: string }[] = [
  { key: 'ambos', label: 'Both', hint: 'structure + traffic on FK edges' },
  { key: 'estructura', label: 'Structure', hint: 'schemas, tables, foreign keys' },
  { key: 'trafico', label: 'Traffic', hint: 'attributed traffic between related tables' },
];

/**
 * Keeps the force layout mounted when switching layers so huge catalogs do not
 * explode again on every capa click (server navigation was remounting OrmGraph).
 */
export function OrmExplorer({
  model,
  instanceId,
  unit,
  initialLayer,
  weight,
  windowKey,
}: {
  model: OrmModel;
  instanceId: number;
  unit: Unit;
  initialLayer: OrmLayer;
  weight: FlowWeight;
  windowKey: string;
}) {
  const [layer, setLayer] = useState<OrmLayer>(initialLayer);

  const enlace = (cambios: Record<string, string> = {}) => {
    const params = new URLSearchParams({
      peso: weight,
      v: windowKey,
      capa: layer,
      ...cambios,
    });
    return `/instances/${instanceId}/orm?${params.toString()}`;
  };

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Catalog graph</span>
        <div className="flex flex-wrap items-center gap-1">
          {LAYERS.map((opcion) => (
            <button
              key={opcion.key}
              type="button"
              className={`tag ${opcion.key === layer ? 'tag--info' : 'tag--muted'}`}
              title={opcion.hint}
              onClick={() => setLayer(opcion.key)}
            >
              {opcion.label}
            </button>
          ))}
          <span className="mx-1 text-foreground-muted">·</span>
          {layer !== 'estructura'
            ? (
                [
                  { key: 'rows' as const, label: 'Rows' },
                  { key: 'time' as const, label: 'Time' },
                  { key: 'calls' as const, label: 'Calls' },
                ] as const
              ).map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ peso: opcion.key })}
                  className={`tag ${opcion.key === weight ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))
            : null}
          {layer !== 'estructura' ? <span className="mx-1 text-foreground-muted">·</span> : null}
          {layer !== 'estructura'
            ? (
                [
                  { key: '1h', label: '1 h' },
                  { key: '6h', label: '6 h' },
                  { key: '24h', label: '24 h' },
                  { key: '7d', label: '7 d' },
                ] as const
              ).map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ v: opcion.key })}
                  className={`tag ${opcion.key === windowKey ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))
            : null}
        </div>
      </div>
      <div className="panel-body">
        {model.totalTables === 0 ? (
          <div className="empty">No tables in catalog yet. Wait for the collector vacuum scan.</div>
        ) : (
          <OrmGraph model={model} instanceId={instanceId} unit={unit} layer={layer} />
        )}
        {layer !== 'estructura' && model.attributedTables > 0 ? (
          <p className="mt-2 text-[11px] text-foreground-muted">
            Traffic overlay uses {formatUnit(model.nodes.reduce((s, n) => s + n.writeHeat, 0), unit)} write
            and {formatUnit(model.nodes.reduce((s, n) => s + n.readHeat, 0), unit)} read across FK-linked
            tables.
          </p>
        ) : null}
      </div>
    </>
  );
}
