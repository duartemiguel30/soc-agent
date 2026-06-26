"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertEvolutionExplorer } from "@/app/components/AlertEvolutionExplorer";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { Incident, listArchivedIncidents, listIncidents } from "@/lib/api";
import { incidentFilterHref, mitreDistribution, totalAlertEvents } from "@/lib/analytics";
import {
  getSeverity,
  incidentEventCount,
  isCriticalDecisionIncident,
  isPendingIncident,
  isProcessedIncident,
  labelValue,
  normalizeValue,
} from "@/lib/incidents";

type ChartDatum = {
  label: string;
  value: number;
  color?: string;
  href?: string;
  key?: string;
};

const chartColors = ["#2f80ed", "#10b981", "#f97316", "#8b5cf6", "#64748b", "#ef4444"];

const severityColors: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#d97706",
  low: "#10b981",
  unknown: "#94a3b8",
};

function incidentVolume(incident: Incident) {
  return incidentEventCount(incident);
}

function addToDistribution(map: Map<string, number>, label: string, value: number) {
  const key = label.trim() || "Unknown";
  map.set(key, (map.get(key) || 0) + value);
}

function topDistribution(
  incidents: Incident[],
  getLabel: (incident: Incident) => string | null | undefined,
  limit = 6,
  hrefFor?: (label: string) => string,
) {
  const map = new Map<string, number>();
  incidents.forEach((incident) => addToDistribution(map, getLabel(incident) || "Unknown", incidentVolume(incident)));
  return Array.from(map.entries())
    .map(([label, value], index) => ({
      label: labelValue(label),
      value,
      color: chartColors[index % chartColors.length],
      href: hrefFor?.(label),
      key: normalizeValue(label),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function EmptyChart({ children = "No incident data available." }: { children?: string }) {
  return <div className="chart-empty">{children}</div>;
}

function HorizontalBarList({ data }: { data: ChartDatum[] }) {
  const max = Math.max(...data.map((item) => item.value), 1);
  if (!data.length) {
    return <EmptyChart />;
  }

  return (
    <div className="horizontal-chart">
      {data.map((item) => (
        <Link className="horizontal-row horizontal-row-link" href={item.href || "#"} key={item.label}>
          <span className="horizontal-label">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </span>
          <span className="horizontal-track">
            <span
              className="horizontal-fill"
              style={{ width: `${Math.max(4, (item.value / max) * 100)}%`, background: item.color || "#2f80ed" }}
            />
          </span>
        </Link>
      ))}
    </div>
  );
}

function DonutChart({ data }: { data: ChartDatum[] }) {
  const positiveData = data.filter((item) => item.value > 0);
  const total = positiveData.reduce((sum, item) => sum + item.value, 0);
  const circumference = 2 * Math.PI * 38;

  if (!total) {
    return <EmptyChart />;
  }

  const segments = positiveData.map((item, index) => {
    const length = (item.value / total) * circumference;
    const offset = positiveData
      .slice(0, index)
      .reduce((sum, previous) => sum + (previous.value / total) * circumference, 0);
    return { ...item, length, offset };
  });

  return (
    <div className="donut-chart">
      <svg viewBox="0 0 96 96" aria-label="Distribution chart">
        <circle className="donut-base" cx="48" cy="48" r="38" />
        {segments.map((item, index) => (
          <a href={item.href || "#"} key={item.label}>
            <circle
              className="donut-segment"
              cx="48"
              cy="48"
              r="38"
              stroke={item.color || chartColors[index % chartColors.length]}
              strokeDasharray={`${item.length} ${circumference - item.length}`}
              strokeDashoffset={-item.offset}
            />
          </a>
        ))}
        <text x="48" y="45" textAnchor="middle">
          {total}
        </text>
        <text className="donut-caption" x="48" y="58" textAnchor="middle">
          events
        </text>
      </svg>
      <div className="chart-legend">
        {data.map((item, index) => (
          <Link className="chart-legend-link" href={item.href || "#"} key={item.label}>
            <i style={{ background: item.color || chartColors[index % chartColors.length] }} />
            {item.label} ({item.value})
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [allIncidents, setAllIncidents] = useState<Incident[]>([]);
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
      setAllIncidents(allIncidents);
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
      totalAlertEvents: totalAlertEvents(allIncidents),
    };
  }, [allIncidents, incidents]);

  const severityDistribution = useMemo(() => {
    const distribution = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    allIncidents.forEach((incident) => {
      distribution[getSeverity(incident)] += incidentVolume(incident);
    });
    return distribution;
  }, [allIncidents]);

  const chartData = useMemo(() => {
    const severity = Object.entries(severityDistribution).map(([label, value]) => ({
      label: labelValue(label),
      value,
      color: severityColors[label],
      href: incidentFilterHref({ archived: "all", severity: label }),
      key: label,
    }));
    const decisions = topDistribution(
      allIncidents,
      (incident) => incident.decision || "Unknown",
      6,
      (label) => incidentFilterHref({ archived: "all", decision: normalizeValue(label) }),
    );
    return {
      mitre: mitreDistribution(allIncidents, 10).map((item, index) => ({
        ...item,
        color: chartColors[index % chartColors.length],
      })),
      agents: topDistribution(
        allIncidents,
        (incident) => incident.agent_name || "Unknown",
        6,
        (label) => incidentFilterHref({ archived: "all", agent: label }),
      ),
      severity,
      decisions,
    };
  }, [allIncidents, severityDistribution]);

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
              <Link className="metric-card metric-link" href="/incidents?archived=false">
                <span>Active total</span>
                <strong>{counts.total}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/incidents?archived=false&status=pending_human">
                <span>Pending</span>
                <strong>{counts.pending}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/incidents?archived=all&status=approved">
                <span>Approved</span>
                <strong>{counts.approved}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/incidents?archived=all&status=rejected">
                <span>Rejected</span>
                <strong>{counts.rejected}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/incidents?archived=all&status=processed">
                <span>Auto processed</span>
                <strong>{counts.processed}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/archive">
                <span>Archived</span>
                <strong>{archivedCount}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/incidents?archived=all">
                <span>Total incidents</span>
                <strong>{storedCount}</strong>
              </Link>
              <Link className="metric-card metric-link" href="/analytics/alerts">
                <span>Total alert events</span>
                <strong>{counts.totalAlertEvents}</strong>
              </Link>
            </section>

            <section className="dashboard-chart-grid" aria-label="Dashboard incident charts">
              <div className="panel chart-panel chart-evolution">
                <AlertEvolutionExplorer compact titleLink />
              </div>

              <div className="panel chart-panel chart-donut-panel chart-severity">
                <div className="section-head">
                  <h2>Severity Distribution</h2>
                  <span>Counted by alert events</span>
                </div>
                <DonutChart data={chartData.severity} />
              </div>

              <div className="panel chart-panel chart-secondary chart-mitre">
                <div className="section-head">
                  <h2>MITRE ATT&CK Distribution</h2>
                  <span>Top 10 techniques</span>
                </div>
                <HorizontalBarList data={chartData.mitre} />
                <div className="chart-footer">
                  <span>Event-weighted</span>
                  <Link href="/analytics/mitre">View all</Link>
                </div>
              </div>

              <div className="panel chart-panel chart-donut-panel chart-decision">
                <div className="section-head">
                  <h2>Decision Distribution</h2>
                  <span>Counted by alert events</span>
                </div>
                <DonutChart data={chartData.decisions} />
              </div>

              <div className="panel chart-panel chart-secondary chart-agents">
                <div className="section-head">
                  <h2>Top Agents</h2>
                  <span>Counted by alert events</span>
                </div>
                <HorizontalBarList data={chartData.agents} />
              </div>
            </section>

            <section className="panel severity-strip-panel">
              <div className="section-head">
                <h2>Stored Severity Summary</h2>
                <span>{storedCount} stored</span>
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
