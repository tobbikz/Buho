import Link from 'next/link';
import { FlowDesignCanvas } from '@/components/FlowDesignCanvas';
import { Topbar } from '@/components/Topbar';

export const dynamic = 'force-dynamic';

export default function FlowDesignLabPage() {
  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: 'Design lab' },
          { label: 'Flow' },
        ]}
      />
      <div className="page page--wide">
        <p className="dl-lab__nav">
          <Link href="/" className="tag tag--muted">
            ← back to fleet
          </Link>
        </p>
        <FlowDesignCanvas />
      </div>
    </>
  );
}
