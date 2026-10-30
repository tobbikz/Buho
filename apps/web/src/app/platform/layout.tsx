import { Topbar } from '@/components/Topbar';

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Platform' }]} />
      <div className="page platform-page">{children}</div>
    </>
  );
}
