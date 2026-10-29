import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { sharedPasswordConfigured } from '@/lib/auth';
import { requireAdmin } from '@/lib/session';
import {
  activeAdmins,
  createUser,
  deleteUser,
  findUser,
  listUsers,
  logConsoleEvent,
  setDisabled,
  setPassword,
  setRole,
  type Role,
  type User,
} from '@/lib/users';

export const dynamic = 'force-dynamic';

const MIN_PASSWORD = 12;

function fail(message: string): never {
  redirect('/admin/users?error=' + encodeURIComponent(message));
}

async function create(formData: FormData) {
  'use server';

  const session = await requireAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role: Role = formData.get('role') === 'admin' ? 'admin' : 'viewer';

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    fail('Username must be 3–32 characters: letters, numbers, dot, hyphen, or underscore.');
  }
  if (password.length < MIN_PASSWORD) {
    fail(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (await findUser(username)) {
    fail(`Ya existe una cuenta llamada "${username}".`);
  }

  await createUser(username, password, role, session.username);
  await logConsoleEvent(session.username, 'cuenta creada', `${username} como ${role}`);
  revalidatePath('/admin/users');
}

async function update(formData: FormData) {
  'use server';

  const session = await requireAdmin();
  const userId = Number(formData.get('userId') ?? 0);
  const username = String(formData.get('username') ?? '');
  const action = String(formData.get('action') ?? '');

  // Estas tres guardas existen para el mismo error: el último administrador se
  // quita el privilegio o se deshabilita y ya nadie puede volver a entrar a
  // administrar. La consola quedaría de sólo lectura para siempre.
  const lastAdmin = (await activeAdmins()) <= 1;

  if (action === 'rol') {
    const role: Role = formData.get('role') === 'admin' ? 'admin' : 'viewer';
    if (role === 'viewer' && lastAdmin) {
      fail('This is the last active administrator: name another one first.');
    }
    await setRole(userId, role);
    await logConsoleEvent(session.username, 'rol cambiado', `${username} → ${role}`);
  } else if (action === 'deshabilitar' || action === 'habilitar') {
    const disabled = action === 'deshabilitar';
    if (disabled && lastAdmin) {
      fail('This is the last active administrator: name another one first.');
    }
    await setDisabled(userId, disabled);
    await logConsoleEvent(session.username, disabled ? 'cuenta deshabilitada' : 'cuenta habilitada', username);
  } else if (action === 'borrar') {
    if (lastAdmin) {
      fail('This is the last active administrator: name another one first.');
    }
    await deleteUser(userId);
    await logConsoleEvent(session.username, 'cuenta borrada', username);
  } else if (action === 'contraseña') {
    const password = String(formData.get('password') ?? '');
    if (password.length < MIN_PASSWORD) {
      fail(`Password must be at least ${MIN_PASSWORD} characters.`);
    }
    await setPassword(userId, password);
    await logConsoleEvent(session.username, 'password changed', username);
  }

  revalidatePath('/admin/users');
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  let users: User[];
  try {
    users = await listUsers();
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

  const admins = users.filter((user) => user.role === 'admin' && !user.disabled);
  const bootstrap = users.length === 0;

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard label="Accounts" value={String(users.length)} hint={bootstrap ? 'none yet' : undefined} />
        <StatCard
          label="Administradores activos"
          value={String(admins.length)}
          hint="can change configuration"
          tone={admins.length === 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Shared password"
          value={bootstrap && sharedPasswordConfigured() ? 'activa' : 'inactiva'}
          hint={bootstrap ? 'stops working once the first account is created' : 'no longer works for sign-in'}
          tone={bootstrap ? 'warn' : 'ok'}
        />
      </div>

      {bootstrap ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">You are using the shared password</span>
            <span className="tag tag--warn">no accounts</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            While no accounts exist, anyone who knows <span className="font-mono">BUHO_AUTH_PASSWORD</span> signs in
            as administrator and there is no per-user audit trail. Creating the first account disables that shared
            password — otherwise it would be a permanent back door that ignores roles. Also set{' '}
            <span className="font-mono">BUHO_AUTH_SECRET</span> so rotating passwords does not invalidate every
            session.
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Create account</span>
        </div>
        <form action={create} className="panel-body flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">Username</span>
            <input
              name="username"
              autoComplete="off"
              className="w-[12rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Password
            </span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              className="w-[14rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">Role</span>
            <select
              name="role"
              defaultValue="viewer"
              className="border border-border bg-surface px-1.5 py-1 text-[12px] outline-none focus:border-accent"
            >
              <option value="viewer">viewer — read only</option>
              <option value="admin">admin — can change configuration</option>
            </select>
          </label>
          <button type="submit" className="btn btn--primary">
            Create
          </button>
          {error ? <p className="w-full text-[12px] text-error">{decodeURIComponent(error)}</p> : null}
          <p className="w-full text-[11.5px] text-foreground-muted">
            Minimum {MIN_PASSWORD} characters. Stored with scrypt and a per-account salt; Búho never keeps the
            plaintext password and cannot recover it — only replace it.
          </p>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Accounts</span>
        </div>
        {users.length === 0 ? (
          <div className="empty">No accounts. The console is still in shared-password mode.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>State</th>
                <th>Created</th>
                <th>By</th>
                <th>Last sign-in</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId}>
                  <td className="font-mono text-[11.5px]">{user.username}</td>
                  <td>
                    <form action={update} className="flex items-center gap-1">
                      <input type="hidden" name="userId" value={user.userId} />
                      <input type="hidden" name="username" value={user.username} />
                      <input type="hidden" name="action" value="rol" />
                      <select
                        name="role"
                        defaultValue={user.role}
                        className="border border-border bg-surface px-1 py-0.5 text-[11px] outline-none focus:border-accent"
                      >
                        <option value="viewer">viewer</option>
                        <option value="admin">admin</option>
                      </select>
                      <button type="submit" className="btn">
                        Change
                      </button>
                    </form>
                  </td>
                  <td>
                    {user.disabled ? (
                      <span className="tag tag--muted">disabled</span>
                    ) : (
                      <span className="tag tag--ok">active</span>
                    )}
                  </td>
                  <td>{formatAgo(user.createdAt)}</td>
                  <td className="text-[11px] text-foreground-secondary">{user.createdBy ?? '—'}</td>
                  <td>{user.lastLoginAt ? formatAgo(user.lastLoginAt) : 'never'}</td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1">
                      <form action={update} className="flex items-center gap-1">
                        <input type="hidden" name="userId" value={user.userId} />
                        <input type="hidden" name="username" value={user.username} />
                        <input type="hidden" name="action" value="contraseña" />
                        <input
                          name="password"
                          type="password"
                          placeholder="new password"
                          autoComplete="new-password"
                          className="w-[9.5rem] border border-border bg-surface px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
                        />
                        <button type="submit" className="btn">
                          Change
                        </button>
                      </form>
                      <form action={update}>
                        <input type="hidden" name="userId" value={user.userId} />
                        <input type="hidden" name="username" value={user.username} />
                        <input
                          type="hidden"
                          name="action"
                          value={user.disabled ? 'habilitar' : 'deshabilitar'}
                        />
                        <button type="submit" className="btn">
                          {user.disabled ? 'Enable' : 'Disable'}
                        </button>
                      </form>
                      <form action={update}>
                        <input type="hidden" name="userId" value={user.userId} />
                        <input type="hidden" name="username" value={user.username} />
                        <input type="hidden" name="action" value="borrar" />
                        <button type="submit" className="btn">
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">What each role can do</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>viewer</th>
              <th>admin</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['View fleet, instances, analysis, estate, and security', true, true],
              ['View query text and security findings', true, true],
              ['Scan the network (discovery)', false, true],
              ['Create, change, and delete accounts', false, true],
              ['Change data retention', false, true],
              ['View the console audit log', false, true],
            ].map(([action, viewer, admin]) => (
              <tr key={String(action)}>
                <td>{action}</td>
                <td>{viewer ? <span className="tag tag--ok">yes</span> : <span className="tag tag--muted">no</span>}</td>
                <td>{admin ? <span className="tag tag--ok">yes</span> : <span className="tag tag--muted">no</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="panel-body text-[11.5px] text-foreground-muted">
          A viewer can see everything Búho monitors, including query text and security findings. The split is between
          read and change — not which instances each person sees; if you need that later, build it on top of tags.
        </div>
      </section>
    </div>
  );
}
