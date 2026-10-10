import { notFound, redirect } from 'next/navigation';
import { StoreError } from '@/components/StoreError';
import { servicePath } from '@/lib/obs-service';
import { getInstance } from '@/lib/queries';
import { getInstanceEngine } from '@/lib/estate';

export const dynamic = 'force-dynamic';

/** Legacy monitor URL → unified Service page (Probes tab). */
export default async function ObservabilityMonitorRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { id } = await params;
  const { w } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isFinite(instanceId)) notFound();

  let instance;
  let engine;
  try {
    [instance, engine] = await Promise.all([
      getInstance(instanceId),
      getInstanceEngine(instanceId),
    ]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }
  if (!instance || engine !== 'endpoint') notFound();

  const extra = w ? { w } : undefined;
  redirect(servicePath(instance.alias, 'uptime', extra));
}
