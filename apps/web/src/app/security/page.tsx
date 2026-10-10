import { redirect } from 'next/navigation';

/** Legacy entry — Security lives under Observability. */
export default function SecurityRedirect() {
  redirect('/observability/security/findings');
}
