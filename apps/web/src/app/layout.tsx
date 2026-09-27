import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import localFont from 'next/font/local';
import { ShellChrome } from '@/components/ShellChrome';
import { authConfigured } from '@/lib/auth';
import { defaultGroupKey, groupInstances } from '@/lib/grouping';
import { listInstances } from '@/lib/queries';
import { currentSession } from '@/lib/session';
import './globals.css';

// Vendored so `next build` does not fetch fonts.google.com. Turbopack fails that
// download with "next/font/google queries have exactly one entry".
const plex = localFont({
  src: [
    { path: '../fonts/IBMPlexSans-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/IBMPlexSans-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/IBMPlexSans-SemiBold.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex',
  display: 'swap',
});

const jetbrains = localFont({
  src: '../fonts/JetBrainsMono-Regular.woff2',
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Búho — Database monitor',
  description: 'On-prem PostgreSQL monitor with actionable diagnostics',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-buho-path') ?? '/';

  if (path === '/login') {
    return (
      <html lang="en">
        <body className={`${plex.variable} ${jetbrains.variable} antialiased`}>{children}</body>
      </html>
    );
  }

  const instances = await listInstances().catch(() => []);
  const session = await currentSession();
  const groupKey = defaultGroupKey(instances);
  const grouped = groupInstances(instances, groupKey);

  return (
    <html lang="en">
      <body className={`${plex.variable} ${jetbrains.variable} antialiased`}>
        {!authConfigured() ? (
          <div className="auth-warning">
            Console without authentication · set <span className="font-mono">BUHO_AUTH_SECRET</span> before exposing
            it
          </div>
        ) : null}
        <ShellChrome
          authEnabled={authConfigured()}
          isAdmin={session.role === 'admin'}
          username={authConfigured() ? session.username : undefined}
          instances={grouped.flatMap((group) =>
            group.instances.map((instance) => ({
              instanceId: instance.instanceId,
              alias: instance.alias,
              score: instance.score,
              critical: instance.critical,
              group: group.value,
            })),
          )}
        >
          {children}
        </ShellChrome>
      </body>
    </html>
  );
}
