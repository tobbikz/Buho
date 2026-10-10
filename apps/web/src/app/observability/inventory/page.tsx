import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Legacy Inventory URL → Services fleet. */
export default async function ObservabilityInventoryRedirect({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  if (sp.kind) q.set('kind', sp.kind);
  const qs = q.toString();
  redirect(`/observability/services${qs ? `?${qs}` : ''}`);
}
