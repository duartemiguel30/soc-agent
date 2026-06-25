"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import {
  IncidentList,
  isCriticalIncident,
  isPendingIncident,
  isProcessedIncident,
} from "@/app/components/IncidentList";
import { Incident, listIncidents } from "@/lib/api";

const filters = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "processed", label: "Processed" },
  { key: "critical", label: "Critical" },
] as const;

type FilterKey = (typeof filters)[number]["key"];

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setIncidents(await listIncidents());
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

  const filteredIncidents = useMemo(() => {
    return incidents.filter((incident) => {
      if (filter === "all") {
        return true;
      }
      if (filter === "pending") {
        return isPendingIncident(incident);
      }
      if (filter === "approved") {
        return incident.status === "approved";
      }
      if (filter === "rejected") {
        return incident.status === "rejected";
      }
      if (filter === "processed") {
        return isProcessedIncident(incident);
      }
      if (filter === "critical") {
        return isCriticalIncident(incident);
      }
      return true;
    });
  }, [filter, incidents]);

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Triage queue</p>
                <h1>Incidents</h1>
              </div>
              <button className="button secondary" onClick={refresh} disabled={loading}>
                Refresh
              </button>
            </div>

            <div className="filter-bar" role="tablist" aria-label="Incident filters">
              {filters.map((item) => (
                <button
                  key={item.key}
                  className={filter === item.key ? "filter-tab active" : "filter-tab"}
                  onClick={() => setFilter(item.key)}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>

            {error ? <div className="alert error">{error}</div> : null}

            {loading ? (
              <div className="loading-panel">Loading incidents...</div>
            ) : (
              <IncidentList incidents={filteredIncidents} onChanged={refresh} />
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
