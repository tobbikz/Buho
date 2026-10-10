'use client';

import { useEffect, useMemo, useState } from 'react';
import { WEEKDAY_LABEL, type HeatCell } from '@/lib/heat-types';
import { formatUnit, type Unit } from '@/lib/units';

/**
 * Rejilla de uso: 7 días por 24 horas.
 *
 * Decisiones que importan para que se pueda leer:
 *
 * - **Los huecos se dibujan como huecos**, no como cero. Una celda no data y
 *   una celda con carga cero son cosas distintas: la primera dice "no estaba
 *   mirando" y la segunda "no pasaba nada". Confundirlas hace que un servidor
 *   recién instalado parezca tranquilo a las horas que nadie midió.
 * - **La escala es relativa a la propia rejilla**, así que el color no compara
 *   entre instancias. El número absoluto va en el tooltip y en los extremos.
 * - Se usa una escala secuencial de un solo tono. Las de arcoíris inventan
 *   fronteras donde el dato es continuo: el salto de verde a amarillo se lee
 *   como un umbral que no existe.
 */

/** Azul de la casa, de claro a oscuro. Cinco pasos: más no se distinguen. */
const ESCALA = ['#eaf2fb', '#c3daf2', '#8ab8e4', '#4a8ccf', '#005eb8'];

function colorFor(value: number, max: number): string {
  if (max <= 0) return ESCALA[0] ?? '#eaf2fb';
  // Raíz cuadrada en vez de lineal: la carga suele tener un pico que aplasta
  // todo lo demás, y con escala lineal la rejilla queda casi toda del color más
  // claro y no se ve la forma de la semana.
  const proporcion = Math.sqrt(Math.min(value / max, 1));
  const indice = Math.min(ESCALA.length - 1, Math.floor(proporcion * ESCALA.length));
  return ESCALA[indice] ?? ESCALA[0] ?? '#eaf2fb';
}

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
  /** Debajo de esto la celda se marca como poco fiable. */
  minSamples?: number;
  /** Stretch the grid to the height of the panel beside it. */
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
  // Lunes primero: la semana laboral se lee mejor junta, y el fin de semana
  // abajo es donde uno busca la window de mantenimiento.
  const dias = [1, 2, 3, 4, 5, 6, 0];

  const cellStyle = fill ? { width: '100%', height: '100%' } : { width: 20, height: 16 };

  return (
    <div
      className={
        pantallaCompleta
          ? 'fixed inset-0 z-[200] flex flex-col overflow-auto bg-[var(--surface)] p-4'
          : fill
            ? 'relative flex h-full min-h-0 flex-1 flex-col overflow-x-auto'
            : 'relative overflow-x-auto'
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
      <table className={`border-separate ${fill ? 'h-full w-full flex-1' : ''}`} style={{ borderSpacing: '2px' }}>
        <thead>
          <tr>
            <th />
            {horas.map((hora) => (
              <th
                key={hora}
                className="font-mono text-[9px] font-normal text-foreground-muted"
                style={{ width: 20 }}
              >
                {hora % 3 === 0 ? String(hora).padStart(2, '0') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dias.map((dia) => (
            <tr key={dia} style={fill ? { height: `${100 / dias.length}%` } : undefined}>
              <td className="pr-1 text-right font-mono text-[10px] text-foreground-muted">
                {WEEKDAY_LABEL[dia]}
              </td>
              {horas.map((hora) => {
                const celda = porClave.get(`${dia}-${hora}`);
                if (!celda) {
                  return (
                    <td key={hora}>
                      {/* Hueco: sin dato, no cero. El rayado lo distingue del
                          color más claro de la escala. */}
                      <div
                        title={`${WEEKDAY_LABEL[dia]} ${String(hora).padStart(2, '0')}:00 · no data`}
                        style={{
                          ...cellStyle,
                          background:
                            'repeating-linear-gradient(45deg, transparent, transparent 2px, var(--border, #e5e7eb) 2px, var(--border, #e5e7eb) 3px)',
                        }}
                      />
                    </td>
                  );
                }
                const pocoFiable = celda.samples < minSamples;
                return (
                  <td key={hora}>
                    <div
                      title={
                        `${WEEKDAY_LABEL[dia]} ${String(hora).padStart(2, '0')}:00 · ${formatUnit(celda.value, unit)}` +
                        ` · ${celda.samples} measured hour${celda.samples === 1 ? '' : 's'}` +
                        (pocoFiable ? ' · sparse data' : '')
                      }
                      style={{
                        ...cellStyle,
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

      <div className="mt-2 flex items-center gap-2 text-[10px] text-foreground-muted">
        <span>0</span>
        {ESCALA.map((color) => (
          <span key={color} className="inline-block" style={{ width: 20, height: 8, background: color }} />
        ))}
        <span>{formatUnit(max, unit)}</span>
        <span className="ml-3 inline-flex items-center gap-1">
          <span
            className="inline-block"
            style={{
              width: 20,
              height: 8,
              background:
                'repeating-linear-gradient(45deg, transparent, transparent 2px, var(--border, #e5e7eb) 2px, var(--border, #e5e7eb) 3px)',
            }}
          />
          no data
        </span>
      </div>
    </div>
  );
}
