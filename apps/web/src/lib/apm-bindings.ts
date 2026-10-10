import { query } from './db';

export type ApmEbpfBinding = {
  service: string;
  host: string;
  port: number;
  enabledAt: string;
};

type Stored = { bindings?: ApmEbpfBinding[] };

const SETTINGS_KEY = 'apm_ebpf';

export async function listApmEbpfBindings(): Promise<ApmEbpfBinding[]> {
  const rows = await query<{ value: Stored }>(
    `select value from buho.settings where key = $1`,
    [SETTINGS_KEY],
  );
  const value = rows[0]?.value;
  if (!value || !Array.isArray(value.bindings)) return [];
  return value.bindings.filter(
    (b) =>
      b &&
      typeof b.service === 'string' &&
      typeof b.host === 'string' &&
      Number.isFinite(Number(b.port)),
  );
}

export async function upsertApmEbpfBinding(binding: {
  service: string;
  host: string;
  port: number;
}): Promise<ApmEbpfBinding[]> {
  const service = binding.service.trim();
  const host = binding.host.trim();
  const port = Number(binding.port);
  if (!service || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('valid service, host, and port required');
  }

  const current = await listApmEbpfBindings();
  const next: ApmEbpfBinding[] = [
    ...current.filter((b) => b.service !== service && !(b.host === host && b.port === port)),
    { service, host, port, enabledAt: new Date().toISOString() },
  ];

  await query(
    `insert into buho.settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
       set value = excluded.value,
           updated_at = now(),
           updated_by = excluded.updated_by`,
    [SETTINGS_KEY, JSON.stringify({ bindings: next }), 'apm-ebpf'],
  );
  return next;
}

export async function removeApmEbpfBinding(opts: {
  service?: string;
  host?: string;
  port?: number;
}): Promise<ApmEbpfBinding[]> {
  const current = await listApmEbpfBindings();
  const next = current.filter((b) => {
    if (opts.service && b.service === opts.service) return false;
    if (opts.host && opts.port != null && b.host === opts.host && b.port === Number(opts.port)) {
      return false;
    }
    return true;
  });
  await query(
    `insert into buho.settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
       set value = excluded.value,
           updated_at = now(),
           updated_by = excluded.updated_by`,
    [SETTINGS_KEY, JSON.stringify({ bindings: next }), 'apm-ebpf'],
  );
  return next;
}
