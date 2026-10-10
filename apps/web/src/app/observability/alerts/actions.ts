'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSilence } from '@/lib/alerts';
import { requireUser } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';

/** Silence an App-plane alert (check_id = obs:<id>, no instance). */
export async function silenceObsAlert(formData: FormData) {
  const session = await requireUser();
  const alertId = String(formData.get('alertId') ?? '').trim();
  const hours = Number(formData.get('hours') ?? 4) || 4;
  if (!alertId) redirect('/observability/alerts?error=1');

  const checkId = `obs:${alertId}`;
  await createSilence({
    instanceId: null,
    checkId,
    reason: `Silenced from App alerts · ${alertId} · ${hours}h`,
    hours: Math.max(1, Math.min(168, hours)),
    createdBy: session.username,
  });
  await logConsoleEvent(session.username, 'obs alert silence', checkId);
  revalidatePath('/observability/alerts');
  revalidatePath('/admin/alerts');
  redirect('/observability/alerts?ok=silenced');
}
