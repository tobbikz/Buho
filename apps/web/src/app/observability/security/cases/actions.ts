'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { upsertSecurityCase } from '@/lib/security-cases';
import { requireUser } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';

export async function openCaseFromFinding(formData: FormData) {
  const session = await requireUser();
  const title = String(formData.get('title') ?? '').trim();
  const severity = String(formData.get('severity') ?? 'alta').trim();
  const instanceId = String(formData.get('instanceId') ?? '').trim();
  const checkId = String(formData.get('checkId') ?? '').trim();
  if (!title || !checkId) redirect('/observability/security/findings?error=1');

  const caseId = await upsertSecurityCase({
    title,
    severity,
    status: 'open',
    assignee: session.username,
    findingKeys: [{ instanceId: Number(instanceId) || null, checkId }],
    note: `Opened from finding ${checkId}`,
  });
  await logConsoleEvent(session.username, 'security case open', `case ${caseId}`);
  revalidatePath('/observability/security/cases');
  redirect(`/observability/security/cases?ok=opened&id=${caseId}`);
}

export async function setCaseStatus(formData: FormData) {
  const session = await requireUser();
  const caseId = Number(formData.get('caseId'));
  const status = String(formData.get('status') ?? '').trim();
  const title = String(formData.get('title') ?? 'Case').trim();
  if (!caseId || !['open', 'acked', 'closed'].includes(status)) {
    redirect('/observability/security/cases?error=1');
  }
  await upsertSecurityCase({ caseId, title, status });
  await logConsoleEvent(session.username, 'security case status', `${caseId} → ${status}`);
  revalidatePath('/observability/security/cases');
  redirect(`/observability/security/cases?ok=${status}`);
}
