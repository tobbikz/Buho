'use client';

import { useEffect, useMemo, useState } from 'react';
import { WEEKDAY_LABEL, type HeatCell } from '@/lib/heat-types';
import { formatUnit, type Unit } from '@/lib/units';

/**
 * Rejilla de uso: 7 días por 24 horas (calendario semanal).
 *
 * - Huecos = sin dato (rayado), no cero.
 * - Escala relativa a la propia rejilla; tooltip lleva el valor absoluto.
 * - Un solo tono: el arcoíris inventa umbrales que no existen.
 */

const ESCALA = ['#eaf2fb', '#c3daf2', '#8ab8e4', '#4a8ccf', '#005eb8'];

function colorFor(value: number, max: number): string {
  if (max <= 0) return ESCALA[0] ?? '#eaf2fb';
  const proporcion = Math.sqrt(Math.min(value / max, 1));
  const indice = Math.min(ESCALA.length - 1, Math.floor(proporcion * ESCALA.length));
  return ESCALA[indice] ?? ESCALA[0] ?? '#eaf2fb';
}

const NO_DATA_BG =
  'repeating-linear-gradient(45deg, transparent, transparent 2px, var(--border, #e5e7eb) 2px, var(--border, #e5e7eb) 3px)';

export function Heatmap({
  cells,
  max,
  unit,
  minSamples = 1,
  fill = false,
}: {
  cells: HeatCell[];
  max: number;
  unit: Unit;
  minSamples?: number;
  fill?: boolean;
}) {
  const porClave = useMemo(() => {
    const mapa = new Map<string, HeatCell>();
    for (const celda of cells) mapa.set(`${celda.weekday}-${celda.hour}`, celda);
    return mapa;
  }, [cells]);

  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  useEffect(() => {
    if (!pantallaCompleta) return;
    const onKey = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') setPantallaCompleta(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [pantallaCompleta]);

  const horas = Array.from({ length: 24 }, (_, hora) => hora);
  const dias = [1, 2, 3, 4, 5, 6, 0];

  return (
    <div
      className={
        pantallaCompleta
          ? 'heat-calendar fixed inset-0 z-[200] overflow-auto bg-[var(--surface)] p-4'
          : fill
            ? 'heat-calendar relative h-full min-h-0 flex-1'
            : 'heat-calendar relative'
      }
    >
      <div className={pantallaCompleta ? 'mb-2 flex justify-end' : 'absolute right-0 top-0 z-10'}>
        <button
          type="button"
          className="tag tag--muted"
          onClick={() => setPantallaCompleta((valor) => !valor)}
        >
          {pantallaCompleta ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>

      <table className="heat-calendar__table" aria-label="Weekly usage calendar">
        <thead>
          <tr>
            <th className="heat-calendar__corner" scope="col" />
            {horas.map((hora) => (
              <th key={hora} className="heat-calendar__hour" scope="col">
                {hora % 3 === 0 ? String(hora).padStart(2, '0') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dias.map((dia) => (
            <tr key={dia}>
              <th className="heat-calendar__day" scope="row">
                {WEEKDAY_LABEL[dia]}
              </th>
              {horas.map((hora) => {
                const celda = porClave.get(`${dia}-${hora}`);
                if (!celda) {
                  return (
                    <td key={hora}>
                      <div
                        className="heat-calendar__cell"
                        title={`${WEEKDAY_LABEL[dia]} ${String(hora).padStart(2, '0')}:00 · no data`}
                        style={{ background: NO_DATA_BG }}
                      />
                    </td>
                  );
                }
                const pocoFiable = celda.samples < minSamples;
                return (
                  <td key={hora}>
                    <div
                      className="heat-calendar__cell"
                      title={
                        `${WEEKDAY_LABEL[dia]} ${String(hora).padStart(2, '0')}:00 · ${formatUnit(celda.value, unit)}` +
                        ` · ${celda.samples} measured hour${celda.samples === 1 ? '' : 's'}` +
                        (pocoFiable ? ' · sparse data' : '')
                      }
                      style={{
                        background: colorFor(celda.value, max),
                        opacity: pocoFiable ? 0.45 : 1,
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="heat-calendar__legend">
        <span>0</span>
        {ESCALA.map((color) => (
          <span
            key={color}
            className="inline-block rounded-[2px]"
            style={{ width: 18, height: 8, background: color }}
          />
        ))}
        <span>{formatUnit(max, unit)}</span>
        <span className="ml-2 inline-flex items-center gap-1">
          <span
            className="inline-block rounded-[2px]"
            style={{ width: 18, height: 8, background: NO_DATA_BG }}
          />
          no data
        </span>
      </div>
    </div>
  );
}
