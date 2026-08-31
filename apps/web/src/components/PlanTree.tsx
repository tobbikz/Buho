import type { PlanFinding, PlanNode } from '@buho/core';

/**
 * Árbol del plan de ejecución.
 *
 * La salida de texto de PostgreSQL presenta cuarenta líneas con la misma
 * tipografía, y una de ellas es la culpable. Acá cada nodo lleva:
 *
 * - una **barra de proporción**, para ver de un golpe dónde se va el esfuerzo;
 * - el contraste entre **filas estimadas y reales**, que es la causa raíz de la
 *   mayoría de los planes malos;
 * - un **borde de color** si tiene un hallazgo, con su severidad.
 *
 * Se dibuja con divs anidados y no con un canvas o un SVG de nodos y aristas
 * porque un plan es un árbol muy profundo y poco ancho: la indentación con una
 * guía vertical lo muestra igual de bien, se puede seleccionar el texto,
 * funciona sin JavaScript y no se rompe al imprimir.
 */

const SEVERITY_CLASS: Record<PlanFinding['severity'], string> = {
  critica: 'plan-node--critica',
  alta: 'plan-node--alta',
  media: 'plan-node--media',
  baja: 'plan-node--baja',
};

function formatMs(value: number | null): string {
  if (value === null) return '—';
  if (value < 1) return `${(value * 1000).toFixed(0)} µs`;
  if (value < 1000) return `${value.toFixed(1)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatRows(value: number): string {
  return value.toLocaleString('es', { maximumFractionDigits: 0 });
}

/**
 * Desvío entre lo estimado y lo real, que es lo que hay que mirar primero.
 *
 * Se marca sólo cuando el desvío importa. Una partición vacía donde el
 * planificador esperaba 176 filas y salieron 0 está desviada por infinito y no
 * significa nada: marcarla llena el árbol de alarmas rojas que no llevan a
 * ninguna acción y entrenan al lector a ignorarlas.
 */
function misestimate(node: PlanNode): { under: boolean; label: string } | null {
  if (node.actualRows === null || node.actualLoops === null) return null;

  const estimated = node.planRows * node.actualLoops;
  const actual = node.actualRows;

  // Por debajo de este volumen, equivocarse no cambia el plan elegido.
  if (Math.max(estimated, actual) < 1_000) return null;

  if (actual === 0) return { under: false, label: 'sin filas' };
  if (estimated === 0) return { under: true, label: 'no estimadas' };

  const ratio = actual / estimated;
  if (ratio >= 0.5 && ratio <= 2) return null;

  return ratio > 1
    ? { under: true, label: `${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)}× más` }
    : { under: false, label: `${(1 / ratio).toFixed(1)}× menos` };
}

function Node({
  node,
  findings,
  analyzed,
  depth,
}: {
  node: PlanNode;
  findings: PlanFinding[];
  analyzed: boolean;
  depth: number;
}) {
  const own = findings.filter((finding) => finding.nodeId === node.nodeId);
  const worst = own[0];
  const off = misestimate(node);

  return (
    <div className="plan-branch" style={depth > 0 ? { marginLeft: '1.125rem' } : undefined}>
      <div
        id={`nodo-${node.nodeId}`}
        className={`plan-node ${worst ? SEVERITY_CLASS[worst.severity] : ''}`}
      >
        <div className="plan-node__bar" aria-hidden>
          <span style={{ width: `${Math.max(1, node.share * 100)}%` }} />
        </div>

        <div className="plan-node__head">
          <span className="plan-node__type">{node.type}</span>
          {node.relation ? <span className="plan-node__rel">{node.relation}</span> : null}
          {node.joinType && node.joinType !== 'Inner' ? (
            <span className="tag tag--muted">{node.joinType}</span>
          ) : null}
          {node.parallelWorkers ? (
            <span className="tag tag--muted">{node.parallelWorkers} workers</span>
          ) : null}
          <span className="plan-node__share">{(node.share * 100).toFixed(0)} %</span>
        </div>

        <div className="plan-node__metrics">
          <span>
            filas est. <strong>{formatRows(node.planRows)}</strong>
          </span>
          {node.actualRows !== null ? (
            <span>
              reales <strong>{formatRows(node.actualRows)}</strong>
              {off ? (
                <span className={`plan-node__off ${off.under ? 'is-under' : 'is-over'}`}>{off.label}</span>
              ) : null}
            </span>
          ) : null}
          {analyzed ? (
            <span>
              tiempo propio <strong>{formatMs(node.selfMs)}</strong>
            </span>
          ) : (
            <span>
              costo <strong>{formatRows(node.totalCost)}</strong>
            </span>
          )}
          {node.actualLoops !== null && node.actualLoops > 1 ? (
            <span>
              vueltas <strong>{formatRows(node.actualLoops)}</strong>
            </span>
          ) : null}
          {node.rowsRemovedByFilter ? (
            <span>
              descartadas <strong>{formatRows(node.rowsRemovedByFilter)}</strong>
            </span>
          ) : null}
          {node.sortSpaceType === 'Disk' && node.sortSpaceKb ? (
            <span className="plan-node__off is-under">
              disco {formatRows(Math.round(node.sortSpaceKb / 1024))} MB
            </span>
          ) : null}
          {node.hashBatches && node.hashBatches > 1 ? (
            <span className="plan-node__off is-under">{node.hashBatches} lotes</span>
          ) : null}
        </div>

        {node.indexCond ? (
          <div className="plan-node__cond">
            <span className="plan-node__cond-key">índice</span> {node.indexCond}
          </div>
        ) : null}
        {node.filter ? (
          <div className="plan-node__cond">
            <span className="plan-node__cond-key">filtro</span> {node.filter}
          </div>
        ) : null}

        {own.map((finding) => (
          <div key={finding.title} className="plan-node__finding">
            <span className={`tag tag--${finding.severity === 'critica' || finding.severity === 'alta' ? 'error' : 'warn'}`}>
              {finding.severity}
            </span>
            <span>{finding.title}</span>
          </div>
        ))}
      </div>

      {node.children.map((child) => (
        <Node key={child.nodeId} node={child} findings={findings} analyzed={analyzed} depth={depth + 1} />
      ))}
    </div>
  );
}

export function PlanTree({
  root,
  findings,
  analyzed,
}: {
  root: PlanNode;
  findings: PlanFinding[];
  analyzed: boolean;
}) {
  return (
    <div className="plan-tree">
      <Node node={root} findings={findings} analyzed={analyzed} depth={0} />
    </div>
  );
}
