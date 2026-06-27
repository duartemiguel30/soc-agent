"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import {
  AdminRole,
  AdminUser,
  createAdminUser,
  disableAdminUser,
  enableAdminUser,
  hasPermission,
  listAdminUsers,
  resetAdminUserPassword,
  updateAdminUser,
} from "@/lib/api";

const roles: AdminRole[] = ["super_admin", "admin", "analyst", "viewer"];

function formatDate(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function emptyCreateForm() {
  return { username: "", display_name: "", role: "analyst" as AdminRole, password: "" };
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [resetPasswords, setResetPasswords] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSuperAdmins = useMemo(
    () => users.filter((user) => user.role === "super_admin" && user.is_active).length,
    [users],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setUsers(await listAdminUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load admin users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(initialLoad);
  }, [refresh]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await createAdminUser(createForm);
      setCreateForm(emptyCreateForm());
      await refresh();
      setNotice("User created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user");
    } finally {
      setBusy(false);
    }
  }

  async function patchUser(user: AdminUser, payload: { display_name?: string | null; role?: AdminRole; is_active?: boolean }) {
    if (!user.id) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await updateAdminUser(user.id, payload);
      await refresh();
      setNotice("User updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update user");
    } finally {
      setBusy(false);
    }
  }

  async function toggleUser(user: AdminUser) {
    if (!user.id) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      if (user.is_active) {
        await disableAdminUser(user.id);
        setNotice("User disabled.");
      } else {
        await enableAdminUser(user.id);
        setNotice("User enabled.");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update user status");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(user: AdminUser) {
    if (!user.id) return;
    const password = (resetPasswords[user.id] || "").trim();
    if (!password) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await resetAdminUserPassword(user.id, password);
      setResetPasswords((current) => ({ ...current, [user.id as number]: "" }));
      setNotice("Password reset.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthGuard>
      {(currentUser) => (
        <AppShell user={currentUser}>
          <main className="page admin-page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Administration</p>
                <h1>Users</h1>
              </div>
              <button className="button secondary" onClick={refresh} disabled={loading || busy}>
                Refresh
              </button>
            </div>

            {!hasPermission(currentUser, "manage_users") ? (
              <div className="alert error">Forbidden. Your role cannot manage admin users.</div>
            ) : (
              <>
                {notice ? <div className="alert success">{notice}</div> : null}
                {error ? <div className="alert error">{error}</div> : null}

                <section className="panel">
                  <div className="section-head">
                    <h2>Create User</h2>
                    <span>Super admin only</span>
                  </div>
                  <form className="admin-form-grid" onSubmit={handleCreate}>
                    <label className="field">
                      Username
                      <input value={createForm.username} onChange={(event) => setCreateForm((form) => ({ ...form, username: event.target.value }))} required />
                    </label>
                    <label className="field">
                      Display name
                      <input value={createForm.display_name} onChange={(event) => setCreateForm((form) => ({ ...form, display_name: event.target.value }))} />
                    </label>
                    <label className="field">
                      Role
                      <select value={createForm.role} onChange={(event) => setCreateForm((form) => ({ ...form, role: event.target.value as AdminRole }))}>
                        {roles.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      Password
                      <input minLength={8} type="password" value={createForm.password} onChange={(event) => setCreateForm((form) => ({ ...form, password: event.target.value }))} required />
                    </label>
                    <button className="button primary" type="submit" disabled={busy}>
                      Create user
                    </button>
                  </form>
                </section>

                <section className="panel">
                  <div className="section-head">
                    <h2>Admin Users</h2>
                    <span>{users.length} total</span>
                  </div>
                  {loading ? <div className="loading-panel">Loading users...</div> : null}
                  <div className="admin-table">
                    {users.map((user) => {
                      const lastSuperAdmin = user.role === "super_admin" && user.is_active && activeSuperAdmins <= 1;
                      return (
                        <article className="admin-row" key={user.id || user.username}>
                          <div className="admin-row-main">
                            <div className="badge-row">
                              <strong>{user.username}</strong>
                              <span className={`badge role-${user.role}`}>{user.role}</span>
                              <span className={user.is_active ? "badge available" : "badge unavailable"}>{user.is_active ? "Active" : "Disabled"}</span>
                              {lastSuperAdmin ? <span className="badge risk-medium">Last active super_admin</span> : null}
                            </div>
                            <span className="muted">Last login: {formatDate(user.last_login_at)}</span>
                          </div>
                          <div className="admin-row-controls">
                            <label className="field">
                              Display name
                              <input
                                defaultValue={user.display_name || ""}
                                onBlur={(event) => patchUser(user, { display_name: event.target.value })}
                                disabled={busy}
                              />
                            </label>
                            <label className="field">
                              Role
                              <select value={user.role as AdminRole} onChange={(event) => patchUser(user, { role: event.target.value as AdminRole })} disabled={busy || lastSuperAdmin}>
                                {roles.map((role) => (
                                  <option key={role} value={role}>
                                    {role}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field">
                              New password
                              <input
                                minLength={8}
                                type="password"
                                value={resetPasswords[user.id || 0] || ""}
                                onChange={(event) => setResetPasswords((current) => ({ ...current, [user.id || 0]: event.target.value }))}
                                disabled={busy}
                              />
                            </label>
                            <button className="button secondary" onClick={() => resetPassword(user)} disabled={busy || !(resetPasswords[user.id || 0] || "").trim()}>
                              Reset password
                            </button>
                            <button className={user.is_active ? "button danger" : "button primary"} onClick={() => toggleUser(user)} disabled={busy || lastSuperAdmin}>
                              {user.is_active ? "Disable" : "Enable"}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              </>
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
