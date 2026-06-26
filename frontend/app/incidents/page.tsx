"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { IncidentList } from "@/app/components/IncidentList";
import { Incident, listIncidents } from "@/lib/api";
import {
  getSeverity,
  getSeverityRank,
  incidentLastSeenTime,
  incidentSearchText,
  isCriticalDecisionIncident,
  isPendingIncident,
  isProcessedIncident,
  labelValue,
  normalizeValue,
} from "@/lib/incidents";

const statusOptions = [
  { value: "all", label: "All statuses" },
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

const levelOptions = [
  { value: "all", label: "All rule levels" },
  { value: "gte12", label: "Rule level >= 12" },
  { value: "gte15", label: "Rule level >= 15" },
] as const;

const archiveOptions = [
  { value: "false", label: "Active incidents" },
  { value: "all", label: "Active + archived" },
  { value: "true", label: "Archived only" },
] as const;

const archiveValues = archiveOptions.map((option) => option.value);
const statusValues = statusOptions.map((option) => option.value);
const severityValues = severityOptions.map((option) => option.value);
const classificationValues = classificationOptions.map((option) => option.value);
const decisionValues = decisionOptions.map((option) => option.value);

const sortOptions = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "severity", label: "Severity priority" },
  { value: "level", label: "Rule level high to low" },
  { value: "confidence", label: "Confidence high to low" },
  { value: "status", label: "Status" },
] as const;

type StatusFilter = (typeof statusOptions)[number]["value"];
type SeverityFilter = (typeof severityOptions)[number]["value"];
type ClassificationFilter = (typeof classificationOptions)[number]["value"];
type DecisionFilter = (typeof decisionOptions)[number]["value"];
type LevelFilter = (typeof levelOptions)[number]["value"];
type ArchiveFilter = (typeof archiveOptions)[number]["value"];
type SortKey = (typeof sortOptions)[number]["value"];

function queryOption<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function queryLevel(value: string | null): LevelFilter {
  if (value === "gte15" || value === "15") {
    return "gte15";
  }
  if (value === "gte12" || value === "12") {
    return "gte12";
  }
  return "all";
}

function incidentTime(incident: Incident) {
  return incidentLastSeenTime(incident);
}

function compareText(a?: string | null, b?: string | null) {
  return (a || "").localeCompare(b || "");
}

function IncidentsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>(() =>
    queryOption(searchParams.get("archived"), archiveValues, "false"),
  );
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() =>
    queryOption(searchParams.get("status"), statusValues, "all"),
  );
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>(() =>
    queryOption(searchParams.get("severity"), severityValues, "all"),
  );
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>(() =>
    queryOption(searchParams.get("classification"), classificationValues, "all"),
  );
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>(() =>
    queryOption(searchParams.get("decision"), decisionValues, "all"),
  );
  const [levelFilter, setLevelFilter] = useState<LevelFilter>(() => queryLevel(searchParams.get("rule_level")));
  const [mitreFilter, setMitreFilter] = useState(() => searchParams.get("mitre") || "");
  const [agentFilter, setAgentFilter] = useState(() => searchParams.get("agent") || "");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [compact, setCompact] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setIncidents(await listIncidents(archiveFilter));
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load incidents");
    } finally {
      setLoading(false);
    }
  }, [archiveFilter]);

  useEffect(() => {
    const applyParams = window.setTimeout(() => {
      setArchiveFilter(queryOption(searchParams.get("archived"), archiveValues, "false"));
      setSearch(searchParams.get("q") || "");
      setStatusFilter(queryOption(searchParams.get("status"), statusValues, "all"));
      setSeverityFilter(queryOption(searchParams.get("severity"), severityValues, "all"));
      setClassificationFilter(queryOption(searchParams.get("classification"), classificationValues, "all"));
      setDecisionFilter(queryOption(searchParams.get("decision"), decisionValues, "all"));
      setLevelFilter(queryLevel(searchParams.get("rule_level")));
      setMitreFilter(searchParams.get("mitre") || "");
      setAgentFilter(searchParams.get("agent") || "");
    }, 0);
    return () => window.clearTimeout(applyParams);
  }, [searchParams]);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 10000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const filteredIncidents = useMemo(() => {
    const query = search.trim().toLowerCase();
    const mitreQuery = mitreFilter.trim().toLowerCase();
    const agentQuery = agentFilter.trim().toLowerCase();

    return incidents
      .filter((incident) => {
        if (query && !incidentSearchText(incident).includes(query)) {
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
        if (levelFilter === "gte12" && (incident.rule_level ?? 0) < 12) {
          return false;
        }
        if (levelFilter === "gte15" && (incident.rule_level ?? 0) < 15) {
          return false;
        }
        if (mitreQuery && !(incident.mitre_technique || "").toLowerCase().includes(mitreQuery)) {
          return false;
        }
        if (agentQuery && !(incident.agent_name || "").toLowerCase().includes(agentQuery)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortKey === "oldest") {
          return incidentTime(a) - incidentTime(b);
        }
        if (sortKey === "severity") {
          return getSeverityRank(b) - getSeverityRank(a) || incidentTime(b) - incidentTime(a);
        }
        if (sortKey === "level") {
          return (b.rule_level ?? 0) - (a.rule_level ?? 0) || incidentTime(b) - incidentTime(a);
        }
        if (sortKey === "confidence") {
          return (b.confidence ?? 0) - (a.confidence ?? 0) || incidentTime(b) - incidentTime(a);
        }
        if (sortKey === "status") {
          return compareText(a.status, b.status) || incidentTime(b) - incidentTime(a);
        }
        return incidentTime(b) - incidentTime(a);
      });
  }, [
    agentFilter,
    classificationFilter,
    decisionFilter,
    incidents,
    levelFilter,
    mitreFilter,
    search,
    severityFilter,
    sortKey,
    statusFilter,
  ]);

  const summary = useMemo(() => {
    const severityDistribution = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    incidents.forEach((incident) => {
      severityDistribution[getSeverity(incident)] += 1;
    });

    return {
      active: incidents.length,
      pending: incidents.filter(isPendingIncident).length,
      criticalDecision: incidents.filter(isCriticalDecisionIncident).length,
      severityDistribution,
    };
  }, [incidents]);

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setSeverityFilter("all");
    setClassificationFilter("all");
    setDecisionFilter("all");
    setLevelFilter("all");
    setMitreFilter("");
    setAgentFilter("");
    setSortKey("newest");
    setArchiveFilter("false");
    router.replace("/incidents");
  }

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page incidents-page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Triage queue</p>
                <h1>Incidents</h1>
              </div>
              <div className="toolbar">
                {lastUpdated ? <span className="muted">Updated {lastUpdated}</span> : null}
                <button className="button secondary" onClick={refresh} disabled={loading}>
                  {loading ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            <section className="metric-grid compact-metrics" aria-label="Active incident summary">
              <div className="metric-card compact">
                <span>Active incidents</span>
                <strong>{summary.active}</strong>
              </div>
              <div className="metric-card compact">
                <span>Pending review</span>
                <strong>{summary.pending}</strong>
              </div>
              <div className="metric-card compact">
                <span>Critical alert decisions</span>
                <strong>{summary.criticalDecision}</strong>
              </div>
            </section>

            <section className="metric-grid compact-metrics" aria-label="Active severity distribution">
              {Object.entries(summary.severityDistribution).map(([severity, count]) => (
                <div className="metric-card compact" key={severity}>
                  <span>{labelValue(severity)}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </section>

            <div className="workbench-layout">
              <details
                className="filter-panel sticky-controls"
                open={filtersOpen}
                onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
              >
                <summary>Search and filters</summary>
                <div className="filter-panel-body">
                  <div className="search-row">
                    <label className="field search-field">
                      Search incidents
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Rule, agent, MITRE, classification, reasoning, action"
                      />
                    </label>
                    <label className="toggle-row">
                      <input
                        checked={compact}
                        onChange={(event) => setCompact(event.target.checked)}
                        type="checkbox"
                      />
                      Compact cards
                    </label>
                  </div>

                  <div className="filter-grid">
                    <label className="field">
                      Archive scope
                      <select value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value as ArchiveFilter)}>
                        {archiveOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      Status
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
                      Rule level
                      <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as LevelFilter)}>
                        {levelOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
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
                    <label className="field">
                      MITRE technique
                      <input
                        value={mitreFilter}
                        onChange={(event) => setMitreFilter(event.target.value)}
                        placeholder="Password Guessing"
                      />
                    </label>
                    <label className="field">
                      Agent
                      <input
                        value={agentFilter}
                        onChange={(event) => setAgentFilter(event.target.value)}
                        placeholder="Win10"
                      />
                    </label>
                  </div>

                  <div className="result-row">
                    <span>
                      Showing {filteredIncidents.length} of {incidents.length} incidents
                    </span>
                    <button className="button ghost" onClick={clearFilters} type="button">
                      Clear filters
                    </button>
                  </div>
                </div>
              </details>

              <section className="results-panel" aria-label="Incident results">
                {notice ? <div className={`alert ${notice.type}`}>{notice.message}</div> : null}
                {error ? <div className="alert error">{error}</div> : null}

                {loading ? (
                  <div className="loading-panel">Loading incidents...</div>
                ) : (
                  <IncidentList
                    compact={compact}
                    detailed={!compact}
                    incidents={filteredIncidents}
                    onActionResult={(message, type) => setNotice({ message, type })}
                    onChanged={refresh}
                  />
                )}
              </section>
            </div>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}

export default function IncidentsPage() {
  return (
    <Suspense fallback={<div className="loading-panel">Loading incidents...</div>}>
      <IncidentsContent />
    </Suspense>
  );
}
