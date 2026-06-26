"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { Incident, listArchivedIncidents, listIncidents } from "@/lib/api";
import {
  getSeverity,
  isCriticalDecisionIncident,
  isPendingIncident,
  isProcessedIncident,
  labelValue,
  normalizeValue,
} from "@/lib/incidents";

export default function DashboardPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [storedCount, setStoredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [activeIncidents, allIncidents, archivedIncidents] = await Promise.all([
        listIncidents("false"),
        listIncidents("all"),
        listArchivedIncidents(),
      ]);
      setIncidents(activeIncidents);
      setStoredCount(allIncidents.length);
      setArchivedCount(archivedIncidents.length);
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
      pending: incidents.filter(isPendingIncident).length,
      approved: incidents.filter((incident) => incident.status === "approved").length,
      rejected: incidents.filter((incident) => incident.status === "rejected").length,
      processed: incidents.filter(isProcessedIncident).length,
      criticalDecision: incidents.filter(isCriticalDecisionIncident).length,
      humanReviewDecision: incidents.filter((incident) => normalizeValue(incident.decision) === "human_review").length,
      autoResponseDecision: incidents.filter((incident) => normalizeValue(incident.decision) === "auto_response").length,
    };
  }, [incidents]);

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

            <section className="metric-grid" aria-label="Active incident counts">
              <div className="metric-card">
                <span>Active total</span>
                <strong>{counts.total}</strong>
              </div>
              <div className="metric-card">
                <span>Pending</span>
                <strong>{counts.pending}</strong>
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
              <div className="metric-card">
                <span>Archived</span>
                <strong>{archivedCount}</strong>
              </div>
              <div className="metric-card">
                <span>Total stored</span>
                <strong>{storedCount}</strong>
              </div>
            </section>

            <section className="panel severity-strip-panel">
              <div className="section-head">
                <h2>Active Severity Distribution</h2>
                <span>{incidents.length} active</span>
              </div>
              <div className="metric-grid compact-metrics">
                {Object.entries(severityDistribution).map(([severity, count]) => (
                  <div key={severity} className="metric-card compact">
                    <span>{labelValue(severity)}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>Active Decision Metrics</h2>
                <span>Current incident set</span>
              </div>
              <div className="metric-grid compact-metrics">
                <div className="metric-card compact">
                  <span>Critical alert decisions</span>
                  <strong>{counts.criticalDecision}</strong>
                </div>
                <div className="metric-card compact">
                  <span>Human review decisions</span>
                  <strong>{counts.humanReviewDecision}</strong>
                </div>
                <div className="metric-card compact">
                  <span>Auto response decisions</span>
                  <strong>{counts.autoResponseDecision}</strong>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>Navigation</h2>
                <span>Operational shortcuts</span>
              </div>
              <div className="shortcut-grid">
                <Link className="shortcut-card" href="/incidents">
                  <span>Triage queue</span>
                  <strong>{counts.pending}</strong>
                  <p>Review active incidents that need analyst approval or rejection.</p>
                </Link>
                <Link className="shortcut-card" href="/archive">
                  <span>Archive</span>
                  <strong>{archivedCount}</strong>
                  <p>Search and restore incidents removed from active operational views.</p>
                </Link>
                <Link className="shortcut-card" href="/report">
                  <span>Executive report</span>
                  <strong>Generate</strong>
                  <p>Create the current global AI summary from stored incidents.</p>
                </Link>
              </div>
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
