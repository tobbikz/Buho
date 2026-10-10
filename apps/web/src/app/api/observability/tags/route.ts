import { NextResponse } from 'next/server';
import { requireAdmin, requireUser } from '@/lib/session';
import {
  addObsServiceTag,
  listObsServiceTags,
  removeObsServiceTag,
  type ObsTagEntityKind,
} from '@/lib/obs-tags';

export const dynamic = 'force-dynamic';

function parseKind(raw: unknown): ObsTagEntityKind | null {
  return raw === 'apm' || raw === 'synthetics' ? raw : null;
}

/** List all Observability inventory tags (any signed-in user). */
export async function GET() {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  try {
    const tags = await listObsServiceTags();
    return NextResponse.json({ tags });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** Add a tag to an APM service or Synthetics monitor (admin). */
export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  let body: { entityKind?: string; entityKey?: string; tag?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const entityKind = parseKind(body.entityKind);
  const entityKey = body.entityKey?.trim() ?? '';
  if (!entityKind || !entityKey || !body.tag) {
    return NextResponse.json(
      { error: 'entityKind, entityKey, and tag are required' },
      { status: 400 },
    );
  }

  const result = await addObsServiceTag(entityKind, entityKey, body.tag);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, tag: result.tag });
}

/** Remove a tag (admin). */
export async function DELETE(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  let body: { entityKind?: string; entityKey?: string; tag?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const entityKind = parseKind(body.entityKind);
  const entityKey = body.entityKey?.trim() ?? '';
  if (!entityKind || !entityKey || !body.tag) {
    return NextResponse.json(
      { error: 'entityKind, entityKey, and tag are required' },
      { status: 400 },
    );
  }

  const result = await removeObsServiceTag(entityKind, entityKey, body.tag);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
