"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { Incident, listArchivedIncidents, unarchiveIncident } from "@/lib/api";
import {
  formatIncidentDate,
  getSeverity,
  getSeverityRank,
  incidentSearchText,
  isPendingIncident,
  isProcessedIncident,
  labelValue,
  normalizeValue,
  shortIncidentId,
} from "@/lib/incidents";

const statusOptions = [
  { value: "all", label: "All original statuses" },
  { value: "pending_human", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "processed", label: "Processed" },
] as const;

const severityOptions = [
  { value: "all", label: "All severities" },
  { value: "critical", label: "Critical severity" },
  { value: "high", label: "High severity" },
  { value: "medium", label: "Medium severity" },
  { value: "low", label: "Low severity" },
  { value: "unknown", label: "Unknown severity" },
] as const;

const classificationOptions = [
  { value: "all", label: "All classifications" },
  { value: "true_positive", label: "True positive" },
  { value: "false_positive", label: "False positive" },
  { value: "unknown", label: "Unknown" },
] as const;

const decisionOptions = [
  { value: "all", label: "All decisions" },
  { value: "human_review", label: "Human review" },
  { value: "critical_alert", label: "Critical alert decision" },
  { value: "auto_response", label: "Auto response" },
] as const;

const sortOptions = [
  { value: "archived_newest", label: "Newest archived first" },
  { value: "archived_oldest", label: "Oldest archived first" },
  { value: "created_newest", label: "Incident created newest" },
  { value: "severity", label: "Severity priority" },
  { value: "level", label: "Rule level high to low" },
  { value: "confidence", label: "Confidence high to low" },
  { value: "status", label: "Status" },
] as const;

type StatusFilter = (typeof statusOptions)[number]["value"];
type SeverityFilter = (typeof severityOptions)[number]["value"];
type ClassificationFilter = (typeof classificationOptions)[number]["value"];
type DecisionFilter = (typeof decisionOptions)[number]["value"];
type SortKey = (typeof sortOptions)[number]["value"];

function incidentTime(value?: string | null) {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareText(a?: string | null, b?: string | null) {
  return (a || "").localeCompare(b || "");
}

function archiveSearchText(incident: Incident) {
  return [
    incidentSearchText(incident),
    incident.archive_state?.archived_by,
    incident.archive_state?.reason,
    incident.archive_state?.archived_at,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function ArchivePage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>("all");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [archivedByFilter, setArchivedByFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("archived_newest");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setIncidents(await listArchivedIncidents());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load archived incidents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(initialLoad);
  }, [refresh]);

  const archivedByOptions = useMemo(() => {
    return Array.from(
      new Set(incidents.map((incident) => incident.archive_state?.archived_by).filter(Boolean) as string[]),
    ).sort((a, b) => a.localeCompare(b));
  }, [incidents]);

  const metrics = useMemo(() => {
    return {
      total: incidents.length,
      critical: incidents.filter((incident) => getSeverity(incident) === "critical").length,
      high: incidents.filter((incident) => getSeverity(incident) === "high").length,
      approved: incidents.filter((incident) => normalizeValue(incident.status) === "approved").length,
      rejected: incidents.filter((incident) => normalizeValue(incident.status) === "rejected").length,
      processed: incidents.filter(isProcessedIncident).length,
      pending: incidents.filter(isPendingIncident).length,
    };
  }, [incidents]);

  const filteredIncidents = useMemo(() => {
    const query = search.trim().toLowerCase();

    return incidents
      .filter((incident) => {
        if (query && !archiveSearchText(incident).includes(query)) {
          return false;
        }
        if (statusFilter === "pending_human" && !isPendingIncident(incident)) {
          return false;
        }
        if (statusFilter === "processed" && !isProcessedIncident(incident)) {
          return false;
        }
        if (
          statusFilter !== "all" &&
          statusFilter !== "pending_human" &&
          statusFilter !== "processed" &&
          normalizeValue(incident.status) !== statusFilter
        ) {
          return false;
        }
        if (severityFilter !== "all" && getSeverity(incident) !== severityFilter) {
          return false;
        }
        if (classificationFilter !== "all" && normalizeValue(incident.classification) !== classificationFilter) {
          return false;
        }
        if (decisionFilter !== "all" && normalizeValue(incident.decision) !== decisionFilter) {
          return false;
        }
        if (archivedByFilter !== "all" && incident.archive_state?.archived_by !== archivedByFilter) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortKey === "archived_oldest") {
          return incidentTime(a.archive_state?.archived_at) - incidentTime(b.archive_state?.archived_at);
        }
        if (sortKey === "created_newest") {
          return incidentTime(b.created_at) - incidentTime(a.created_at);
        }
        if (sortKey === "severity") {
          return getSeverityRank(b) - getSeverityRank(a) || incidentTime(b.archive_state?.archived_at) - incidentTime(a.archive_state?.archived_at);
        }
        if (sortKey === "level") {
          return (b.rule_level ?? 0) - (a.rule_level ?? 0) || incidentTime(b.archive_state?.archived_at) - incidentTime(a.archive_state?.archived_at);
        }
        if (sortKey === "confidence") {
          return (b.confidence ?? 0) - (a.confidence ?? 0) || incidentTime(b.archive_state?.archived_at) - incidentTime(a.archive_state?.archived_at);
        }
        if (sortKey === "status") {
          return compareText(a.status, b.status) || incidentTime(b.archive_state?.archived_at) - incidentTime(a.archive_state?.archived_at);
        }
        return incidentTime(b.archive_state?.archived_at) - incidentTime(a.archive_state?.archived_at);
      });
  }, [archivedByFilter, classificationFilter, decisionFilter, incidents, search, severityFilter, sortKey, statusFilter]);

  async function handleUnarchive(id: string) {
    setBusyId(id);
    setNotice(null);
    setError(null);
    try {
      await unarchiveIncident(id);
      await refresh();
      setNotice("Incident restored to active views.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unarchive incident");
    } finally {
      setBusyId(null);
    }
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setSeverityFilter("all");
    setClassificationFilter("all");
    setDecisionFilter("all");
    setArchivedByFilter("all");
    setSortKey("archived_newest");
  }

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Lifecycle</p>
                <h1>Archive</h1>
              </div>
              <button className="button secondary" onClick={refresh} disabled={loading}>
                {loading ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            <section className="metric-grid compact-metrics" aria-label="Archive summary">
              <div className="metric-card compact">
                <span>Archived total</span>
                <strong>{metrics.total}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archived critical severity</span>
                <strong>{metrics.critical}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archived high severity</span>
                <strong>{metrics.high}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archived approved</span>
                <strong>{metrics.approved}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archived rejected</span>
                <strong>{metrics.rejected}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archived processed</span>
                <strong>{metrics.processed}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archived pending</span>
                <strong>{metrics.pending}</strong>
              </div>
            </section>

            <section className="controls-panel sticky-controls" aria-label="Archive controls">
              <div className="search-row">
                <label className="field search-field">
                  Search archive
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Rule, agent, MITRE, classification, archived by, reason"
                  />
                </label>
              </div>

              <div className="filter-grid archive-filter-grid">
                <label className="field">
                  Original status
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                    {statusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Severity
                  <select
                    value={severityFilter}
                    onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}
                  >
                    {severityOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Classification
                  <select
                    value={classificationFilter}
                    onChange={(event) => setClassificationFilter(event.target.value as ClassificationFilter)}
                  >
                    {classificationOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Decision
                  <select
                    value={decisionFilter}
                    onChange={(event) => setDecisionFilter(event.target.value as DecisionFilter)}
                  >
                    {decisionOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Archived by
                  <select value={archivedByFilter} onChange={(event) => setArchivedByFilter(event.target.value)}>
                    <option value="all">All analysts</option>
                    {archivedByOptions.map((actor) => (
                      <option key={actor} value={actor}>
                        {actor}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Sort
                  <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
                    {sortOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="result-row">
                <span>
                  Showing {filteredIncidents.length} of {incidents.length} archived incidents
                </span>
                <button className="button ghost" onClick={clearFilters} type="button">
                  Clear filters
                </button>
              </div>
            </section>

            {notice ? <div className="alert success">{notice}</div> : null}
            {error ? <div className="alert error">{error}</div> : null}

            {loading ? (
              <div className="loading-panel">Loading archived incidents...</div>
            ) : filteredIncidents.length ? (
              <div className="incident-list">
                {filteredIncidents.map((incident) => (
                  <article className="incident-card" key={incident.id}>
                    <div className="incident-head">
                      <div className="incident-title-block">
                        <span className="mono">#{shortIncidentId(incident.id)}</span>
                        <h3>
                          <Link href={`/incidents/${incident.id}`}>
                            {incident.rule_description || `Rule ${incident.rule_id || "unknown"}`}
                          </Link>
                        </h3>
                      </div>
                      <div className="badge-row">
                        <span className={`badge severity-${getSeverity(incident)}`}>
                          {labelValue(incident.severity)}
                        </span>
                        <span className="badge">{labelValue(incident.status)}</span>
                        <span className="badge">{labelValue(incident.decision)}</span>
                      </div>
                    </div>

                    <div className="incident-grid">
                      <span>
                        <strong>Classification</strong>
                        {labelValue(incident.classification)}
                      </span>
                      <span>
                        <strong>Archived at</strong>
                        {formatIncidentDate(incident.archive_state?.archived_at)}
                      </span>
                      <span>
                        <strong>Archived by</strong>
                        {incident.archive_state?.archived_by || "unknown"}
                      </span>
                      <span>
                        <strong>Created</strong>
                        {formatIncidentDate(incident.created_at)}
                      </span>
                      <span>
                        <strong>Rule level</strong>
                        {incident.rule_level ?? "N/A"}
                      </span>
                      <span>
                        <strong>Confidence</strong>
                        {typeof incident.confidence === "number" ? `${incident.confidence}%` : "N/A"}
                      </span>
                    </div>

                    {incident.archive_state?.reason ? (
                      <div className="incident-detail">
                        <p>
                          <strong>Reason:</strong> {incident.archive_state.reason}
                        </p>
                      </div>
                    ) : null}

                    <div className="action-row">
                      <Link className="button secondary" href={`/incidents/${incident.id}`}>
                        Open detail
                      </Link>
                      <button
                        className="button secondary"
                        onClick={() => handleUnarchive(incident.id)}
                        disabled={busyId === incident.id}
                      >
                        {busyId === incident.id ? "Restoring..." : "Unarchive"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">No archived incidents match the current filters.</div>
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
