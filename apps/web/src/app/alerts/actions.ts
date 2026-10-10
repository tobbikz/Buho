'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSilence } from '@/lib/alerts';
import { requireUser } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';

/** On-call silence from the Alerts table (any signed-in console user). */
export async function silenceOpenAlert(formData: FormData) {
  const session = await requireUser();
  const instanceId = Number(formData.get('instanceId'));
  const checkId = String(formData.get('checkId') ?? '').trim();
  const hours = Number(formData.get('hours') ?? 4) || 4;
  const lane = String(formData.get('lane') ?? 'live');
  const reason =
    String(formData.get('reason') ?? '').trim() ||
    `Silenced from Alerts · ${checkId || 'check'} · ${hours}h`;

  if (!Number.isFinite(instanceId) || instanceId <= 0 || !checkId) {
    redirect('/alerts?error=1');
  }

  await createSilence({
    instanceId,
    checkId,
    reason,
    hours: Math.max(1, Math.min(168, hours)),
    createdBy: session.username,
  });
  await logConsoleEvent(session.username, 'alert silence created', `${checkId} @ ${instanceId}`);
  revalidatePath('/alerts');
  revalidatePath('/admin/alerts');
  const params = new URLSearchParams();
  if (lane === 'posture' || lane === 'all') params.set('lane', lane);
  params.set('ok', 'silenced');
  redirect(`/alerts?${params.toString()}`);
}
