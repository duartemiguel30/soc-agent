"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { AlertPeriodItem, AlertPeriodResponse, getAlertPeriod } from "@/lib/api";
import { formatIncidentDate, getSeverity, labelValue, shortIncidentId } from "@/lib/incidents";

const PAGE_SIZE = 25;

function formatPeriodTitle(bucket: string | null, start: string | null, end: string | null) {
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) {
    return "Alert Period";
  }
  if (bucket === "hour") {
    return `Alert Hour: ${startDate.toLocaleString()}`;
  }
  if (bucket === "day") {
    return `Alert Day: ${startDate.toLocaleDateString()}`;
  }
  if (bucket === "week" && endDate && !Number.isNaN(endDate.getTime())) {
    return `Alert Week: ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
  }
  if (bucket === "month") {
    return `Alert Month: ${startDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}`;
  }
  if (bucket === "year") {
    return `Alert Year: ${startDate.getFullYear()}`;
  }
  return "Alert Period";
}

function alertItemKey(item: AlertPeriodItem) {
  if (item.event?.id != null) {
    return `event-${item.event.id}`;
  }
  return `fallback-${item.incident.id}-${item.timestamp || "unknown"}`;
}

function mergeUniqueAlertItems(existing: AlertPeriodItem[], incoming: AlertPeriodItem[]) {
  const seen = new Set(existing.map(alertItemKey));
  const unique = incoming.filter((item) => {
    const key = alertItemKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return [...existing, ...unique];
}

function AlertPeriodContent() {
  const searchParams = useSearchParams();
  const bucket = searchParams.get("bucket");
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const [period, setPeriod] = useState<AlertPeriodResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadPeriodPage = useCallback(async (offset: number, replace: boolean) => {
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
      if (!start || !end) {
        throw new Error("Missing alert period range.");
      }
      const page = await getAlertPeriod({
        from: start,
        to: end,
        archived: "all",
        limit: PAGE_SIZE,
        offset,
      });
      if (requestId !== requestIdRef.current) {
        return;
      }
      setPeriod((current) => ({
        ...page,
        items: replace ? page.items : mergeUniqueAlertItems(current?.items || [], page.items),
      }));
      setHasMore(page.has_more);
      setNextOffset(page.offset + page.items.length);
    } catch (err) {
      if (requestId === requestIdRef.current) {
        setError(err instanceof Error ? err.message : "Could not load alert period");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    }
  }, [end, start]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      setPeriod(null);
      setHasMore(false);
      setNextOffset(0);
      void loadPeriodPage(0, true);
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadPeriodPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && hasMore && !loading && !loadingMore) {
          void loadPeriodPage(nextOffset, false);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadPeriodPage, loading, loadingMore, nextOffset]);

  const title = useMemo(() => formatPeriodTitle(bucket, start, end), [bucket, end, start]);
  const loadedCount = period?.items.length ?? 0;

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Analytics</p>
                <h1>{title}</h1>
              </div>
              <Link className="button secondary" href="/analytics/alerts">
                Back to timeline
              </Link>
            </div>

            {error ? <div className="alert error">{error}</div> : null}

            <section className="metric-grid compact-metrics" aria-label="Alert period summary">
              <div className="metric-card compact">
                <span>Total alert events</span>
                <strong>{period?.total ?? 0}</strong>
              </div>
              <div className="metric-card compact">
                <span>Archive scope</span>
                <strong>{labelValue(period?.archived || "all")}</strong>
              </div>
            </section>

            <section className="panel analytics-panel">
              <div className="section-head">
                <h2>Matching Alerts</h2>
                <span>{start && end ? `${formatIncidentDate(start)} - ${formatIncidentDate(end)}` : "Selected period"}</span>
              </div>
              <div className="alert-period-progress">
                Showing {loadedCount} of {period?.total ?? 0} alerts
              </div>

              {loading && !period ? (
                <div className="loading-panel">Loading alert period...</div>
              ) : period?.items.length ? (
                <>
                  <div className="detail-list">
                    {period.items.map((item) => {
                      const severity = getSeverity(item.incident);
                      return (
                        <Link
                          className="detail-row alert-drilldown-card"
                          href={`/incidents/${item.incident.id}`}
                          key={alertItemKey(item)}
                        >
                          <div className="alert-drilldown-card-head">
                            <div className="alert-drilldown-card-title">
                              <span>{formatIncidentDate(item.timestamp)}</span>
                              <strong>
                                #{shortIncidentId(item.incident.id)} -{" "}
                                {item.event?.summary || item.incident.rule_description || "Stored incident"}
                              </strong>
                            </div>
                            <div className="alert-drilldown-badges" aria-label="Alert classification">
                              {item.incident.mitre_technique ? (
                                <span className="badge attack-type">{item.incident.mitre_technique}</span>
                              ) : null}
                              <span className={`badge severity-${severity}`}>{labelValue(severity)}</span>
                            </div>
                          </div>
                          <p>
                            {labelValue(item.incident.decision)} / {item.incident.agent_name || "Unknown agent"}
                          </p>
                        </Link>
                      );
                    })}
                  </div>
                  <div className="pagination-sentinel" ref={sentinelRef}>
                    {loadingMore
                      ? "Loading more alerts..."
                      : hasMore
                        ? "Scroll to load more alerts"
                        : "All matching alerts loaded"}
                  </div>
                </>
              ) : (
                <div className="empty-state">No alert events match this period.</div>
              )}
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}

export default function AlertPeriodPage() {
  return (
    <Suspense fallback={<div className="loading-panel">Loading alert period...</div>}>
      <AlertPeriodContent />
    </Suspense>
  );
}
