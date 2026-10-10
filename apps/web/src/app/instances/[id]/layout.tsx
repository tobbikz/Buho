import type { Metadata } from 'next';
import { ENGINE_LABEL } from '@/lib/grouping';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) {
    return { title: 'Instance · Búho' };
  }
  try {
    const instance = await getInstance(id);
    if (!instance) return { title: 'Instance · Búho' };
    const engine = ENGINE_LABEL[instance.engine] ?? instance.engine;
    return { title: `${instance.alias} · ${engine} · Búho` };
  } catch {
    return { title: 'Instance · Búho' };
  }
}

export default function InstanceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
