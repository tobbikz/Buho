import Link from 'next/link';

/**
 * Global 404 — works for both spaces. Prefer ObsEmpty on known Observability
 * routes (trace / service missing) so copy stays domain-accurate.
 */
export default function NotFound() {
  return (
    <div className="page">
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Not found</span>
        </div>
        <div className="panel-body text-[12px] space-y-2">
          <p className="m-0">That page or resource does not exist.</p>
          <p className="m-0 flex flex-wrap gap-3">
            <Link href="/observability/services" className="text-accent hover:underline">
              Services
            </Link>
            <Link href="/observability/apm/traces" className="text-accent hover:underline">
              Traces
            </Link>
            <Link href="/" className="text-accent hover:underline">
              Databases
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
