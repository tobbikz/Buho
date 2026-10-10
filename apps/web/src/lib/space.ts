/** Product spaces: Databases · Observability (includes Security subset). */

export type BuhoSpace = 'databases' | 'observability';

export function spaceFromPath(path: string): BuhoSpace {
  if (
    path === '/observability' ||
    path.startsWith('/observability/') ||
    path === '/endpoints' ||
    path.startsWith('/endpoints/') ||
    path === '/traces' ||
    path.startsWith('/traces/') ||
    path === '/security' ||
    path.startsWith('/security/')
  ) {
    return 'observability';
  }
  return 'databases';
}

export function isEndpointEngine(engine: string | null | undefined): boolean {
  return engine === 'endpoint';
}
