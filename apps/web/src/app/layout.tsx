import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import { Sidebar } from '@/components/Sidebar';
import { authConfigured } from '@/lib/auth';
import { defaultGroupKey, groupInstances } from '@/lib/grouping';
import { listInstances } from '@/lib/queries';
import { currentSession } from '@/lib/session';
import './globals.css';

const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Búho — Monitor de bases de datos',
  description: 'Monitor on-prem de PostgreSQL con diagnóstico accionable',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-buho-path') ?? '/';

  // El login se dibuja solo: sin sidebar (no hay nada que navegar sin sesión) y
  // sin consultar el store.
  if (path === '/login') {
    return (
      <html lang="es">
        <body className={`${plex.variable} ${jetbrains.variable} antialiased`}>{children}</body>
      </html>
    );
  }

  // Si el store no responde, la navegación se degrada pero la app sigue
  // renderizando el error de la página en vez de tirar un 500 completo.
  const instances = await listInstances().catch(() => []);
  const session = await currentSession();

  // La barra lateral agrupa por la misma dimensión que la flota, para que la
  // navegación y la tabla no cuenten historias distintas del mismo parque.
  const groupKey = defaultGroupKey(instances);
  const grouped = groupInstances(instances, groupKey);

  return (
    <html lang="es">
      <body className={`${plex.variable} ${jetbrains.variable} antialiased`}>
        {!authConfigured() ? (
          <div className="auth-warning">
            Consola sin autenticación · definir <span className="font-mono">BUHO_AUTH_SECRET</span> antes de exponerla
          </div>
        ) : null}
        <div className="app-shell">
          <div className="sidebar-col">
            <Sidebar
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
            />
          </div>
          <main className="min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
