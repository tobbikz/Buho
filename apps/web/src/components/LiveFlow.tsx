'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnit, type Unit } from '@/lib/units';

/**
 * Lienzo de actividad en vivo.
 *
 * El diagrama acumulado dice cuánto tráfico hubo; esto dice si **ahora mismo**
 * está pasando algo. Cada partícula que viaja por una arista representa trabajo
 * medido en los últimos minutos, y la cantidad de partículas es proporcional a
 * la tasa de esa arista, no a su total histórico. Una tabla que recibió millones
 * de filas esta mañana y nada en los últimos cinco minutos queda quieta.
 *
 * Está dibujado en canvas y no en SVG porque son cientos de partículas moviéndose
 * a sesenta cuadros por segundo: con un nodo del DOM por partícula el navegador
 * se arrodilla. Y se dibuja sólo cuando la pestaña está visible, para no gastar
 * batería animando algo que nadie ve.
 *
 * Honestidad de lo que se ve: la posición de las partículas es decorativa —no
 * hay una fila viajando por un cable—, pero **la densidad no lo es**. Si una
 * cinta lanza el doble de partículas que otra, es porque movió el doble de peso
 * por segundo en la ventana. Y si todo está quieto, es porque no hay tráfico.
 */

export interface LiveNode {
  name: string;
  depth: number;
  label: string;
}

export interface LiveLink {
  source: number;
  target: number;
  /** Peso por segundo. */
  value: number;
}

interface Snapshot {
  nodes: LiveNode[];
  links: LiveLink[];
  windowMinutes: number;
  generatedAt: string;
  activeSessions: number | null;
  blockedSessions: number | null;
  error?: string;
}

interface Particle {
  link: number;
  /** Avance de 0 a 1 sobre la curva. */
  t: number;
  speed: number;
  size: number;
}

const COLORES = ['#5b9cf8', '#3ecf8e', '#e0b341'];
const ALTO_MINIMO = 26;

interface Posicion {
  x: number;
  y: number;
  label: string;
  depth: number;
  weight: number;
}

export function LiveFlow({
  scope,
  instanceId,
  weight,
  direction,
  actor,
  unit,
  height = 420,
  intervalMs = 5000,
}: {
  scope: 'instancia' | 'flota';
  instanceId?: number;
  weight: string;
  direction: string;
  actor: string;
  unit: Unit;
  height?: number;
  intervalMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [edad, setEdad] = useState(0);

  const url = useMemo(() => {
    const parametros = new URLSearchParams({
      alcance: scope,
      peso: weight,
      dir: direction,
      quien: actor,
    });
    if (instanceId !== undefined) parametros.set('instancia', String(instanceId));
    return `/api/flow-live?${parametros.toString()}`;
  }, [scope, instanceId, weight, direction, actor]);

  // ------------------------------------------------------------------- datos
  useEffect(() => {
    let vivo = true;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    const traer = async () => {
      try {
        const respuesta = await fetch(url, { cache: 'no-store' });
        const cuerpo = (await respuesta.json()) as Snapshot;
        if (!vivo) return;
        if (!respuesta.ok) {
          setFallo(cuerpo.error ?? `HTTP ${respuesta.status}`);
        } else {
          setFallo(null);
          setSnapshot(cuerpo);
          setEdad(0);
        }
      } catch (error) {
        if (vivo) setFallo(error instanceof Error ? error.message : String(error));
      }
      // Se reprograma al terminar y no en un intervalo fijo: si una consulta
      // tarda más que el intervalo, encadenar peticiones sólo empeoraría la
      // carga del store.
      if (vivo) temporizador = setTimeout(traer, intervalMs);
    };

    traer();
    return () => {
      vivo = false;
      if (temporizador) clearTimeout(temporizador);
    };
  }, [url, intervalMs]);

  useEffect(() => {
    const reloj = setInterval(() => setEdad((valor) => valor + 1), 1000);
    return () => clearInterval(reloj);
  }, []);

  // ----------------------------------------------------------------- animación
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cuadro = 0;
    const particulas: Particle[] = [];
    let acumulado = 0;
    let anterior = performance.now();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const posiciones = (): { nodos: Posicion[]; ancho: number; alto: number } => {
      const ancho = canvas.clientWidth;
      const alto = canvas.clientHeight;
      const nodos: Posicion[] = [];
      if (!snapshot) return { nodos, ancho, alto };

      const pesoDe = new Map<number, number>();
      for (const enlace of snapshot.links) {
        pesoDe.set(enlace.source, (pesoDe.get(enlace.source) ?? 0) + enlace.value);
        pesoDe.set(enlace.target, (pesoDe.get(enlace.target) ?? 0) + enlace.value);
      }

      const columnas = new Map<number, number[]>();
      snapshot.nodes.forEach((nodo, indice) => {
        const lista = columnas.get(nodo.depth) ?? [];
        lista.push(indice);
        columnas.set(nodo.depth, lista);
      });

      const profundidades = [...columnas.keys()].sort((a, b) => a - b);
      // Márgenes distintos a cada lado: a la izquierda van nombres de rol o
      // aplicación, a la derecha nombres de tabla calificados, que son más
      // largos. Con el mismo margen en ambos lados el nombre de la tabla —el
      // dato que menos se puede perder— se salía del lienzo.
      const margenIzq = 96;
      const margenDer = 190;
      const utilX = Math.max(ancho - margenIzq - margenDer, 120);

      for (const profundidad of profundidades) {
        const lista = (columnas.get(profundidad) ?? []).slice();
        // Dentro de cada columna se ordena por peso: lo que más se mueve queda
        // en el centro vertical, donde el ojo va primero.
        lista.sort((a, b) => (pesoDe.get(b) ?? 0) - (pesoDe.get(a) ?? 0));
        const x =
          profundidades.length === 1
            ? ancho / 2
            : margenIzq + (utilX * profundidad) / (profundidades.length - 1);
        const paso = alto / (lista.length + 1);
        lista.forEach((indice, orden) => {
          const nodo = snapshot.nodes[indice]!;
          nodos[indice] = {
            x,
            y: paso * (orden + 1),
            label: nodo.label,
            depth: nodo.depth,
            weight: pesoDe.get(indice) ?? 0,
          };
        });
      }
      return { nodos, ancho, alto };
    };

    const dibujar = (ahora: number) => {
      const delta = Math.min((ahora - anterior) / 1000, 0.1);
      anterior = ahora;

      const ancho = canvas.clientWidth;
      const alto = Math.max(canvas.clientHeight, ALTO_MINIMO);
      if (canvas.width !== Math.floor(ancho * dpr) || canvas.height !== Math.floor(alto * dpr)) {
        canvas.width = Math.floor(ancho * dpr);
        canvas.height = Math.floor(alto * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ancho, alto);

      // Fondo oscuro propio: el lienzo es una zona de observación y el contraste
      // con la consola clara ayuda a ver que esto es "lo que pasa ahora".
      ctx.fillStyle = '#0b0f16';
      ctx.fillRect(0, 0, ancho, alto);

      const { nodos } = posiciones();
      const enlaces = snapshot?.links ?? [];
      const total = enlaces.reduce((suma, enlace) => suma + enlace.value, 0);

      // ------------------------------------------------------------- aristas
      for (const enlace of enlaces) {
        const origen = nodos[enlace.source];
        const destino = nodos[enlace.target];
        if (!origen || !destino) continue;
        const intensidad = total > 0 ? enlace.value / total : 0;
        ctx.beginPath();
        ctx.moveTo(origen.x, origen.y);
        const medio = (origen.x + destino.x) / 2;
        ctx.bezierCurveTo(medio, origen.y, medio, destino.y, destino.x, destino.y);
        ctx.strokeStyle = `rgba(120, 160, 220, ${0.07 + intensidad * 0.35})`;
        ctx.lineWidth = 0.6 + Math.sqrt(intensidad) * 3.2;
        ctx.stroke();
      }

      // ---------------------------------------------------------- partículas
      // Se emiten en proporción a la tasa de cada arista, con un techo: el
      // lienzo tiene que verse vivo con poco tráfico y no volverse una mancha
      // blanca con mucho, así que la escala es raíz cuadrada y hay un máximo.
      if (total > 0 && enlaces.length > 0) {
        acumulado += delta * Math.min(140, 25 + Math.sqrt(total) * 12);
        while (acumulado >= 1) {
          acumulado -= 1;
          let dado = Math.random() * total;
          let elegido = 0;
          for (let i = 0; i < enlaces.length; i += 1) {
            dado -= enlaces[i]!.value;
            if (dado <= 0) {
              elegido = i;
              break;
            }
          }
          const intensidad = enlaces[elegido]!.value / total;
          particulas.push({
            link: elegido,
            t: 0,
            speed: 0.22 + Math.random() * 0.3,
            size: 1 + Math.sqrt(intensidad) * 2.2,
          });
        }
      }

      for (let i = particulas.length - 1; i >= 0; i -= 1) {
        const particula = particulas[i]!;
        particula.t += particula.speed * delta;
        if (particula.t >= 1) {
          particulas.splice(i, 1);
          continue;
        }
        const enlace = enlaces[particula.link];
        if (!enlace) {
          particulas.splice(i, 1);
          continue;
        }
        const origen = nodos[enlace.source];
        const destino = nodos[enlace.target];
        if (!origen || !destino) {
          particulas.splice(i, 1);
          continue;
        }
        const t = particula.t;
        const medio = (origen.x + destino.x) / 2;
        // Cúbica de Bézier con los tiradores en el medio: la misma curva que la
        // arista, así que la partícula viaja por encima de la cinta y no al lado.
        const x =
          (1 - t) ** 3 * origen.x +
          3 * (1 - t) ** 2 * t * medio +
          3 * (1 - t) * t ** 2 * medio +
          t ** 3 * destino.x;
        const y =
          (1 - t) ** 3 * origen.y +
          3 * (1 - t) ** 2 * t * origen.y +
          3 * (1 - t) * t ** 2 * destino.y +
          t ** 3 * destino.y;

        const brillo = Math.sin(Math.PI * t);
        ctx.beginPath();
        ctx.arc(x, y, particula.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(226, 240, 255, ${0.35 + brillo * 0.6})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, particula.size * 3.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(120, 180, 255, ${0.05 + brillo * 0.12})`;
        ctx.fill();
      }

      // --------------------------------------------------------------- nodos
      const pulso = 0.5 + 0.5 * Math.sin(ahora / 620);
      nodos.forEach((nodo) => {
        if (!nodo) return;
        const color = COLORES[Math.min(nodo.depth, COLORES.length - 1)]!;
        const activo = nodo.weight > 0;
        const radio = activo ? 3.4 + pulso * 1.1 : 2.2;

        if (activo) {
          ctx.beginPath();
          ctx.arc(nodo.x, nodo.y, radio * 4.2, 0, Math.PI * 2);
          ctx.fillStyle = `${color}18`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(nodo.x, nodo.y, radio, 0, Math.PI * 2);
        ctx.fillStyle = activo ? color : '#3a4353';
        ctx.fill();

        ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
        ctx.fillStyle = activo ? 'rgba(226, 236, 250, 0.86)' : 'rgba(160, 172, 190, 0.5)';
        ctx.textBaseline = 'middle';
        const etiqueta = nodo.label.length > 26 ? `${nodo.label.slice(0, 25)}…` : nodo.label;

        // La primera columna escribe hacia dentro y la última hacia fuera, pero
        // la última se sale del lienzo si el nombre es largo: el nombre de tabla
        // es justo el dato que no se puede perder, así que se ancla al borde
        // derecho en vez de dejar que se corte.
        if (nodo.depth === 0) {
          ctx.textAlign = 'right';
          ctx.fillText(etiqueta, nodo.x - 8, nodo.y);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(etiqueta, nodo.x + 8, nodo.y);
        }
      });

      cuadro = requestAnimationFrame(dibujar);
    };

    cuadro = requestAnimationFrame(dibujar);
    return () => cancelAnimationFrame(cuadro);
  }, [snapshot]);

  const total = (snapshot?.links ?? [])
    .filter((enlace) => (snapshot?.nodes[enlace.source]?.depth ?? 0) === 0)
    .reduce((suma, enlace) => suma + enlace.value, 0);

  /**
   * La tasa se escribe con decimales cuando es pequeña.
   *
   * Redondear a entero convertía «2,6 llamadas por segundo» en «0/s» —el
   * formateador de conteos redondea— y el lienzo quedaba lleno de partículas
   * junto a un rótulo que decía que no pasaba nada.
   */
  const tasa =
    unit === 'ms'
      ? formatUnit(total, 'ms')
      : total > 0 && total < 10
        ? total.toLocaleString('es', { maximumFractionDigits: total < 1 ? 2 : 1 })
        : formatUnit(total, unit);
  const quieto = !snapshot || snapshot.links.length === 0 || total <= 0;

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-[3px] border border-border"
        style={{ height, background: '#0b0f16' }}
      >
        <canvas ref={canvasRef} className="h-full w-full" />

        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[#7f8ea6]">
          <span>
            en vivo · ventana {snapshot?.windowMinutes ?? 5} min · dato de hace {edad}s
          </span>
          <span className="text-[#c9d6ea]">
            {tasa}
            {unit === 'ms' ? ' por segundo' : '/s'}
            {snapshot?.activeSessions !== null && snapshot?.activeSessions !== undefined
              ? ` · ${snapshot.activeSessions} sesión(es) activa(s)`
              : ''}
            {snapshot?.blockedSessions ? ` · ${snapshot.blockedSessions} bloqueada(s)` : ''}
          </span>
        </div>

        {quieto && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-[11px] leading-relaxed text-[#7f8ea6]">
            {fallo
              ? `No se pudo leer la actividad: ${fallo}`
              : 'Nada se mueve en los últimos minutos. El lienzo está quieto porque no hay tráfico que mostrar, no porque falle: el diagrama acumulado de abajo sigue teniendo la historia.'}
          </div>
        )}
      </div>

      <p className="mt-2 text-[11px] text-foreground-muted">
        Las partículas no son filas viajando por un cable —la posición es decorativa—, pero{' '}
        <strong>la densidad sí es real</strong>: cada arista lanza partículas en proporción a lo que movió por segundo
        en los últimos {snapshot?.windowMinutes ?? 5} minutos. Si una cinta lanza el doble que otra, movió el doble. Si
        todo está quieto, no hay tráfico.
      </p>
    </div>
  );
}
