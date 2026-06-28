"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import {
  AdminAuditEvent,
  AdminAuditMetrics,
  getAdminAuditMetrics,
  hasPermission,
  listAdminAuditEvents,
} from "@/lib/api";

const PAGE_SIZE = 50;

function formatDate(value?: string | null) {
  if (!value) return "N/A";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toLocaleString();
}

function labelValue(value: string) {
  return value.replace(/_/g, " ");
}

export default function AdminAuditPage() {
  const [metrics, setMetrics] = useState<AdminAuditMetrics | null>(null);
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [filters, setFilters] = useState({ event_type: "", actor_username: "", target_username: "", success: "all", from: "", to: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(
    async (nextOffset = 0, append = false) => {
      setError(null);
      setLoading(true);
      try {
        const [metricData, eventData] = await Promise.all([
          getAdminAuditMetrics(),
          listAdminAuditEvents({ ...filters, limit: PAGE_SIZE, offset: nextOffset }),
        ]);
        setMetrics(metricData);
        setEvents((current) => (append ? [...current, ...eventData.items] : eventData.items));
        setTotal(eventData.total);
        setOffset(eventData.offset + eventData.items.length);
        setHasMore(eventData.has_more);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load audit data");
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    const initialLoad = window.setTimeout(() => loadData(0, false), 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadData]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadData(0, false);
  }

  function clearFilters() {
    setFilters({ event_type: "", actor_username: "", target_username: "", success: "all", from: "", to: "" });
  }

  const actionTypes = metrics?.actions_by_type_7d ? Object.entries(metrics.actions_by_type_7d).slice(0, 8) : [];
  const actionUsers = metrics?.actions_by_user_7d ? Object.entries(metrics.actions_by_user_7d).slice(0, 8) : [];

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page admin-page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Administration</p>
                <h1>Audit</h1>
              </div>
              <button className="button secondary" onClick={() => loadData(0, false)} disabled={loading}>
                Refresh
              </button>
            </div>

            {!hasPermission(user, "view_audit") ? (
              <div className="alert error">Forbidden. Your role cannot view admin audit events.</div>
            ) : (
              <>
                {error ? <div className="alert error">{error}</div> : null}

                <section className="metric-grid compact-metrics">
                  <div className="metric-card compact">
                    <span>Successful logins 24h</span>
                    <strong>{metrics?.successful_logins_24h ?? 0}</strong>
                  </div>
                  <div className="metric-card compact">
                    <span>Failed logins 24h</span>
                    <strong>{metrics?.failed_logins_24h ?? 0}</strong>
                  </div>
                  <div className="metric-card compact">
                    <span>Active sessions</span>
                    <strong>{metrics?.active_sessions ?? 0}</strong>
                  </div>
                  <div className="metric-card compact">
                    <span>Disabled users</span>
                    <strong>{metrics?.disabled_users ?? 0}</strong>
                  </div>
                  <div className="metric-card compact">
                    <span>Total users</span>
                    <strong>{metrics?.total_users ?? 0}</strong>
                  </div>
                  <div className="metric-card compact">
                    <span>Denied 7d</span>
                    <strong>{metrics?.permission_denied_7d ?? 0}</strong>
                  </div>
                </section>

                <section className="dashboard-grid">
                  <div className="panel">
                    <div className="section-head">
                      <h2>Actions by Type</h2>
                      <span>7 days</span>
                    </div>
                    <div className="audit-mini-list">
                      {actionTypes.length ? actionTypes.map(([type, count]) => (
                        <div className="distribution-row" key={type}>
                          <span>{labelValue(type)}</span>
                          <strong>{count}</strong>
                        </div>
                      )) : <div className="empty-state compact">No audit events.</div>}
                    </div>
                  </div>
                  <div className="panel">
                    <div className="section-head">
                      <h2>Actions by User</h2>
                      <span>7 days</span>
                    </div>
                    <div className="audit-mini-list">
                      {actionUsers.length ? actionUsers.map(([actor, count]) => (
                        <div className="distribution-row" key={actor}>
                          <span>{actor}</span>
                          <strong>{count}</strong>
                        </div>
                      )) : <div className="empty-state compact">No user activity.</div>}
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <div className="section-head">
                    <h2>Filters</h2>
                    <span>{total} matching events</span>
                  </div>
                  <form className="admin-form-grid" onSubmit={applyFilters}>
                    <label className="field">
                      Event type
                      <input value={filters.event_type} onChange={(event) => setFilters((current) => ({ ...current, event_type: event.target.value }))} />
                    </label>
                    <label className="field">
                      Actor
                      <input value={filters.actor_username} onChange={(event) => setFilters((current) => ({ ...current, actor_username: event.target.value }))} />
                    </label>
                    <label className="field">
                      Target
                      <input value={filters.target_username} onChange={(event) => setFilters((current) => ({ ...current, target_username: event.target.value }))} />
                    </label>
                    <label className="field">
                      Success
                      <select value={filters.success} onChange={(event) => setFilters((current) => ({ ...current, success: event.target.value }))}>
                        <option value="all">All</option>
                        <option value="true">Success</option>
                        <option value="false">Failure</option>
                      </select>
                    </label>
                    <label className="field">
                      From
                      <input type="datetime-local" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
                    </label>
                    <label className="field">
                      To
                      <input type="datetime-local" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
                    </label>
                    <button className="button primary" type="submit" disabled={loading}>
                      Apply filters
                    </button>
                    <button className="button ghost" type="button" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </form>
                </section>

                <section className="panel">
                  <div className="section-head">
                    <h2>Events</h2>
                    <span>{events.length} loaded</span>
                  </div>
                  {loading && !events.length ? <div className="loading-panel">Loading audit events...</div> : null}
                  <div className="admin-table">
                    {events.map((event) => (
                      <article className="admin-row audit-row" key={event.id}>
                        <div className="admin-row-main">
                          <div className="badge-row">
                            <strong>{labelValue(event.event_type)}</strong>
                            <span className={event.success ? "badge available" : "badge unavailable"}>{event.success ? "Success" : "Failure"}</span>
                            {event.actor_role ? <span className="badge">{event.actor_role}</span> : null}
                          </div>
                          <span className="muted">
                            {formatDate(event.created_at)} - actor {event.actor_username || "unknown"} - target {event.target_username || event.target_id || "N/A"}
                          </span>
                        </div>
                        <div className="admin-row-details">
                          <span>{event.ip_address || "No IP"}</span>
                          <span>{event.target_type || "No target type"}</span>
                        </div>
                      </article>
                    ))}
                    {!loading && !events.length ? <div className="empty-state">No audit events match these filters.</div> : null}
                  </div>
                  {hasMore ? (
                    <button className="button secondary" onClick={() => loadData(offset, true)} disabled={loading}>
                      Load more
                    </button>
                  ) : null}
                </section>
              </>
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
