import { redirect } from 'next/navigation';

/** Hosts removed from Observability — focus is APM services + Probes. */
export default function ObservabilityHostsRedirect() {
  redirect('/observability/inventory');
}
