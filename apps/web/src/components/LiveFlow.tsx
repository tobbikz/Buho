'use client';

import Link from 'next/link';
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
  /** Tasa "normal" de esta instancia, para saber si lo de ahora es mucho. */
  referenceRate: number | null;
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
  /** Las de ráfaga se dibujan más brillantes: marcan lo que acaba de subir. */
  burst: boolean;
}

const COLORES = ['#5b9cf8', '#3ecf8e', '#e0b341'];
const ALTO_MINIMO = 26;

/**
 * Techo de partículas por segundo en todo el lienzo.
 *
 * No es un límite estético: por encima de esto el ojo ya no distingue más
 * densidad y el navegador empieza a gastar batería para nada.
 */
const MAX_PARTICULAS_POR_SEGUNDO = 220;

/** Cuántas partículas de golpe por cada duplicación de una arista. */
const RAFAGA_MAXIMA = 14;

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
  /**
   * Mayor tasa vista desde que se abrió la pantalla, con decaimiento.
   *
   * Es la escala contra la que se mide "mucho" o "poco". Decae despacio para
   * que un pico de hace media hora no deje el lienzo apagado el resto de la
   * tarde, y no baja de un mínimo para que un hilo de tráfico no se vea como
   * una tormenta.
   */
  const referenciaRef = useRef(1);
  /**
   * Dónde quedó dibujado cada nodo, para poder acertar el clic.
   *
   * El lienzo se dibuja en canvas, así que no hay elementos que reciban eventos:
   * la posición hay que guardarla al pintar y buscar el nodo más cercano al
   * punto donde se pinchó.
   */
  const posicionesRef = useRef<{ x: number; y: number; label: string; depth: number; name: string }[]>([]);
  const [elegido, setElegido] = useState<{ label: string; depth: number; name: string } | null>(null);
  const rafagasRef = useRef<{ link: number; count: number }[]>([]);
  const previoRef = useRef<Map<string, number>>(new Map());
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

          // Referencia y ráfagas se calculan aquí y no en el bucle de dibujo:
          // el bucle corre sesenta veces por segundo y comparar fotos ahí sería
          // repetir el mismo cálculo sesenta veces por cada dato nuevo.
          const totalNuevo = cuerpo.links.reduce((suma, enlace) => suma + enlace.value, 0);
          referenciaRef.current =
            cuerpo.referenceRate && cuerpo.referenceRate > 0
              ? // La referencia viene del servidor: es el percentil 90 de esta
                // instancia en los últimos días. Se deja subir si ahora mismo se
                // está superando —un récord tiene que verse a tope y no
                // desbordado— pero nunca por debajo de la historia, que es lo
                // que hacía que cualquier tráfico estable se viera al máximo.
                Math.max(cuerpo.referenceRate, totalNuevo)
              : Math.max(0.35, totalNuevo, referenciaRef.current * 0.97);

          const previo = previoRef.current;
          const actual = new Map<string, number>();
          const rafagas: { link: number; count: number }[] = [];
          cuerpo.links.forEach((enlace, indice) => {
            const origen = cuerpo.nodes[enlace.source]?.name ?? String(enlace.source);
            const destino = cuerpo.nodes[enlace.target]?.name ?? String(enlace.target);
            const clave = `${origen}->${destino}`;
            actual.set(clave, enlace.value);
            const antes = previo.get(clave);
            if (antes === undefined) {
              // Arista nueva: algo empezó a moverse donde antes no había nada.
              if (enlace.value > 0) rafagas.push({ link: indice, count: 6 });
              return;
            }
            if (antes > 0 && enlace.value > antes * 1.15) {
              const veces = enlace.value / antes;
              rafagas.push({
                link: indice,
                count: Math.min(RAFAGA_MAXIMA, Math.ceil((veces - 1) * 8)),
              });
            }
          });
          previoRef.current = actual;
          if (rafagas.length > 0) rafagasRef.current = rafagas;

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
    // Un acumulador por arista y no uno global: con uno solo, la arista que más
    // pesa se llevaba casi todas las partículas por sorteo y las demás
    // parpadeaban. Cada arista emite a su propio ritmo, que es lo que hace que
    // el dibujo se parezca al tráfico y no a un promedio.
    const acumulado: number[] = [];
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
      posicionesRef.current = nodos
        .map((nodo, indice) =>
          nodo
            ? { x: nodo.x, y: nodo.y, label: nodo.label, depth: nodo.depth, name: snapshot?.nodes[indice]?.name ?? nodo.label }
            : null,
        )
        .filter((nodo): nodo is { x: number; y: number; label: string; depth: number; name: string } => nodo !== null);
      const enlaces = snapshot?.links ?? [];
      const total = enlaces.reduce((suma, enlace) => suma + enlace.value, 0);

      // La actividad relativa a la referencia gobierna el brillo de todo el
      // lienzo: con poco tráfico las cintas quedan apenas insinuadas y con mucho
      // se encienden. Es la diferencia entre un dibujo y un instrumento.
      const actividad = Math.min(1, total / referenciaRef.current);

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
        ctx.strokeStyle = `rgba(120, 160, 220, ${0.05 + intensidad * 0.2 + actividad * 0.2})`;
        ctx.lineWidth = 0.6 + Math.sqrt(intensidad) * 3.2;
        ctx.stroke();
      }

      // ---------------------------------------------------------- partículas
      //
      // La emisión de cada arista es **proporcional a su tasa**, sin piso: si no
      // se movió nada, no sale nada. La primera versión sumaba una constante y
      // aplicaba raíz cuadrada al total, y el resultado era que media llamada por
      // segundo y cincuenta se veían casi igual: una animación bonita que no
      // informaba de nada.
      //
      // La escala se calibra contra la mayor tasa vista en esta sesión de
      // observación, no contra un número fijo: 50 filas por segundo es mucho en
      // una base pequeña y nada en un datalake, y sin referencia propia habría
      // que elegir mal para todos. Con eso, cuando el tráfico se duplica se ven
      // el doble de partículas, y cuando cae se vacía.
      const referencia = referenciaRef.current;
      const porSegundoTotal = Math.min(MAX_PARTICULAS_POR_SEGUNDO, (total / referencia) * MAX_PARTICULAS_POR_SEGUNDO);

      for (let i = 0; i < enlaces.length; i += 1) {
        const enlace = enlaces[i]!;
        if (enlace.value <= 0) continue;
        const cuota = total > 0 ? enlace.value / total : 0;
        acumulado[i] = (acumulado[i] ?? Math.random()) + delta * porSegundoTotal * cuota;
        while ((acumulado[i] ?? 0) >= 1) {
          acumulado[i] = (acumulado[i] ?? 0) - 1;
          particulas.push({
            link: i,
            t: 0,
            // La velocidad también sigue a la tasa: un flujo intenso se ve
            // rápido además de denso, que es cómo se lee "está pasando algo".
            speed: 0.16 + Math.min(0.55, (total / referencia) * 0.5) + Math.random() * 0.12,
            size: 1 + Math.sqrt(cuota) * 2.2,
            burst: false,
          });
        }
      }

      // Ráfagas: cuando una arista sube respecto a la foto anterior, se lanza un
      // puñado de partículas brillantes de golpe. Es lo que hace visible el
      // cambio; sin esto, una subida sólo se notaría comparando densidades de
      // memoria.
      const pendientes = rafagasRef.current;
      if (pendientes.length > 0) {
        for (const rafaga of pendientes) {
          if (!enlaces[rafaga.link]) continue;
          for (let n = 0; n < rafaga.count; n += 1) {
            particulas.push({
              link: rafaga.link,
              t: Math.random() * 0.12,
              speed: 0.45 + Math.random() * 0.25,
              size: 1.8 + Math.random(),
              burst: true,
            });
          }
        }
        rafagasRef.current = [];
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
        ctx.fillStyle = particula.burst
          ? `rgba(255, 246, 214, ${0.45 + brillo * 0.55})`
          : `rgba(226, 240, 255, ${0.35 + brillo * 0.6})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, particula.size * 3.2, 0, Math.PI * 2);
        ctx.fillStyle = particula.burst
          ? `rgba(255, 210, 120, ${0.08 + brillo * 0.18})`
          : `rgba(120, 180, 255, ${0.05 + brillo * 0.12})`;
        ctx.fill();
      }

      // --------------------------------------------------------------- nodos
      // El latido de los nodos se acelera con la actividad: quieto es un
      // parpadeo lento, cargado es un pulso rápido.
      const pulso = 0.5 + 0.5 * Math.sin(ahora / (900 - actividad * 500));
      nodos.forEach((nodo) => {
        if (!nodo) return;
        const color = COLORES[Math.min(nodo.depth, COLORES.length - 1)]!;
        const activo = nodo.weight > 0;
        const radio = activo ? 3 + pulso * (0.6 + actividad * 1.4) : 2.2;

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

  /**
   * Busca el nodo más cercano al clic.
   *
   * Con un radio generoso: los nodos son puntos de tres píxeles y exigir
   * puntería sobre eso sería una función que existe pero nadie usa. Si no hay
   * nada cerca, se cierra el menú, que es lo que espera quien pincha al vacío.
   */
  const alPinchar = (evento: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const caja = canvas.getBoundingClientRect();
    const x = evento.clientX - caja.left;
    const y = evento.clientY - caja.top;

    let mejor: { label: string; depth: number; name: string } | null = null;
    let distancia = 26;
    for (const nodo of posicionesRef.current) {
      const d = Math.hypot(nodo.x - x, nodo.y - y);
      if (d < distancia) {
        distancia = d;
        mejor = { label: nodo.label, depth: nodo.depth, name: nodo.name };
      }
    }
    setElegido(mejor);
  };

  // El nombre interno viene con prefijo ('tabla:esquema.tabla'), que es lo que
  // hay que buscar en las consultas; la etiqueta es sólo lo que se dibuja.
  const objetivo = elegido ? elegido.name.replace(/^[a-zá-ú]+:/i, '') : null;
  const destinos: { href: string; label: string }[] = [];
  if (elegido && objetivo) {
    const base = instanceId !== undefined ? `/instances/${instanceId}` : null;
    if (base) {
      destinos.push({
        href: `${base}/queries?buscar=${encodeURIComponent(elegido.depth === 2 ? (objetivo.split('.').pop() ?? objetivo) : objetivo)}`,
        label: 'ver sus consultas',
      });
      if (elegido.depth === 2) {
        destinos.push({ href: `${base}/vacuum`, label: 'estado de vacuum y bloat' });
        destinos.push({ href: `${base}/indexes`, label: 'índices y sugerencias' });
      }
    }
  }

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-[3px] border border-border"
        style={{ height, background: '#0b0f16' }}
      >
        <canvas ref={canvasRef} className="h-full w-full cursor-pointer" onClick={alPinchar} />

        {elegido && destinos.length > 0 && (
          <div className="absolute bottom-3 right-3 rounded-[3px] border border-[#26303f] bg-[#101724] px-3 py-2 text-[11px] shadow-lg">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[#7f8ea6]">
              {elegido.depth === 0 ? 'quién' : elegido.depth === 1 ? 'esquema' : 'tabla'}
            </div>
            <div className="mb-2 font-mono text-[12px] text-[#dce6f5]">{elegido.label}</div>
            <div className="flex flex-col gap-1">
              {destinos.map((destino) => (
                <Link key={destino.href} href={destino.href} className="text-[#7fb2ff] hover:underline">
                  {destino.label}
                </Link>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setElegido(null)}
              className="mt-2 font-mono text-[10px] text-[#6b7889] hover:text-[#9fb0c6]"
            >
              cerrar
            </button>
          </div>
        )}

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
          {snapshot?.referenceRate ? (
            <span>
              {total <= 0
                ? 'quieto'
                : `${Math.round((total / snapshot.referenceRate) * 100)} % de lo habitual en esta instancia`}
            </span>
          ) : null}
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
        Se puede pinchar cualquier nodo para saltar a sus consultas, y en las tablas también a su vacuum y a sus
        índices. Las partículas no son filas viajando por un cable —la posición es decorativa—, pero{' '}
        <strong>la densidad sí es real</strong>: cada arista lanza partículas en proporción a lo que movió por segundo
        en los últimos {snapshot?.windowMinutes ?? 5} minutos. Si una cinta lanza el doble que otra, movió el doble. Si
        todo está quieto, no hay tráfico.
      </p>
    </div>
  );
}
