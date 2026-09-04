import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { GetStartedWizard } from '@/components/GetStartedWizard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { listAlertChannels, upsertAlertChannel } from '@/lib/alerts';
import { listInstances } from '@/lib/queries';
import { requireAdmin } from '@/lib/session';
import { parseTargetForm, saveMonitorTarget } from '@/lib/targets';
import { logConsoleEvent } from '@/lib/users';

export const dynamic = 'force-dynamic';

async function addTarget(formData: FormData) {
  'use server';
  await requireAdmin();
  try {
    await saveMonitorTarget(parseTargetForm(formData));
  } catch (error) {
    redirect(
      `/get-started?step=1&error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
  }
  revalidatePath('/');
  revalidatePath('/get-started');
  redirect('/get-started?step=2');
}

async function saveChannel(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const kindRaw = String(formData.get('kind') ?? 'webhook').trim();
  const kind = (
    [
      'webhook',
      'slack',
      'teams',
      'discord',
      'googlechat',
      'mattermost',
      'telegram',
      'rocketchat',
      'pagerduty',
      'smtp',
    ].includes(kindRaw)
      ? kindRaw
      : 'webhook'
  ) as
    | 'webhook'
    | 'slack'
    | 'teams'
    | 'discord'
    | 'googlechat'
    | 'mattermost'
    | 'telegram'
    | 'rocketchat'
    | 'pagerduty'
    | 'smtp';
  const name = String(formData.get('name') ?? kind).trim() || kind;
  const enabled = formData.get('enabled') === 'on';

  if (kind === 'smtp') {
    await upsertAlertChannel({
      name,
      kind: 'smtp',
      config: {
        host: String(formData.get('smtpHost') ?? '').trim(),
        port: Number(formData.get('smtpPort') ?? 587) || 587,
        secure: formData.get('smtpSecure') === 'on',
        user: String(formData.get('smtpUser') ?? '').trim() || undefined,
        pass: String(formData.get('smtpPass') ?? '').trim() || undefined,
        from: String(formData.get('smtpFrom') ?? '').trim(),
        to: String(formData.get('smtpTo') ?? '').trim(),
      },
      enabled,
    });
  } else if (kind === 'telegram') {
    await upsertAlertChannel({
      name,
      kind: 'telegram',
      config: {
        botToken: String(formData.get('botToken') ?? '').trim(),
        chatId: String(formData.get('chatId') ?? '').trim(),
      },
      enabled,
    });
  } else if (kind === 'pagerduty') {
    await upsertAlertChannel({
      name,
      kind: 'pagerduty',
      config: { routingKey: String(formData.get('routingKey') ?? '').trim() },
      enabled,
    });
  } else {
    await upsertAlertChannel({
      name,
      kind,
      config: { url: String(formData.get('url') ?? '').trim() },
      enabled,
    });
  }

  await logConsoleEvent(session.username, 'alert channel created (get-started)', name);
  revalidatePath('/get-started');
  revalidatePath('/admin/alerts');
  redirect('/get-started?step=3');
}

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const { step: stepRaw, error } = await searchParams;
  const stepNum = Number(stepRaw ?? '1');
  const step = (stepNum === 2 || stepNum === 3 ? stepNum : 1) as 1 | 2 | 3;

  let channels;
  let instances;
  try {
    await requireAdmin();
    [channels, instances] = await Promise.all([listAlertChannels(), listInstances()]);
  } catch (err) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Get started' }]} />
        <div className="page">
          <StoreError message={err instanceof Error ? err.message : String(err)} />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Get started' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Get started</h1>
            <p className="page-sub">
              Three steps: add a database → wait for the first check score → send a test alert. No need
              to hunt through Admin.
            </p>
          </div>
        </header>

        {error ? <div className="notice notice--warn">{error}</div> : null}

        <GetStartedWizard
          step={step}
          addDatabaseAction={addTarget}
          saveChannelAction={saveChannel}
          channels={channels.map((c) => ({
            channelId: c.channelId,
            name: c.name,
            kind: c.kind,
            enabled: c.enabled,
          }))}
          instances={instances.map((i) => ({
            instanceId: i.instanceId,
            alias: i.alias,
            score: i.score,
            critical: i.critical,
            warning: i.warning,
          }))}
        />
      </div>
    </>
  );
}
