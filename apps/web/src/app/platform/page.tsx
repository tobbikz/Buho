import { redirect } from 'next/navigation';

/** Deep Platform hub — send operators to the Kafka overview by default. */
export default function PlatformIndexPage() {
  redirect('/platform/kafka');
}
