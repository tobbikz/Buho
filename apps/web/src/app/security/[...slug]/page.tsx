import { redirect } from 'next/navigation';

const KEEP = new Set([
  'dashboards',
  'rules',
  'alerts',
  'findings',
  'cases',
  'explore',
]);

/** Map old /security/* URLs into Observability → Security. */
export default async function LegacySecurityCatchAll({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const head = slug[0] ?? 'findings';
  if (KEEP.has(head)) {
    redirect(`/observability/security/${slug.join('/')}`);
  }
  redirect('/observability/security/findings');
}
