import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Observability lands on Services (unified fleet). */
export default function ObservabilityIndexPage() {
  redirect('/observability/services');
}
