import { redirect } from 'next/navigation';

export default function TracesRedirect() {
  redirect('/observability/apm');
}
