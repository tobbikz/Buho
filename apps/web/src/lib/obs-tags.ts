import { query } from './db';
import {
  normalizeObsTag,
  type ObsTagEntityKind,
} from './obs-tags-shared';

export type { ObsTagEntityKind } from './obs-tags-shared';
export { normalizeObsTag, entityKeyFromInventoryId } from './obs-tags-shared';

export type ObsServiceTag = {
  entityKind: ObsTagEntityKind;
  entityKey: string;
  tag: string;
};

export async function listObsServiceTags(): Promise<ObsServiceTag[]> {
  const rows = await query<{ entity_kind: string; entity_key: string; tag: string }>(
    `select entity_kind, entity_key, tag
       from buho.obs_service_tags
      order by tag, entity_kind, entity_key`,
  );
  return rows.map((r) => ({
    entityKind: r.entity_kind as ObsTagEntityKind,
    entityKey: r.entity_key,
    tag: r.tag,
  }));
}

/** Map `${kind}:${key}` → sorted unique tags. */
export async function listObsServiceTagsByEntity(): Promise<Map<string, string[]>> {
  const tags = await listObsServiceTags();
  const map = new Map<string, string[]>();
  for (const t of tags) {
    const k = `${t.entityKind}:${t.entityKey}`;
    const arr = map.get(k) ?? [];
    arr.push(t.tag);
    map.set(k, arr);
  }
  for (const [k, arr] of map) {
    map.set(k, [...new Set(arr)].sort((a, b) => a.localeCompare(b)));
  }
  return map;
}

export async function addObsServiceTag(
  entityKind: ObsTagEntityKind,
  entityKey: string,
  rawTag: string,
): Promise<{ ok: true; tag: string } | { ok: false; error: string }> {
  const tag = normalizeObsTag(rawTag);
  if (!tag) {
    return {
      ok: false,
      error: 'Invalid tag. Use letters, numbers, and : _ . / - (max 64).',
    };
  }
  const key = entityKey.trim();
  if (!key) return { ok: false, error: 'entity_key required' };
  if (entityKind !== 'apm' && entityKind !== 'synthetics') {
    return { ok: false, error: 'entity_kind must be apm or synthetics' };
  }

  await query(
    `insert into buho.obs_service_tags (entity_kind, entity_key, tag)
     values ($1, $2, $3)
     on conflict do nothing`,
    [entityKind, key, tag],
  );
  return { ok: true, tag };
}

export async function removeObsServiceTag(
  entityKind: ObsTagEntityKind,
  entityKey: string,
  rawTag: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tag = normalizeObsTag(rawTag);
  if (!tag) return { ok: false, error: 'Invalid tag' };
  const key = entityKey.trim();
  if (!key) return { ok: false, error: 'entity_key required' };

  await query(
    `delete from buho.obs_service_tags
      where entity_kind = $1 and entity_key = $2 and tag = $3`,
    [entityKind, key, tag],
  );
  return { ok: true };
}
