import { query } from '@/lib/db';

/**
 * Resolve "who owns this query" for Blame.
 *
 * Instance tags (optional, highest priority):
 *   owner.user.<username> = Team / person
 *   owner.app.<application_name> = Team / service
 *   owner.default = fallback team
 *
 * Otherwise: prefer application_name from query_actors, then DB username.
 */
export interface QueryOwner {
  label: string;
  source: 'tag' | 'application' | 'username' | 'unknown';
  application: string | null;
  username: string | null;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

export function resolveOwnerFromTags(
  tags: Record<string, string>,
  opts: { application?: string | null; username?: string | null },
): QueryOwner | null {
  const app = opts.application?.trim() || null;
  const user = opts.username?.trim() || null;

  if (app) {
    const tagged = tags[`owner.app.${normalizeKey(app)}`] ?? tags[`owner.app.${app}`];
    if (tagged) {
      return { label: tagged, source: 'tag', application: app, username: user };
    }
  }
  if (user) {
    const tagged = tags[`owner.user.${normalizeKey(user)}`] ?? tags[`owner.user.${user}`];
    if (tagged) {
      return { label: tagged, source: 'tag', application: app, username: user };
    }
  }
  if (tags['owner.default']) {
    return {
      label: tags['owner.default'],
      source: 'tag',
      application: app,
      username: user,
    };
  }
  return null;
}

export async function resolveQueryOwner(
  instanceId: number,
  opts: {
    queryid?: string | null;
    username?: string | null;
    tags?: Record<string, string>;
    windowMinutes?: number;
  },
): Promise<QueryOwner> {
  const tags = opts.tags ?? {};
  const windowMinutes = opts.windowMinutes ?? 60;
  let application: string | null = null;

  if (opts.queryid) {
    const rows = await query<{ application: string; samples: number }>(
      `select coalesce(nullif(application, ''), '(unknown)') as application,
              sum(samples)::int as samples
         from buho.query_actors
        where instance_id = $1
          and queryid = $2::bigint
          and ts > now() - ($3 || ' minutes')::interval
        group by 1
        order by 2 desc
        limit 1`,
      [instanceId, opts.queryid, windowMinutes],
    ).catch(() => [] as { application: string; samples: number }[]);
    application = rows[0]?.application ?? null;
    if (application === '(unknown)') application = null;
  }

  const fromTag = resolveOwnerFromTags(tags, {
    application,
    username: opts.username,
  });
  if (fromTag) return fromTag;

  if (application) {
    return {
      label: application,
      source: 'application',
      application,
      username: opts.username ?? null,
    };
  }
  if (opts.username) {
    return {
      label: opts.username,
      source: 'username',
      application: null,
      username: opts.username,
    };
  }
  return {
    label: 'unknown owner',
    source: 'unknown',
    application: null,
    username: null,
  };
}

export function pageLabelForOwner(owner: QueryOwner): string {
  if (owner.source === 'tag') {
    return `Page · ${owner.label}${owner.application ? ` (${owner.application})` : owner.username ? ` (${owner.username})` : ''}`;
  }
  if (owner.source === 'application') {
    return `Page · Application “${owner.label}”`;
  }
  if (owner.source === 'username') {
    return `Page · DB user “${owner.label}”`;
  }
  return 'Page · Application / owners of the blocker query';
}
