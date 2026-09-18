'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Design lab for Flow polish — same Current layout, different motion / finish.
 * Inspired by ApexSankey particleFlow, RoutePulse canvas particles,
 * glass KPI dashboards, and path-highlight Sankeys.
 */

type PolishId =
  | 'current'
  | 'dense-comet'
  | 'dense-particles'
  | 'ribbon-gradient'
  | 'path-focus'
  | 'comet-trails'
  | 'pulse-nodes'
  | 'glass-kpis'
  | 'soft-depth'
  | 'stagger-enter'
  | 'ember-glow';

interface PolishOption {
  id: PolishId;
  name: string;
  vibe: string;
  inspiredBy: string;
  sources: string[];
  why: string;
}

const POLISHES: PolishOption[] = [
  {
    id: 'current',
    name: 'Current (baseline)',
    vibe: 'Light · particles · flat cards',
    inspiredBy: 'Búho Flow today',
    sources: ['LiveFlow canvas'],
    why: 'What you already have. Reference for every other pack.',
  },
  {
    id: 'dense-comet',
    name: 'Dense + comet ★',
    vibe: 'More particles · size ∝ volume · trails',
    inspiredBy: 'Your pick — ApexSankey density + RoutePulse trails',
    sources: ['apexcharts particleFlow', 'RoutePulse / orderflow trails'],
    why: 'Applied on live Flow: denser emission, bigger heads on hot links, comet trails along the curve.',
  },
  {
    id: 'dense-particles',
    name: 'Dense particles',
    vibe: 'More dots · size ∝ volume',
    inspiredBy: 'ApexSankey particleFlow',
    sources: ['apexcharts.com/apexsankey (Particle Flow)'],
    why: 'Heavier links spawn denser / bigger particles so heat is obvious at a glance.',
  },
  {
    id: 'comet-trails',
    name: 'Comet trails',
    vibe: 'Particles leave a short blur trail',
    inspiredBy: 'RoutePulse / trading orderflow canvases',
    sources: ['RoutePulse Sankey particles', 'orderflow-component GH'],
    why: 'Motion direction is clearer; trails sell “live” without changing the layout.',
  },
  {
    id: 'ribbon-gradient',
    name: 'Ribbon gradient',
    vibe: 'Bands blend write→table→read',
    inspiredBy: 'ApexSankey edgeGradientFill',
    sources: ['apexcharts.com/apexsankey'],
    why: 'Soft colored ribbons under the particles — flow reads as a handoff, not just dots.',
  },
  {
    id: 'path-focus',
    name: 'Path focus',
    vibe: 'Hover lights one path · dims rest',
    inspiredBy: 'ApexSankey highlightConnectedPath',
    sources: ['apexcharts.com/apexsankey (Connected Path Highlight)'],
    why: 'Click/hover a table and everything else fades — classic “trace this flow” UX.',
  },
  {
    id: 'pulse-nodes',
    name: 'Pulse nodes',
    vibe: 'Hot tables breathe · soft ring',
    inspiredBy: 'Ops HUD health rings',
    sources: ['SkyWalking health rings', 'command-deck instruments'],
    why: 'The hot table gently pulses so your eye lands there before reading numbers.',
  },
  {
    id: 'glass-kpis',
    name: 'Glass KPIs',
    vibe: 'Frosted cards · sparkline · count-up',
    inspiredBy: 'Glassmorphism KPI dashboards',
    sources: ['glass KPI + Framer Motion counters', 'Refero dashboard patterns'],
    why: 'Same metrics, prettier tiles: blur, hairline border, mini sparkline under the number.',
  },
  {
    id: 'soft-depth',
    name: 'Soft depth',
    vibe: 'Shadow · radius · quieter chrome',
    inspiredBy: 'Modern SaaS polish (not redesign)',
    sources: ['dashboard UI best practices · elevation'],
    why: 'No new metaphor — just depth, spacing, and a calmer panel so the diagram owns the page.',
  },
  {
    id: 'stagger-enter',
    name: 'Stagger enter',
    vibe: 'KPIs → diagram → bars fade in',
    inspiredBy: 'ApexSankey entrance animation',
    sources: ['apexcharts.com/apexsankey/docs/animation'],
    why: 'First paint feels intentional; respects prefers-reduced-motion in a real build.',
  },
  {
    id: 'ember-glow',
    name: 'Ember glow',
    vibe: 'Write/read edges softly glow',
    inspiredBy: 'Datadog flow edge emphasis',
    sources: ['Datadog Request Flow Map edge weight'],
    why: 'Keep Current colors; add a faint outer glow on active edges so volume pops on white.',
  },
];

const STORAGE_KEY = 'buho-flow-polish-pick';

function KpiRow({ glass }: { glass?: boolean }) {
  const items = [
    { label: 'Write heat', v: '7.9M', spark: [2, 3, 5, 8, 7, 9, 11] },
    { label: 'Read heat', v: '1,970', spark: [4, 4, 3, 5, 6, 5, 7] },
    { label: 'Tables', v: '1', spark: [1, 1, 1, 1, 1, 1, 1] },
    { label: 'Attributed', v: '4 / 5', spark: [3, 4, 4, 5, 4, 5, 5] },
  ];
  return (
    <div className={`dlp-kpis ${glass ? 'dlp-kpis--glass' : ''}`}>
      {items.map((item) => (
        <div key={item.label} className="dlp-kpi">
          <div className="dlp-kpi__label">{item.label}</div>
          <div className="dlp-kpi__value">{item.v}</div>
          <div className="dlp-kpi__hint">attributed, window 24 h</div>
          {glass ? (
            <svg className="dlp-spark" viewBox="0 0 56 16" aria-hidden>
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                points={item.spark
                  .map((y, i) => `${i * 9},${16 - y}`)
                  .join(' ')}
              />
            </svg>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function FlowStage({ polish }: { polish: PolishId }) {
  const dense = polish === 'dense-particles' || polish === 'dense-comet';
  const gradient = polish === 'ribbon-gradient';
  const focus = polish === 'path-focus';
  const comet = polish === 'comet-trails' || polish === 'dense-comet';
  const pulse = polish === 'pulse-nodes';
  const glow = polish === 'ember-glow';
  const count = dense ? 28 : 14;

  return (
    <div
      className={[
        'dlp-stage',
        gradient && 'dlp-stage--gradient',
        focus && 'dlp-stage--focus',
        glow && 'dlp-stage--glow',
        polish === 'soft-depth' && 'dlp-stage--depth',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="dlp-stage__toolbar">
        <span className="dlp-stage__title">Hot tables · writes & reads</span>
        <span className="dlp-stage__tags">
          <i className="is-on">Live</i>
          <i>Accumulated</i>
          <i className="is-on">Rows</i>
          <i>1 h</i>
          <i className="is-on">24 h</i>
        </span>
      </div>

      <div className="dlp-diagram">
        {gradient ? (
          <svg className="dlp-ribbons" viewBox="0 0 400 160" preserveAspectRatio="none">
            <defs>
              <linearGradient id="gw" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#0a6e42" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#0a6e42" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="gr" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#005eb8" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#005eb8" stopOpacity="0.05" />
              </linearGradient>
            </defs>
            <path d="M70 48 C160 48, 200 70, 290 78" stroke="url(#gw)" strokeWidth="18" fill="none" />
            <path d="M70 112 C160 112, 200 90, 290 82" stroke="url(#gr)" strokeWidth="10" fill="none" />
          </svg>
        ) : null}

        <div className="dlp-src dlp-src--w">
          <b />
          Writes
        </div>
        <div className="dlp-src dlp-src--r">
          <b />
          Reads
        </div>

        <div className={`dlp-particles ${comet ? 'dlp-particles--comet' : ''} ${dense ? 'dlp-particles--dense' : ''}`}>
          {Array.from({ length: count }).map((_, i) => (
            <i
              key={i}
              className={i % 3 === 0 ? 'r' : 'w'}
              style={{
                ['--i' as string]: i,
                ['--s' as string]: dense ? 1 + (i % 4) * 0.35 : 1,
              }}
            />
          ))}
        </div>

        <div className={`dlp-node ${pulse ? 'dlp-node--pulse' : ''} ${focus ? 'dlp-node--lit' : ''}`}>
          <span className="dlp-node__schema">buho_demo</span>
          <span className="dlp-node__table">orders</span>
        </div>

        {focus ? <div className="dlp-dim" aria-hidden /> : null}
      </div>

      <p className="dlp-footnote">
        Green = writes, blue = reads. Particle density is log-scaled to traffic.
      </p>
    </div>
  );
}

function MixBar() {
  return (
    <div className="dlp-mix">
      <div className="dlp-mix__title">Traffic mix per table</div>
      <div className="dlp-mix__row">
        <code>buho_demo.orders</code>
        <div className="dlp-mix__bar">
          <i style={{ width: '72%', background: '#0a6e42' }} />
          <i style={{ width: '18%', background: '#005eb8' }} />
          <i style={{ width: '10%', background: '#8a5a00' }} />
        </div>
      </div>
    </div>
  );
}

function PolishPreview({ id }: { id: PolishId }) {
  const glass = id === 'glass-kpis';
  const depth = id === 'soft-depth' || glass;
  const stagger = id === 'stagger-enter';

  return (
    <div
      className={[
        'dlp',
        depth && 'dlp--depth',
        stagger && 'dlp--stagger',
        glass && 'dlp--glass',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <KpiRow glass={glass} />
      <FlowStage polish={id} />
      <MixBar />
    </div>
  );
}

export function FlowDesignCanvas() {
  const [picked, setPicked] = useState<PolishId | null>('dense-comet');
  const [focus, setFocus] = useState<PolishId>('dense-comet');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as PolishId | null;
      if (saved && POLISHES.some((p) => p.id === saved)) {
        setPicked(saved);
        setFocus(saved);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const active = useMemo(() => POLISHES.find((p) => p.id === focus) ?? POLISHES[0]!, [focus]);

  const choose = (id: PolishId) => {
    setPicked(id);
    setFocus(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="dl-lab">
      <header className="dl-lab__hero">
        <div>
          <p className="dl-lab__eyebrow">Design lab · Flow polish</p>
          <h1>Keep Current — pick the polish</h1>
          <p>
            Same layout as live Flow (KPIs + hot tables + mix). Each card only changes motion,
            ribbons, focus, or card finish — techniques people use in ApexSankey, RoutePulse, and
            modern KPI dashboards.
          </p>
        </div>
        <div className="dl-lab__pick">
          {picked ? (
            <>
              <span className="dl-lab__pick-label">Your pick</span>
              <strong>{POLISHES.find((p) => p.id === picked)?.name}</strong>
              <span className="dl-lab__pick-hint">Saved in this browser</span>
            </>
          ) : (
            <span className="dl-lab__pick-hint">Click “Choose this” on a pack</span>
          )}
        </div>
      </header>

      <div className="dl-lab__stage">
        <PolishPreview id={focus} />
        <aside>
          <h2>{active.name}</h2>
          <p className="dl-lab__vibe">{active.vibe}</p>
          <p>{active.why}</p>
          <p className="dl-lab__src">
            <span>Inspired by</span> {active.inspiredBy}
          </p>
          <ul className="dl-lab__sources">
            {active.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <button type="button" className="dl-lab__cta" onClick={() => choose(focus)}>
            {picked === focus ? 'Selected ✓' : 'Choose this'}
          </button>
        </aside>
      </div>

      <div className="dl-lab__grid">
        {POLISHES.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`dl-card ${focus === p.id ? 'is-focus' : ''} ${picked === p.id ? 'is-picked' : ''}`}
            onClick={() => setFocus(p.id)}
          >
            <div className="dl-card__mini">
              <PolishPreview id={p.id} />
            </div>
            <div className="dl-card__meta">
              <strong>{p.name}</strong>
              <span>{p.vibe}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
