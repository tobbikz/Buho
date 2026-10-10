import { redirect } from 'next/navigation';
import { servicePath } from '@/lib/obs-service';

export const dynamic = 'force-dynamic';

/** Legacy APM Services list → unified Services (or one service Traces tab). */
export default async function ObservabilityApmServicesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; service?: string; w?: string }>;
}) {
  const sp = await searchParams;
  if (sp.tab === 'traces') {
    const q = new URLSearchParams();
    if (sp.w) q.set('w', sp.w);
    if (sp.service) q.set('service', sp.service);
    const qs = q.toString();
    redirect(`/observability/apm/traces${qs ? `?${qs}` : ''}`);
  }
  if (sp.service?.trim()) {
    redirect(servicePath(sp.service.trim(), 'traces'));
  }
  redirect('/observability/services?kind=apm');
}
