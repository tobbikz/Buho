import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { InventoryInstance } from '@/components/InventoryInstance';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo } from '@/lib/format';
import { ENGINE_LABEL, getInstanceEngine, getInstanceInventory } from '@/lib/estate';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Inventario de una instancia: versión, configuración, disco, replicación,
 * respaldos, jobs y licencia.
 *
 * Tiene pantalla propia desde que MariaDB y SQL Server dejaron de entrar sólo
 * por inventario: antes era *la* vista de esas instancias, y ahora es una
 * pestaña más al lado de las métricas.
 */
export default async function InstanceInventoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  let instance;
  let engine;
  let inventory;
  try {
    [instance, engine] = await Promise.all([getInstance(instanceId), getInstanceEngine(instanceId)]);
    if (!instance) notFound();
    inventory = await getInstanceInventory(instanceId);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const motor = engine ?? 'postgres';

  return (
    <>
      <Topbar
        crumbs={[{ label: 'Flota', href: '/' }, { label: instance.alias, href: `/instances/${instanceId}` }, { label: 'Inventario' }]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Inventario</h1>
            <p className="page-sub">
              {instance.host}:{instance.port} · {ENGINE_LABEL[motor] ?? motor}
              {inventory.engine?.capturedAt ? ` · leído ${formatAgo(inventory.engine.capturedAt)}` : ''}
            </p>
          </div>
          <span className="tag tag--info">{ENGINE_LABEL[motor] ?? motor}</span>
        </header>
        <InstanceTabs instanceId={instanceId} engine={motor} />
        <InventoryInstance instanceId={instanceId} alias={instance.alias} engine={motor} inventory={inventory} />
      </div>
    </>
  );
}
