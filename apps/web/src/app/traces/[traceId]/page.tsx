import { redirect } from 'next/navigation';

export default async function TraceIdRedirect({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  redirect(`/observability/apm/${traceId}`);
}
