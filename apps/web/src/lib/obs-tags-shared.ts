export type ObsTagEntityKind = 'apm' | 'synthetics';

const TAG_RE = /^[a-z0-9][a-z0-9_.:/-]{0,63}$/i;

/** Normalize freeform tag (env:prod, team/payments, tier.critical). */
export function normalizeObsTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!tag || tag.length > 64 || !TAG_RE.test(tag)) return null;
  return tag;
}

export function entityKeyFromInventoryId(id: string): {
  entityKind: ObsTagEntityKind;
  entityKey: string;
} | null {
  if (id.startsWith('svc:')) {
    return { entityKind: 'apm', entityKey: id.slice(4) };
  }
  if (id.startsWith('mon:')) {
    return { entityKind: 'synthetics', entityKey: id.slice(4) };
  }
  return null;
}
