"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { Incident, listIncidents } from "@/lib/api";
import { mitreDistribution, totalAlertEvents } from "@/lib/analytics";

export default function MitreAnalyticsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setIncidents(await listIncidents("all"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load MITRE analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(initialLoad);
  }, [refresh]);

  const totalEvents = useMemo(() => totalAlertEvents(incidents), [incidents]);
  const rows = useMemo(() => mitreDistribution(incidents).filter((item) => item.value > 0), [incidents]);

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Analytics</p>
                <h1>MITRE ATT&CK Distribution</h1>
              </div>
            </div>

            {error ? <div className="alert error">{error}</div> : null}

            <section className="panel analytics-panel">
              <div className="section-head">
                <h2>All Techniques</h2>
                <span>Counted by alert events</span>
              </div>

              {loading ? (
                <div className="loading-panel">Loading MITRE analytics...</div>
              ) : rows.length ? (
                <div className="analytics-table">
                  {rows.map((item) => {
                    const percentage = totalEvents ? (item.value / totalEvents) * 100 : 0;
                    return (
                      <Link className="analytics-row" href={item.href || "/incidents?archived=all"} key={item.label}>
                        <span className="analytics-row-main">
                          <strong>{item.label}</strong>
                          <span>{item.value} alert events</span>
                        </span>
                        <span className="analytics-row-percent">{percentage.toFixed(1)}%</span>
                        <span className="horizontal-track">
                          {percentage > 0 ? (
                            <span
                              className="horizontal-fill"
                              style={{ minWidth: "3px", width: `${Math.min(100, percentage)}%` }}
                            />
                          ) : null}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">No MITRE data is available in stored incidents.</div>
              )}
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
