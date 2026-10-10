'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type NeedApm = {
  name: string;
  href: string;
  hasUptime: boolean;
  probeTarget: string | null;
};

type ApmBinding = {
  service: string;
  host: string;
  port: number;
  enabledAt: string;
};

type EbpfStatus = {
  running?: boolean;
  host?: string;
  port?: string;
  service?: string;
  state?: string;
  otlp?: string;
  error?: string;
  bindings?: ApmBinding[];
};

type EbpfEnableResponse = {
  ok?: boolean;
  mode?: 'local' | 'remote';
  error?: string;
  command?: string;
  running?: boolean;
  host?: string;
  port?: string;
  service?: string;
  bindings?: ApmBinding[];
};

function hostFromTarget(target: string): string {
  const t = target.trim();
  if (t.startsWith('[')) {
    const m = /^\[([^\]]+)\]/.exec(t);
    return m?.[1] ?? t;
  }
  const idx = t.lastIndexOf(':');
  return idx > 0 ? t.slice(0, idx) : t;
}

/** Agent can only auto-start on this machine's loopback. */
function isLocalEbpfHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === 'host.docker.internal'
  );
}

/** Default OTEL service name from host (orders.lab → orders). Never invent from IP octets. */
function suggestServiceName(target: string): string {
  const host = hostFromTarget(target).trim().toLowerCase();
  if (!host) return 'service';
  // IPv4 / IPv6 → generic name (127.0.0.1 must not become "127").
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'app';
  const base = host.split('.')[0] || host;
  if (!base || /^\d+$/.test(base)) return 'app';
  const cleaned = base.replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 64) || 'service';
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="apm-setup__copy">
      <div className="apm-setup__copy-head">
        <span className="apm-setup__copy-label">{label}</span>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="apm-setup__code">{value}</pre>
    </div>
  );
}

export function ApmSetup({
  otlpPath,
  collectorEndpoint,
  remoteOtlpEndpoint,
  directEndpoint,
  withTraces,
  needApm,
  initialBindings = [],
  tokenConfigured = false,
  logsEndpoint,
}: {
  otlpPath: string;
  collectorEndpoint: string;
  /** OTLP URL reachable from remote hosts (LAN IP · not 127.0.0.1). */
  remoteOtlpEndpoint: string;
  directEndpoint: string;
  withTraces: number;
  needApm: NeedApm[];
  initialBindings?: ApmBinding[];
  /** True when BUHO_OTLP_TOKEN is set on the console process. */
  tokenConfigured?: boolean;
  /** Optional OTLP logs endpoint (http/json). */
  logsEndpoint?: string;
}) {
  const [health, setHealth] = useState<'idle' | 'ok' | 'down'>('idle');
  const [healthDetail, setHealthDetail] = useState('');
  const [target, setTarget] = useState('127.0.0.1:8080');
  const [serviceName, setServiceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<EbpfStatus | null>(null);
  const [bindings, setBindings] = useState<ApmBinding[]>(initialBindings);
  const [result, setResult] = useState<EbpfEnableResponse | null>(null);
  const [msg, setMsg] = useState('');
  const [hostFlash, setHostFlash] = useState(false);
  const [showSsh, setShowSsh] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('root');
  const [sshPort, setSshPort] = useState('22');
  const [sshIdentity, setSshIdentity] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [otlpRemote, setOtlpRemote] = useState(remoteOtlpEndpoint);
  const hostInputRef = useRef<HTMLInputElement>(null);
  const zeroRef = useRef<HTMLElement | null>(null);

  const boundNames = useMemo(() => new Set(bindings.map((b) => b.service)), [bindings]);

  const waiting = useMemo(
    () => needApm.filter((s) => !boundNames.has(s.name)),
    [needApm, boundNames],
  );

  const instrumented = useMemo(() => {
    const fromNeed = needApm.filter((s) => boundNames.has(s.name));
    const fromBindings = bindings
      .filter((b) => !fromNeed.some((s) => s.name === b.service))
      .map(
        (b): NeedApm => ({
          name: b.service,
          href: `/observability/services/${encodeURIComponent(b.service)}`,
          hasUptime: false,
          probeTarget: `${b.host}:${b.port}`,
        }),
      );
    return [...fromNeed, ...fromBindings];
  }, [needApm, bindings, boundNames]);

  const check = useCallback(async () => {
    try {
      const res = await fetch(otlpPath, { method: 'GET', cache: 'no-store' });
      const data = (await res.json()) as { ok?: boolean; protocol?: string };
      if (res.ok && data.ok) {
        setHealth('ok');
        setHealthDetail(data.protocol ?? 'otlp/http+json');
      } else {
        setHealth('down');
        setHealthDetail(`HTTP ${res.status}`);
      }
    } catch (err) {
      setHealth('down');
      setHealthDetail(err instanceof Error ? err.message : String(err));
    }
  }, [otlpPath]);

  const refresh = useCallback(async (opts?: { syncForm?: boolean }) => {
    try {
      const res = await fetch('/api/observability/apm/ebpf', { cache: 'no-store' });
      const data = (await res.json()) as EbpfStatus;
      setStatus(data);
      if (Array.isArray(data.bindings)) setBindings(data.bindings);
      // Never overwrite Host while the user is configuring another service
      // (Refresh used to snap back to the running agent IP — confusing).
      if (opts?.syncForm && data.running && data.host && data.port) {
        setTarget(`${data.host}:${data.port}`);
        if (data.service) setServiceName(data.service);
      }
    } catch {
      setStatus({ running: false });
    }
  }, []);

  useEffect(() => {
    void check();
    // Status/bindings only — do not overwrite Host/service the user is editing.
    void refresh();
  }, [check, refresh]);

  const deploySsh = useCallback(
    async (opts?: { target?: string; service?: string }) => {
      const nextTarget = (opts?.target ?? target).trim();
      const nextService =
        (opts?.service ?? serviceName).trim() || suggestServiceName(nextTarget);
      if (opts?.target) setTarget(nextTarget);
      if (nextService) setServiceName(nextService);

      setBusy(true);
      setMsg('');
      try {
        const res = await fetch('/api/observability/apm/ebpf/ssh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: nextTarget,
            service: nextService,
            sshHost: sshHost.trim() || hostFromTarget(nextTarget),
            sshUser: sshUser.trim(),
            sshPort: Number(sshPort) || 22,
            identityFile: sshIdentity.trim() || undefined,
            password: sshPassword || undefined,
            otlpEndpoint: otlpRemote.trim(),
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          detail?: string;
          bindings?: ApmBinding[];
        };
        if (Array.isArray(data.bindings)) setBindings(data.bindings);
        if (data.ok) {
          setMsg(`APM on · ${nextService} · no app code · hit the app → Open Traces`);
          setSshPassword('');
          setResult(null);
        } else {
          setMsg(data.error || 'SSH deploy failed');
        }
        await refresh();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [target, serviceName, sshHost, sshUser, sshPort, sshIdentity, sshPassword, otlpRemote, refresh],
  );

  /** One Enable: local eBPF here, or SSH deploy on remote — never asks for app SDK. */
  const enable = useCallback(
    async (opts?: { target?: string; service?: string }) => {
      const nextTarget = (opts?.target ?? target).trim();
      const nextService =
        (opts?.service ?? serviceName).trim() || suggestServiceName(nextTarget);
      if (opts?.target) setTarget(nextTarget);
      if (nextService) setServiceName(nextService);

      const host = hostFromTarget(nextTarget);
      if (!isLocalEbpfHost(host)) {
        setShowSsh(true);
        if (!sshHost.trim()) setSshHost(host);
        const canSsh = Boolean(sshUser.trim() && (sshIdentity.trim() || sshPassword));
        if (!canSsh) {
          setMsg(
            'Remote host · enter SSH once (password or key path on this Buho box). No code on the app.',
          );
          return;
        }
        await deploySsh({ target: nextTarget, service: nextService });
        return;
      }

      setBusy(true);
      setMsg('');
      setResult(null);
      try {
        const res = await fetch('/api/observability/apm/ebpf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: nextTarget,
            service: nextService,
            otlpEndpoint: collectorEndpoint,
          }),
        });
        const data = (await res.json()) as EbpfEnableResponse;
        setResult(data);
        if (Array.isArray(data.bindings)) setBindings(data.bindings);
        if (data.mode === 'remote') {
          // API still classified as remote (e.g. Docker edge cases)
          setShowSsh(true);
          setSshHost(hostFromTarget(nextTarget));
          setMsg(
            'Remote host · enter SSH once (password or key). No code on the app.',
          );
        } else if (data.ok) {
          setMsg(`APM on for ${nextService} · no app code · hit the service → Open Traces`);
        } else {
          setMsg(data.error || 'Failed');
        }
        await refresh();
      } catch (err) {
        setMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [
      target,
      serviceName,
      collectorEndpoint,
      refresh,
      sshHost,
      sshUser,
      sshIdentity,
      sshPassword,
      deploySsh,
    ],
  );

  const addApmFor = useCallback(
    (s: NeedApm) => {
      const nextTarget = (s.probeTarget || target).trim();
      const host = hostFromTarget(nextTarget);
      setTarget(nextTarget);
      setServiceName(s.name);
      setHostFlash(true);
      setResult(null);
      setSshHost(host);
      zeroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => {
        hostInputRef.current?.focus();
        hostInputRef.current?.select();
      }, 80);
      window.setTimeout(() => setHostFlash(false), 1600);

      if (!isLocalEbpfHost(host)) {
        setShowSsh(true);
        const canSsh = Boolean(sshUser.trim() && (sshIdentity.trim() || sshPassword));
        if (canSsh) {
          void enable({ target: nextTarget, service: s.name });
          return;
        }
        setMsg(
          `${s.name} · remote · fill SSH below and Enable APM (no app code).`,
        );
        return;
      }
      setShowSsh(false);
      void enable({ target: nextTarget, service: s.name });
    },
    [target, enable, sshUser, sshIdentity, sshPassword],
  );

  const stop = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/observability/apm/ebpf', { method: 'DELETE' });
      const data = (await res.json()) as { bindings?: ApmBinding[] };
      if (Array.isArray(data.bindings)) setBindings(data.bindings);
      setResult(null);
      setServiceName('');
      setMsg('Agent stopped · APM binding cleared for that host');
      await refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const running = Boolean(status?.running);
  const targetHost = hostFromTarget(target);
  const remoteHost = Boolean(target.trim()) && !isLocalEbpfHost(targetHost);
  const sshReady = Boolean(sshUser.trim() && (sshIdentity.trim() || sshPassword));
  const showRemoteSsh = remoteHost || showSsh || result?.mode === 'remote';
  const tracesService =
    (serviceName.trim() && boundNames.has(serviceName.trim()) && serviceName.trim()) ||
    (status?.service && status.service.trim()) ||
    '';
  const tracesHref = tracesService
    ? `/observability/apm/traces?service=${encodeURIComponent(tracesService)}`
    : '/observability/apm/traces';
  const resolvedService = serviceName.trim() || suggestServiceName(target);

  const authHeaderLine = tokenConfigured
    ? `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer $<BUHO_OTLP_TOKEN>`
    : `# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>  # required off-loopback`;

  const collectorEnv = [
    `OTEL_SERVICE_NAME=${resolvedService}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${collectorEndpoint}`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
    authHeaderLine,
  ].join('\n');

  const directEnv = [
    `OTEL_SERVICE_NAME=${resolvedService}`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
    `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${directEndpoint}`,
    ...(logsEndpoint
      ? [`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${logsEndpoint}`]
      : []),
    authHeaderLine,
  ].join('\n');

  return (
    <div className="apm-setup">
      <p className="mb-3 text-[12px] text-foreground-secondary">
        Direct ingest is <span className="font-mono">http/json</span> only. Loopback stays open for lab
        emit; <strong>off-loopback fail-closed</strong> — set <span className="font-mono">BUHO_OTLP_TOKEN</span>{' '}
        and send <span className="font-mono">Authorization: Bearer …</span> (or{' '}
        <span className="font-mono">X-Buho-Otlp-Token</span>). Protobuf needs{' '}
        <span className="font-mono">deploy/otel-collector</span>. See{' '}
        <span className="font-mono">GO_LIVE.md</span> §6.
      </p>
      <div className="notice mb-3">
        <strong>OTLP token:</strong>{' '}
        {tokenConfigured ? (
          <>
            configured on this console · copy fields below include{' '}
            <span className="font-mono">OTEL_EXPORTER_OTLP_HEADERS</span> (substitute the real token;
            never paste secrets into git).
          </>
        ) : (
          <>
            not set · loopback smoke works without it; before exposing OTLP off-loopback set{' '}
            <span className="font-mono">BUHO_OTLP_TOKEN</span> or POSTs return 503.
          </>
        )}
      </div>

      <div className="stat-grid obs-services-kpis">
        <div className="stat">
          <div className="stat__label">OTLP ingest</div>
          <div className="stat__value">
            {health === 'idle' ? '…' : health === 'ok' ? 'Ready' : 'Down'}
          </div>
          <div className="stat__hint font-mono">{healthDetail || otlpPath}</div>
        </div>
        <div className="stat">
          <div className="stat__label">Services with traces</div>
          <div className="stat__value">{withTraces}</div>
          <div className="stat__hint">OTLP · last hour</div>
        </div>
        <div className="stat">
          <div className="stat__label">Need APM</div>
          <div className="stat__value">{waiting.length}</div>
          <div className="stat__hint">probe only · no binding</div>
        </div>
        <div className="stat">
          <div className="stat__label">Check</div>
          <div className="stat__value" style={{ fontSize: '1rem' }}>
            <button type="button" className="btn" onClick={() => void check()}>
              Re-check
            </button>
          </div>
          <div className="stat__hint">GET {otlpPath}</div>
        </div>
      </div>

      <section className="panel apm-setup__ebpf" ref={zeroRef}>
        <div className="panel-header">
          <span className="panel-title">Zero-code</span>
          <span className="muted text-xs">no SDK · eBPF on the app host</span>
        </div>
        <div className="panel-body space-y-3">
          <form
            className="apm-setup__ebpf-form"
            onSubmit={(e) => {
              e.preventDefault();
              void enable();
            }}
          >
            <label className="apm-setup__ebpf-field">
              <span className="apm-setup__copy-label">Host · IP:port</span>
              <input
                ref={hostInputRef}
                className={`apm-setup__ebpf-input${hostFlash ? ' apm-setup__ebpf-input--flash' : ''}`}
                value={target}
                onChange={(e) => {
                  const v = e.target.value;
                  setTarget(v);
                  const h = hostFromTarget(v);
                  if (h && !isLocalEbpfHost(h)) {
                    setShowSsh(true);
                    setSshHost((prev) => prev.trim() || h);
                  }
                }}
                placeholder="192.168.1.10:8080"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <label className="apm-setup__ebpf-field">
              <span className="apm-setup__copy-label">Service name</span>
              <input
                className="apm-setup__ebpf-input"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder={suggestServiceName(target)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !target.trim() || (remoteHost && !sshReady)}
              title={
                remoteHost && !sshReady
                  ? 'Remote host — fill SSH password or key below'
                  : 'Enable APM without changing app code'
              }
            >
              {busy ? '…' : 'Enable APM'}
            </button>
            {running ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void stop()}>
                Stop
              </button>
            ) : null}
          </form>

          <div className="apm-setup__ebpf-meta">
            {running ? (
              <span className="tag tag--ok">
                agent · {status?.host}:{status?.port}
                {status?.service ? ` · ${status.service}` : serviceName ? ` · ${serviceName}` : ''}
              </span>
            ) : remoteHost ? (
              <span className="tag tag--muted">remote · SSH once</span>
            ) : (
              <span className="tag tag--muted">agent off</span>
            )}
            <span className="muted text-xs font-mono">
              OTLP → {remoteHost ? otlpRemote || collectorEndpoint : collectorEndpoint}
            </span>
          </div>

          {msg ? <p className="apm-setup__ebpf-msg m-0">{msg}</p> : null}

          {showRemoteSsh ? (
            <div className="apm-setup__ssh">
              <div className="apm-setup__copy-label">Remote · SSH once (still no app code)</div>
              <div className="apm-setup__ssh-grid">
                <label className="apm-setup__ebpf-field">
                  <span className="apm-setup__copy-label">SSH host</span>
                  <input
                    className="apm-setup__ssh-input"
                    value={sshHost}
                    onChange={(e) => {
                      const h = e.target.value;
                      setSshHost(h);
                      // Same box as Buho: collector often binds 127.0.0.1 only.
                      if (isLocalEbpfHost(h.trim())) {
                        setOtlpRemote('http://127.0.0.1:4318');
                      }
                    }}
                    placeholder="192.168.1.20"
                    disabled={busy}
                    autoComplete="off"
                  />
                </label>
                <label className="apm-setup__ebpf-field">
                  <span className="apm-setup__copy-label">User</span>
                  <input
                    className="apm-setup__ssh-input"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root"
                    disabled={busy}
                    autoComplete="username"
                  />
                </label>
                <label className="apm-setup__ebpf-field">
                  <span className="apm-setup__copy-label">SSH port</span>
                  <input
                    className="apm-setup__ssh-input"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    placeholder="22"
                    disabled={busy}
                  />
                </label>
                <label className="apm-setup__ebpf-field">
                  <span className="apm-setup__copy-label">SSH password</span>
                  <input
                    className="apm-setup__ssh-input"
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder="not saved"
                    disabled={busy}
                    autoComplete="new-password"
                  />
                </label>
                <label className="apm-setup__ebpf-field">
                  <span className="apm-setup__copy-label">Or private key path</span>
                  <input
                    className="apm-setup__ssh-input"
                    value={sshIdentity}
                    onChange={(e) => setSshIdentity(e.target.value)}
                    placeholder="/home/you/.ssh/id_ed25519"
                    disabled={busy}
                    autoComplete="off"
                  />
                </label>
                <label className="apm-setup__ebpf-field" style={{ gridColumn: '1 / -1' }}>
                  <span className="apm-setup__copy-label">OTLP from remote → Buho</span>
                  <input
                    className="apm-setup__ssh-input"
                    value={otlpRemote}
                    onChange={(e) => setOtlpRemote(e.target.value)}
                    placeholder="http://192.168.x.x:4318"
                    disabled={busy}
                    autoComplete="off"
                  />
                </label>
              </div>
              <p className="apm-setup__ebpf-msg m-0">
                Password is not saved. Enable APM starts Beyla on that host over SSH — your app stays untouched.
              </p>
            </div>
          ) : null}

          {result?.mode === 'remote' && result.command ? (
            <details className="apm-setup__advanced">
              <summary>Manual docker (optional)</summary>
              <div style={{ marginTop: '0.55rem' }}>
                <CopyField label="Run on the app host" value={result.command} />
              </div>
            </details>
          ) : null}

          <div className="apm-setup__lab-actions">
            <Link className="btn btn--primary" href={tracesHref}>
              Open Traces
            </Link>
            <button
              type="button"
              className="btn"
              onClick={() => void refresh()}
              disabled={busy}
              title="Refresh agent status · does not change Host"
            >
              Refresh
            </button>
          </div>
        </div>
      </section>

      {instrumented.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">APM on</span>
            <span className="muted text-xs">saved · zero-code binding</span>
          </div>
          <div className="panel-body p-0">
            {instrumented.map((s) => {
              const b = bindings.find((x) => x.service === s.name);
              const tgt = s.probeTarget || (b ? `${b.host}:${b.port}` : null);
              return (
                <div key={s.name} className="discover-hit apm-setup__need-row">
                  <div
                    className="discover-hit__bar"
                    aria-hidden
                    style={{ background: 'var(--success, #16a34a)' }}
                  />
                  <div className="discover-hit__body apm-setup__need-body">
                    <div className="discover-hit__meta" style={{ gap: '0.5rem' }}>
                      <span className="font-mono text-[12px] font-medium">{s.name}</span>
                      <span className="tag tag--ok">APM on</span>
                      {tgt ? <span className="muted text-xs font-mono">{tgt}</span> : null}
                    </div>
                    <div className="apm-setup__need-actions">
                      <Link
                        className="btn btn--primary"
                        href={`/observability/apm/traces?service=${encodeURIComponent(s.name)}`}
                      >
                        Open Traces
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <details className="apm-setup__advanced">
        <summary>SDK / env (optional)</summary>
        <div className="apm-setup__grid" style={{ marginTop: '0.75rem' }}>
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Via OTel Collector</span>
              <span className="muted text-xs">recommended · :4318 protobuf</span>
            </div>
            <div className="panel-body space-y-3">
              <CopyField label="App env" value={collectorEnv} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Direct to Búho</span>
              <span className="muted text-xs">http/json · no collector</span>
            </div>
            <div className="panel-body space-y-3">
              <CopyField label="App env" value={directEnv} />
            </div>
          </section>
        </div>

        <section className="panel" style={{ marginTop: '0.85rem' }}>
          <div className="panel-header">
            <span className="panel-title">Lab</span>
            <span className="muted text-xs">SDK emit</span>
          </div>
          <div className="panel-body apm-setup__lab">
            <CopyField label="Demo emit" value="npm run otel:emit" />
            <CopyField label="Smoke ingest" value="npm run smoke:otlp" />
          </div>
        </section>
      </details>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Need APM</span>
          <span className="muted text-xs">have a probe · missing binding</span>
        </div>
        <div className="panel-body p-0">
          {waiting.length === 0 ? (
            <div className="empty">No probe-only services waiting for APM.</div>
          ) : (
            waiting.map((s) => (
              <div key={s.name} className="discover-hit apm-setup__need-row">
                <div className="discover-hit__bar" aria-hidden style={{ background: 'var(--warning)' }} />
                <div className="discover-hit__body apm-setup__need-body">
                  <div className="discover-hit__meta" style={{ gap: '0.5rem' }}>
                    <Link
                      href={s.href}
                      className="font-mono text-[12px] font-medium"
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {s.name}
                    </Link>
                    <span className="tag tag--warn">needs APM</span>
                    {s.hasUptime ? <span className="tag tag--muted">has probe</span> : null}
                    {s.probeTarget ? (
                      <span className="muted text-xs font-mono">{s.probeTarget}</span>
                    ) : null}
                  </div>
                  <div className="apm-setup__need-actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy || !s.probeTarget}
                      onClick={() => addApmFor(s)}
                    >
                      Add APM
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
