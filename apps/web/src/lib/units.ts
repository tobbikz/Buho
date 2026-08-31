/**
 * Cómo escribir un número, dicho de forma que se pueda cruzar la frontera entre
 * servidor y cliente.
 *
 * React no permite pasar funciones de un componente de servidor a uno de
 * cliente, así que en vez de mandar el formateador se manda el nombre de la
 * unidad y el cliente decide. Sale mejor de todos modos: la unidad es un dato
 * del contenido, y tenerla explícita evita que dos pantallas escriban el mismo
 * número de dos maneras distintas.
 */

export type Unit = 'count' | 'ms' | 'rate';

export function formatUnit(value: number, unit: Unit): string {
  if (unit === 'ms') {
    // Los tiempos de consulta van de microsegundos a horas. Cambiar de escala
    // según la magnitud es lo único que deja comparar de un vistazo.
    if (value < 1) return `${(value * 1000).toFixed(0)} µs`;
    if (value < 1000) return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
    if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
    if (value < 3_600_000) return `${Math.round(value / 60_000)} min`;
    return `${(value / 3_600_000).toFixed(1)} h`;
  }
  if (unit === 'rate') {
    return `${value >= 100 ? Math.round(value).toLocaleString('es-CR') : value.toFixed(1)}/s`;
  }
  const redondeado = Math.round(value);
  if (Math.abs(redondeado) >= 1_000_000) return `${(redondeado / 1_000_000).toFixed(1)} M`;
  if (Math.abs(redondeado) >= 10_000) return `${(redondeado / 1000).toFixed(0)} k`;
  return redondeado.toLocaleString('es-CR');
}
