"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { IncidentList } from "@/app/components/IncidentList";
import { Incident, listIncidentsPage } from "@/lib/api";
import { getSeverity, isCriticalDecisionIncident, isPendingIncident, labelValue } from "@/lib/incidents";

const PAGE_SIZE = 25;

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
  { value: "false", label: "Active" },
  { value: "true", label: "Archived" },
  { value: "all", label: "All" },
] as const;

const dateScopeOptions = [
  { value: "all", label: "All dates" },
  { value: "day", label: "Day" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
] as const;

const sortOptions = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "severity", label: "Severity priority" },
  { value: "level", label: "Rule level high to low" },
  { value: "confidence", label: "Confidence high to low" },
  { value: "status", label: "Status" },
] as const;

const archiveValues = archiveOptions.map((option) => option.value);
const statusValues = statusOptions.map((option) => option.value);
const severityValues = severityOptions.map((option) => option.value);
const classificationValues = classificationOptions.map((option) => option.value);
const decisionValues = decisionOptions.map((option) => option.value);
const dateScopeValues = dateScopeOptions.map((option) => option.value);
const sortValues = sortOptions.map((option) => option.value);

type StatusFilter = (typeof statusOptions)[number]["value"];
type SeverityFilter = (typeof severityOptions)[number]["value"];
type ClassificationFilter = (typeof classificationOptions)[number]["value"];
type DecisionFilter = (typeof decisionOptions)[number]["value"];
type LevelFilter = (typeof levelOptions)[number]["value"];
type ArchiveFilter = (typeof archiveOptions)[number]["value"];
type DateScope = (typeof dateScopeOptions)[number]["value"];
type SortKey = (typeof sortOptions)[number]["value"];
type SearchParamReader = { get(name: string): string | null };

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

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDateValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayDateValue() {
  return localDateValue(new Date());
}

function currentMonthValue() {
  return todayDateValue().slice(0, 7);
}

function currentYearValue() {
  return String(new Date().getFullYear());
}

function nextDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return "";
  }
  return localDateValue(new Date(year, month - 1, day + 1));
}

function nextMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) {
    return "";
  }
  const date = new Date(year, month, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function initialDateScope(params: SearchParamReader): DateScope {
  const requested = queryOption(params.get("date_scope"), dateScopeValues, "all");
  if (requested !== "all") {
    return requested;
  }
  if (params.get("date")) {
    return "day";
  }
  if (params.get("month")) {
    return "month";
  }
  if (params.get("year")) {
    return "year";
  }
  return "all";
}

function rangeFromDateScope(
  dateScope: DateScope,
  dateValue: string,
  monthValue: string,
  yearValue: string,
  fromFilter: string,
  toFilter: string,
) {
  if (fromFilter || toFilter) {
    return { from: fromFilter, to: toFilter };
  }
  if (dateScope === "day" && dateValue) {
    return { from: `${dateValue}T00:00:00`, to: `${nextDay(dateValue)}T00:00:00` };
  }
  if (dateScope === "month" && monthValue) {
    return { from: `${monthValue}-01T00:00:00`, to: `${nextMonth(monthValue)}-01T00:00:00` };
  }
  if (dateScope === "year" && yearValue) {
    const year = Number(yearValue);
    if (Number.isInteger(year) && year > 0) {
      return { from: `${year}-01-01T00:00:00`, to: `${year + 1}-01-01T00:00:00` };
    }
  }
  return { from: "", to: "" };
}

function mergeUniqueIncidents(existing: Incident[], incoming: Incident[]) {
  const seen = new Set(existing.map((incident) => incident.id));
  const unique = incoming.filter((incident) => {
    if (seen.has(incident.id)) {
      return false;
    }
    seen.add(incident.id);
    return true;
  });
  return [...existing, ...unique];
}

function buildIncidentUrl(params: {
  archiveFilter: ArchiveFilter;
  search: string;
  statusFilter: StatusFilter;
  severityFilter: SeverityFilter;
  classificationFilter: ClassificationFilter;
  decisionFilter: DecisionFilter;
  levelFilter: LevelFilter;
  mitreFilter: string;
  agentFilter: string;
  sortKey: SortKey;
  dateScope: DateScope;
  dateValue: string;
  monthValue: string;
  yearValue: string;
  fromFilter: string;
  toFilter: string;
}) {
  const search = new URLSearchParams();
  if (params.archiveFilter !== "false") search.set("archived", params.archiveFilter);
  if (params.search.trim()) search.set("q", params.search.trim());
  if (params.statusFilter !== "all") search.set("status", params.statusFilter);
  if (params.severityFilter !== "all") search.set("severity", params.severityFilter);
  if (params.classificationFilter !== "all") search.set("classification", params.classificationFilter);
  if (params.decisionFilter !== "all") search.set("decision", params.decisionFilter);
  if (params.levelFilter !== "all") search.set("rule_level", params.levelFilter);
  if (params.mitreFilter.trim()) search.set("mitre", params.mitreFilter.trim());
  if (params.agentFilter.trim()) search.set("agent", params.agentFilter.trim());
  if (params.sortKey !== "newest") search.set("sort", params.sortKey);
  if (params.dateScope !== "all") {
    search.set("date_scope", params.dateScope);
    if (params.dateScope === "day" && params.dateValue) search.set("date", params.dateValue);
    if (params.dateScope === "month" && params.monthValue) search.set("month", params.monthValue);
    if (params.dateScope === "year" && params.yearValue) search.set("year", params.yearValue);
  }
  if (params.fromFilter) search.set("from", params.fromFilter);
  if (params.toFilter) search.set("to", params.toFilter);
  const query = search.toString();
  return query ? `/incidents?${query}` : "/incidents";
}

function IncidentsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>(() =>
    queryOption(searchParams.get("archived"), archiveValues, "false"),
  );
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") || "");
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
  const [fromFilter, setFromFilter] = useState(() => searchParams.get("from") || "");
  const [toFilter, setToFilter] = useState(() => searchParams.get("to") || "");
  const [dateScope, setDateScope] = useState<DateScope>(() => initialDateScope(searchParams));
  const [dateValue, setDateValue] = useState(() => searchParams.get("date") || searchParams.get("from")?.slice(0, 10) || todayDateValue());
  const [monthValue, setMonthValue] = useState(() => searchParams.get("month") || searchParams.get("from")?.slice(0, 7) || currentMonthValue());
  const [yearValue, setYearValue] = useState(() => searchParams.get("year") || searchParams.get("from")?.slice(0, 4) || currentYearValue());
  const [sortKey, setSortKey] = useState<SortKey>(() => queryOption(searchParams.get("sort"), sortValues, "newest"));
  const [compact, setCompact] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const range = useMemo(
    () => rangeFromDateScope(dateScope, dateValue, monthValue, yearValue, fromFilter, toFilter),
    [dateScope, dateValue, fromFilter, monthValue, toFilter, yearValue],
  );

  const loadPage = useCallback(
    async (offset: number, replace: boolean) => {
      if (!replace && loadingMoreRef.current) {
        return;
      }
      const requestId = ++requestIdRef.current;
      loadingMoreRef.current = true;
      setError(null);
      if (replace) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const page = await listIncidentsPage({
          archived: archiveFilter,
          from: range.from,
          to: range.to,
          status: statusFilter,
          severity: severityFilter,
          classification: classificationFilter,
          decision: decisionFilter,
          rule_level: levelFilter,
          mitre: mitreFilter,
          agent: agentFilter,
          q: search,
          sort: sortKey,
          limit: PAGE_SIZE,
          offset,
        });
        if (requestId !== requestIdRef.current) {
          return;
        }
        setIncidents((current) => (replace ? page.items : mergeUniqueIncidents(current, page.items)));
        setTotal(page.total);
        setHasMore(page.has_more);
        setNextOffset(page.offset + page.items.length);
        setLastUpdated(new Date().toLocaleTimeString());
      } catch (err) {
        if (requestId === requestIdRef.current) {
          setError(err instanceof Error ? err.message : "Could not load incidents");
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
          loadingMoreRef.current = false;
        }
      }
    },
    [
      agentFilter,
      archiveFilter,
      classificationFilter,
      decisionFilter,
      levelFilter,
      mitreFilter,
      range.from,
      range.to,
      search,
      severityFilter,
      sortKey,
      statusFilter,
    ],
  );

  const refresh = useCallback(() => {
    void loadPage(0, true);
  }, [loadPage]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const applyParams = window.setTimeout(() => {
      const nextScope = initialDateScope(searchParams);
      const nextFrom = searchParams.get("from") || "";
      setArchiveFilter(queryOption(searchParams.get("archived"), archiveValues, "false"));
      setSearchInput(searchParams.get("q") || "");
      setSearch(searchParams.get("q") || "");
      setStatusFilter(queryOption(searchParams.get("status"), statusValues, "all"));
      setSeverityFilter(queryOption(searchParams.get("severity"), severityValues, "all"));
      setClassificationFilter(queryOption(searchParams.get("classification"), classificationValues, "all"));
      setDecisionFilter(queryOption(searchParams.get("decision"), decisionValues, "all"));
      setLevelFilter(queryLevel(searchParams.get("rule_level")));
      setMitreFilter(searchParams.get("mitre") || "");
      setAgentFilter(searchParams.get("agent") || "");
      setFromFilter(nextFrom);
      setToFilter(searchParams.get("to") || "");
      setDateScope(nextScope);
      setDateValue(searchParams.get("date") || nextFrom.slice(0, 10) || todayDateValue());
      setMonthValue(searchParams.get("month") || nextFrom.slice(0, 7) || currentMonthValue());
      setYearValue(searchParams.get("year") || nextFrom.slice(0, 4) || currentYearValue());
      setSortKey(queryOption(searchParams.get("sort"), sortValues, "newest"));
    }, 0);
    return () => window.clearTimeout(applyParams);
  }, [searchParams]);

  useEffect(() => {
    const nextUrl = buildIncidentUrl({
      archiveFilter,
      search,
      statusFilter,
      severityFilter,
      classificationFilter,
      decisionFilter,
      levelFilter,
      mitreFilter,
      agentFilter,
      sortKey,
      dateScope,
      dateValue,
      monthValue,
      yearValue,
      fromFilter,
      toFilter,
    });
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (currentUrl !== nextUrl) {
      router.replace(nextUrl, { scroll: false });
    }
  }, [
    agentFilter,
    archiveFilter,
    classificationFilter,
    dateScope,
    dateValue,
    decisionFilter,
    fromFilter,
    levelFilter,
    mitreFilter,
    monthValue,
    router,
    search,
    severityFilter,
    sortKey,
    statusFilter,
    toFilter,
    yearValue,
  ]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      setIncidents([]);
      setTotal(0);
      setHasMore(false);
      setNextOffset(0);
      void loadPage(0, true);
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && hasMore && !loading && !loadingMore) {
          void loadPage(nextOffset, false);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadPage, loading, loadingMore, nextOffset]);

  const summary = useMemo(() => {
    const severityDistribution = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    incidents.forEach((incident) => {
      severityDistribution[getSeverity(incident)] += 1;
    });

    return {
      loaded: incidents.length,
      pending: incidents.filter(isPendingIncident).length,
      criticalDecision: incidents.filter(isCriticalDecisionIncident).length,
      severityDistribution,
    };
  }, [incidents]);

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setStatusFilter("all");
    setSeverityFilter("all");
    setClassificationFilter("all");
    setDecisionFilter("all");
    setLevelFilter("all");
    setMitreFilter("");
    setAgentFilter("");
    setFromFilter("");
    setToFilter("");
    setDateScope("all");
    setDateValue(todayDateValue());
    setMonthValue(currentMonthValue());
    setYearValue(currentYearValue());
    setSortKey("newest");
    setArchiveFilter("false");
    router.replace("/incidents", { scroll: false });
  }

  const dateScopeLabel = dateScopeOptions.find((option) => option.value === dateScope)?.label || "All dates";
  const rangeHint =
    range.from || range.to
      ? `Date scope: ${dateScopeLabel}, ${range.from || "start"} to ${range.to || "now"}`
      : `Date scope: ${dateScopeLabel}`;

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
                <button className="button secondary" onClick={refresh} disabled={loading || loadingMore}>
                  {loading ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            <section className="metric-grid compact-metrics" aria-label="Loaded incident summary">
              <div className="metric-card compact">
                <span>Loaded incidents</span>
                <strong>{summary.loaded}</strong>
              </div>
              <div className="metric-card compact">
                <span>Loaded pending review</span>
                <strong>{summary.pending}</strong>
              </div>
              <div className="metric-card compact">
                <span>Loaded critical decisions</span>
                <strong>{summary.criticalDecision}</strong>
              </div>
            </section>

            <section className="metric-grid compact-metrics" aria-label="Loaded severity distribution">
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
                        value={searchInput}
                        onChange={(event) => setSearchInput(event.target.value)}
                        placeholder="Rule, agent, MITRE, classification, reasoning, action"
                      />
                    </label>
                    <label className="toggle-row">
                      <input checked={compact} onChange={(event) => setCompact(event.target.checked)} type="checkbox" />
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
                      <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}>
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
                      <select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as DecisionFilter)}>
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
                      Date scope
                      <select
                        value={dateScope}
                        onChange={(event) => {
                          setDateScope(event.target.value as DateScope);
                          setFromFilter("");
                          setToFilter("");
                        }}
                      >
                        {dateScopeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {dateScope === "day" ? (
                      <label className="field">
                        Day
                        <input
                          type="date"
                          value={dateValue}
                          onChange={(event) => {
                            setDateValue(event.target.value);
                            setFromFilter("");
                            setToFilter("");
                          }}
                        />
                      </label>
                    ) : null}
                    {dateScope === "month" ? (
                      <label className="field">
                        Month
                        <input
                          type="month"
                          value={monthValue}
                          onChange={(event) => {
                            setMonthValue(event.target.value);
                            setFromFilter("");
                            setToFilter("");
                          }}
                        />
                      </label>
                    ) : null}
                    {dateScope === "year" ? (
                      <label className="field">
                        Year
                        <input
                          min="1970"
                          max="9999"
                          type="number"
                          value={yearValue}
                          onChange={(event) => {
                            setYearValue(event.target.value);
                            setFromFilter("");
                            setToFilter("");
                          }}
                        />
                      </label>
                    ) : null}
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
                      <input value={mitreFilter} onChange={(event) => setMitreFilter(event.target.value)} placeholder="Password Guessing" />
                    </label>
                    <label className="field">
                      Agent
                      <input value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} placeholder="Win10" />
                    </label>
                  </div>

                  <div className="result-row">
                    <span>
                      Showing {incidents.length} of {total} incidents
                      <small>{rangeHint}</small>
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

                {loading && incidents.length === 0 ? (
                  <div className="loading-panel">Loading incidents...</div>
                ) : (
                  <>
                    <IncidentList
                      compact={compact}
                      detailed={!compact}
                      incidents={incidents}
                      onActionResult={(message, type) => setNotice({ message, type })}
                      onChanged={refresh}
                      user={user}
                    />
                    <div className="pagination-sentinel" ref={sentinelRef}>
                      {loadingMore ? "Loading more incidents..." : hasMore ? "Scroll to load more incidents" : incidents.length > 0 ? "All matching incidents loaded" : null}
                    </div>
                  </>
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
