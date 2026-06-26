"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { Incident, listArchivedIncidents, listIncidents } from "@/lib/api";
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

function incidentTimeValue(incident: Incident) {
  const value = incident.last_seen || incident.created_at || incident.first_seen;
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

function addToDistribution(map: Map<string, number>, label: string, value: number) {
  const key = label.trim() || "Unknown";
  map.set(key, (map.get(key) || 0) + value);
}

function topDistribution(
  incidents: Incident[],
  getLabel: (incident: Incident) => string | null | undefined,
  limit = 6,
) {
  const map = new Map<string, number>();
  incidents.forEach((incident) => addToDistribution(map, getLabel(incident) || "Unknown", incidentVolume(incident)));
  return Array.from(map.entries())
    .map(([label, value], index) => ({ label: labelValue(label), value, color: chartColors[index % chartColors.length] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function timeBuckets(incidents: Incident[]): ChartDatum[] {
  const dated = incidents
    .map((incident) => ({ incident, time: incidentTimeValue(incident) }))
    .filter((item) => item.time > 0)
    .sort((a, b) => a.time - b.time);

  if (!dated.length) {
    return [];
  }

  const first = dated[0].time;
  const last = dated[dated.length - 1].time;
  const useHours = last - first <= 48 * 60 * 60 * 1000;
  const formatter = new Intl.DateTimeFormat(undefined, useHours ? { hour: "2-digit", day: "2-digit" } : { month: "short", day: "2-digit" });
  const map = new Map<string, number>();

  dated.forEach(({ incident, time }) => {
    const date = new Date(time);
    const bucket = useHours
      ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours())
      : new Date(date.getFullYear(), date.getMonth(), date.getDate());
    addToDistribution(map, formatter.format(bucket), incidentVolume(incident));
  });

  return Array.from(map.entries()).map(([label, value]) => ({ label, value, color: "#2f80ed" }));
}

function EmptyChart() {
  return <div className="chart-empty">No incident data available.</div>;
}

function VerticalBarChart({ data }: { data: ChartDatum[] }) {
  const max = Math.max(...data.map((item) => item.value), 1);
  if (!data.length) {
    return <EmptyChart />;
  }

  return (
    <div className="bar-chart" role="list">
      {data.map((item) => (
        <div className="bar-column" key={item.label} role="listitem">
          <div className="bar-track" aria-label={`${item.label}: ${item.value}`}>
            <span
              className="bar-fill"
              style={{ height: `${Math.max(8, (item.value / max) * 100)}%`, background: item.color || "#2f80ed" }}
            />
          </div>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function HorizontalBarList({ data }: { data: ChartDatum[] }) {
  const max = Math.max(...data.map((item) => item.value), 1);
  if (!data.length) {
    return <EmptyChart />;
  }

  return (
    <div className="horizontal-chart">
      {data.map((item) => (
        <div className="horizontal-row" key={item.label}>
          <div className="horizontal-label">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
          <div className="horizontal-track">
            <span
              className="horizontal-fill"
              style={{ width: `${Math.max(4, (item.value / max) * 100)}%`, background: item.color || "#2f80ed" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ data }: { data: ChartDatum[] }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const circumference = 2 * Math.PI * 38;

  if (!total) {
    return <EmptyChart />;
  }

  const segments = data.map((item, index) => {
    const length = (item.value / total) * circumference;
    const offset = data
      .slice(0, index)
      .reduce((sum, previous) => sum + (previous.value / total) * circumference, 0);
    return { ...item, length, offset };
  });

  return (
    <div className="donut-chart">
      <svg viewBox="0 0 96 96" aria-label="Distribution chart">
        <circle className="donut-base" cx="48" cy="48" r="38" />
        {segments.map((item, index) => (
          <circle
            className="donut-segment"
            cx="48"
            cy="48"
            key={item.label}
            r="38"
            stroke={item.color || chartColors[index % chartColors.length]}
            strokeDasharray={`${item.length} ${circumference - item.length}`}
            strokeDashoffset={-item.offset}
          />
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
          <span key={item.label}>
            <i style={{ background: item.color || chartColors[index % chartColors.length] }} />
            {item.label} ({item.value})
          </span>
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
    };
  }, [incidents]);

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
    }));
    const decisions = topDistribution(allIncidents, (incident) => incident.decision || "Unknown");
    return {
      eventEvolution: timeBuckets(allIncidents),
      mitre: topDistribution(allIncidents, (incident) => incident.mitre_technique || "Unknown"),
      agents: topDistribution(allIncidents, (incident) => incident.agent_name || "Unknown"),
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

            <section className="dashboard-chart-grid" aria-label="Dashboard incident charts">
              <div className="panel chart-panel chart-evolution">
                <div className="section-head">
                  <h2>Alert/Event Evolution</h2>
                  <span>By last seen</span>
                </div>
                <VerticalBarChart data={chartData.eventEvolution} />
              </div>

              <div className="chart-side-stack">
                <div className="panel chart-panel chart-donut-panel">
                  <div className="section-head">
                    <h2>Severity Distribution</h2>
                    <span>Weighted events</span>
                  </div>
                  <DonutChart data={chartData.severity} />
                </div>

                <div className="panel chart-panel chart-donut-panel">
                  <div className="section-head">
                    <h2>Decision Distribution</h2>
                    <span>Weighted events</span>
                  </div>
                  <DonutChart data={chartData.decisions} />
                </div>
              </div>

              <div className="panel chart-panel chart-secondary">
                <div className="section-head">
                  <h2>MITRE ATT&CK Distribution</h2>
                  <span>Top techniques</span>
                </div>
                <HorizontalBarList data={chartData.mitre} />
              </div>

              <div className="panel chart-panel chart-secondary">
                <div className="section-head">
                  <h2>Top Agents</h2>
                  <span>By event volume</span>
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
