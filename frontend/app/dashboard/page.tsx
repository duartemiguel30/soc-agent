"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { IncidentList } from "@/app/components/IncidentList";
import { Incident, listIncidents, listPendingIncidents } from "@/lib/api";
import {
  getSeverity,
  isCriticalSeverityIncident,
  isPendingIncident,
  isProcessedIncident,
  labelValue,
} from "@/lib/incidents";

export default function DashboardPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [pending, setPending] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [allIncidents, pendingIncidents] = await Promise.all([listIncidents(), listPendingIncidents()]);
      setIncidents(allIncidents);
      setPending(pendingIncidents);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load incidents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 10000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const counts = useMemo(() => {
    return {
      total: incidents.length,
      pending: pending.length,
      criticalSeverity: incidents.filter(isCriticalSeverityIncident).length,
      approved: incidents.filter((incident) => incident.status === "approved").length,
      rejected: incidents.filter((incident) => incident.status === "rejected").length,
      processed: incidents.filter(isProcessedIncident).length,
    };
  }, [incidents, pending]);

  const recent = incidents.slice(0, 5);
  const severityDistribution = useMemo(() => {
    const distribution = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    incidents.forEach((incident) => {
      distribution[getSeverity(incident)] += 1;
    });
    return distribution;
  }, [incidents]);

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Live operations</p>
                <h1>Dashboard</h1>
              </div>
              <div className="toolbar">
                {lastUpdated ? <span className="muted">Updated {lastUpdated}</span> : null}
                <button className="button secondary" onClick={refresh} disabled={loading}>
                  Refresh
                </button>
              </div>
            </div>

            {error ? <div className="alert error">{error}</div> : null}

            <section className="metric-grid" aria-label="Incident counts">
              <div className="metric-card">
                <span>Total</span>
                <strong>{counts.total}</strong>
              </div>
              <div className="metric-card">
                <span>Pending</span>
                <strong>{counts.pending}</strong>
              </div>
              <div className="metric-card">
                <span>Critical severity</span>
                <strong>{counts.criticalSeverity}</strong>
              </div>
              <div className="metric-card">
                <span>Approved</span>
                <strong>{counts.approved}</strong>
              </div>
              <div className="metric-card">
                <span>Rejected</span>
                <strong>{counts.rejected}</strong>
              </div>
              <div className="metric-card">
                <span>Auto processed</span>
                <strong>{counts.processed}</strong>
              </div>
            </section>

            <div className="dashboard-grid">
              <section className="panel">
                <div className="section-head">
                  <h2>Pending Review</h2>
                  <span>{pending.length}</span>
                </div>
                {loading ? (
                  <div className="loading-panel">Loading pending incidents...</div>
                ) : (
                  <IncidentList incidents={pending.slice(0, 5)} onChanged={refresh} compact detailed={false} />
                )}
              </section>
              <section className="panel">
                <div className="section-head">
                  <h2>Recent Incidents</h2>
                  <span>{recent.length}</span>
                </div>
                {loading ? (
                  <div className="loading-panel">Loading recent incidents...</div>
                ) : (
                  <IncidentList incidents={recent} onChanged={refresh} compact detailed={false} />
                )}
              </section>
              <section className="panel dashboard-side-panel">
                <div className="section-head">
                  <h2>Severity Distribution</h2>
                  <span>{incidents.length} total</span>
                </div>
                <div className="distribution-list">
                  {Object.entries(severityDistribution).map(([severity, count]) => (
                    <div key={severity} className="distribution-row">
                      <span>{labelValue(severity)}</span>
                      <strong>{count}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
