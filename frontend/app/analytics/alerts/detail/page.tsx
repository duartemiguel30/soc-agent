"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { AlertPeriodResponse, getAlertPeriod } from "@/lib/api";
import { formatIncidentDate, labelValue, shortIncidentId } from "@/lib/incidents";

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

function AlertPeriodContent() {
  const searchParams = useSearchParams();
  const bucket = searchParams.get("bucket");
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const [period, setPeriod] = useState<AlertPeriodResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPeriod = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      if (!start || !end) {
        throw new Error("Missing alert period range.");
      }
      setPeriod(await getAlertPeriod({ from: start, to: end, archived: "all" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load alert period");
    } finally {
      setLoading(false);
    }
  }, [end, start]);

  useEffect(() => {
    const initialLoad = window.setTimeout(loadPeriod, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadPeriod]);

  const title = useMemo(() => formatPeriodTitle(bucket, start, end), [bucket, end, start]);

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

              {loading ? (
                <div className="loading-panel">Loading alert period...</div>
              ) : period?.items.length ? (
                <div className="detail-list">
                  {period.items.map((item, index) => (
                    <Link className="detail-row" href={`/incidents/${item.incident.id}`} key={`${item.incident.id}-${item.event?.id || index}`}>
                      <span>{formatIncidentDate(item.timestamp)}</span>
                      <strong>
                        #{shortIncidentId(item.incident.id)} - {item.event?.summary || item.incident.rule_description || "Stored incident"}
                      </strong>
                      <p>
                        {labelValue(item.incident.severity)} / {labelValue(item.incident.decision)} / {item.incident.agent_name || "Unknown agent"}
                      </p>
                    </Link>
                  ))}
                </div>
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
