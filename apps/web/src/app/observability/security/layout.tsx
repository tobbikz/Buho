import type { ReactNode } from 'react';
import { SecurityLabBanner } from '@/components/SecurityLabBanner';

/** Shared honesty banner — Kibana-shaped Security rail is DB audit lab, not SIEM. */
export default function ObservabilitySecurityLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="obs-page" style={{ paddingBottom: 0 }}>
        <SecurityLabBanner />
      </div>
      {children}
    </>
  );
}
