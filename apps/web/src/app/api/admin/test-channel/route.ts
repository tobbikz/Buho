import { NextResponse } from 'next/server';
import { sendChannelTest } from '@/lib/alerts';
import { requireAdmin } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  }

  let channelId = 0;
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as { channelId?: number };
    channelId = Number(body.channelId);
  } else {
    const form = await request.formData();
    channelId = Number(form.get('channelId'));
  }

  if (!Number.isInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ error: 'channelId required' }, { status: 400 });
  }

  try {
    await sendChannelTest(channelId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
