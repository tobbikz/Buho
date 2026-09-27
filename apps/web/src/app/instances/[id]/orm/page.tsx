import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Old ORM URL. Catalog is one page: structure (default) and traffic (`vista=trafico`). */
export default async function OrmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ peso?: string; v?: string; capa?: string; schema?: string }>;
}) {
  const { id } = await params;
  const { peso, v, capa, schema } = await searchParams;
  const query = new URLSearchParams({ vista: 'trafico' });
  if (peso) query.set('peso', peso);
  if (v) query.set('v', v);
  if (capa) query.set('capa', capa);
  if (schema) query.set('schema', schema);
  redirect(`/instances/${id}/topology?${query.toString()}`);
}
