import { redirect } from 'next/navigation';

/** Legacy URL — Admin chrome now says Targets. */
export default function AdminInstancesRedirectPage() {
  redirect('/admin/targets');
}
