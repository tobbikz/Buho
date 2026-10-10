import { redirect } from 'next/navigation';

export default function EndpointsRedirect() {
  redirect('/observability/synthetics');
}
