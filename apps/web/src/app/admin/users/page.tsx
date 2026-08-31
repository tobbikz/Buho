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
    fail('El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.');
  }
  if (password.length < MIN_PASSWORD) {
    fail(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
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
      fail('Es el último administrador activo: primero hay que nombrar otro.');
    }
    await setRole(userId, role);
    await logConsoleEvent(session.username, 'rol cambiado', `${username} → ${role}`);
  } else if (action === 'deshabilitar' || action === 'habilitar') {
    const disabled = action === 'deshabilitar';
    if (disabled && lastAdmin) {
      fail('Es el último administrador activo: primero hay que nombrar otro.');
    }
    await setDisabled(userId, disabled);
    await logConsoleEvent(session.username, disabled ? 'cuenta deshabilitada' : 'cuenta habilitada', username);
  } else if (action === 'borrar') {
    if (lastAdmin) {
      fail('Es el último administrador activo: primero hay que nombrar otro.');
    }
    await deleteUser(userId);
    await logConsoleEvent(session.username, 'cuenta borrada', username);
  } else if (action === 'contraseña') {
    const password = String(formData.get('password') ?? '');
    if (password.length < MIN_PASSWORD) {
      fail(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
    }
    await setPassword(userId, password);
    await logConsoleEvent(session.username, 'contraseña cambiada', username);
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
        <StatCard label="Cuentas" value={String(users.length)} hint={bootstrap ? 'ninguna todavía' : undefined} />
        <StatCard
          label="Administradores activos"
          value={String(admins.length)}
          hint="pueden cambiar configuración"
          tone={admins.length === 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Contraseña compartida"
          value={bootstrap && sharedPasswordConfigured() ? 'activa' : 'inactiva'}
          hint={bootstrap ? 'deja de servir al crear la primera cuenta' : 'ya no sirve para entrar'}
          tone={bootstrap ? 'warn' : 'ok'}
        />
      </div>

      {bootstrap ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Estás usando la contraseña compartida</span>
            <span className="tag tag--warn">sin cuentas</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            Mientras no exista ninguna cuenta, quien sepa <span className="font-mono">BUHO_AUTH_PASSWORD</span> entra
            como administrador y no hay forma de saber quién hizo cada cambio. Al crear la primera cuenta esa
            contraseña deja de funcionar: si siguiera valiendo sería una puerta trasera permanente que ignora los
            roles. Definir también <span className="font-mono">BUHO_AUTH_SECRET</span> para que cambiar contraseñas no
            cierre todas las sesiones.
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Crear cuenta</span>
        </div>
        <form action={create} className="panel-body flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">Usuario</span>
            <input
              name="username"
              autoComplete="off"
              className="w-[12rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Contraseña
            </span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              className="w-[14rem] border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">Rol</span>
            <select
              name="role"
              defaultValue="viewer"
              className="border border-border bg-surface px-1.5 py-1 text-[12px] outline-none focus:border-accent"
            >
              <option value="viewer">viewer — sólo lectura</option>
              <option value="admin">admin — puede cambiar configuración</option>
            </select>
          </label>
          <button type="submit" className="btn btn--primary">
            Crear
          </button>
          {error ? <p className="w-full text-[12px] text-error">{decodeURIComponent(error)}</p> : null}
          <p className="w-full text-[11.5px] text-foreground-muted">
            Mínimo {MIN_PASSWORD} caracteres. Se guarda con scrypt y sal por cuenta; Búho nunca almacena la
            contraseña en claro ni puede recuperarla, sólo reemplazarla.
          </p>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Cuentas</span>
        </div>
        {users.length === 0 ? (
          <div className="empty">Sin cuentas. La consola sigue en modo contraseña compartida.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Creada</th>
                <th>Por</th>
                <th>Último ingreso</th>
                <th>Acciones</th>
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
                        Cambiar
                      </button>
                    </form>
                  </td>
                  <td>
                    {user.disabled ? (
                      <span className="tag tag--muted">deshabilitada</span>
                    ) : (
                      <span className="tag tag--ok">activa</span>
                    )}
                  </td>
                  <td>{formatAgo(user.createdAt)}</td>
                  <td className="text-[11px] text-foreground-secondary">{user.createdBy ?? '—'}</td>
                  <td>{user.lastLoginAt ? formatAgo(user.lastLoginAt) : 'nunca'}</td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1">
                      <form action={update} className="flex items-center gap-1">
                        <input type="hidden" name="userId" value={user.userId} />
                        <input type="hidden" name="username" value={user.username} />
                        <input type="hidden" name="action" value="contraseña" />
                        <input
                          name="password"
                          type="password"
                          placeholder="nueva contraseña"
                          autoComplete="new-password"
                          className="w-[9.5rem] border border-border bg-surface px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
                        />
                        <button type="submit" className="btn">
                          Cambiar
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
                          {user.disabled ? 'Habilitar' : 'Deshabilitar'}
                        </button>
                      </form>
                      <form action={update}>
                        <input type="hidden" name="userId" value={user.userId} />
                        <input type="hidden" name="username" value={user.username} />
                        <input type="hidden" name="action" value="borrar" />
                        <button type="submit" className="btn">
                          Borrar
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
          <span className="panel-title">Qué puede cada rol</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Acción</th>
              <th>viewer</th>
              <th>admin</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Ver flota, instancias, análisis, parque y seguridad', true, true],
              ['Ver textos de consultas y hallazgos de seguridad', true, true],
              ['Escanear la red (descubrimiento)', false, true],
              ['Crear, cambiar y borrar cuentas', false, true],
              ['Cambiar la retención de datos', false, true],
              ['Ver la bitácora de la consola', false, true],
            ].map(([action, viewer, admin]) => (
              <tr key={String(action)}>
                <td>{action}</td>
                <td>{viewer ? <span className="tag tag--ok">sí</span> : <span className="tag tag--muted">no</span>}</td>
                <td>{admin ? <span className="tag tag--ok">sí</span> : <span className="tag tag--muted">no</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="panel-body text-[11.5px] text-foreground-muted">
          Un viewer ve todo lo que Búho monitorea, incluidos textos de consultas y hallazgos de seguridad. La división
          es entre mirar y cambiar, no entre qué instancias ve cada quien; si hace falta eso último, se puede construir
          sobre las etiquetas.
        </div>
      </section>
    </div>
  );
}
