"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { Incident, listArchivedIncidents, unarchiveIncident } from "@/lib/api";
import { formatIncidentDate, getSeverity, labelValue, shortIncidentId } from "@/lib/incidents";

export default function ArchivePage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
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
                Refresh
              </button>
            </div>

            {notice ? <div className="alert success">{notice}</div> : null}
            {error ? <div className="alert error">{error}</div> : null}

            {loading ? (
              <div className="loading-panel">Loading archived incidents...</div>
            ) : incidents.length ? (
              <div className="incident-list">
                {incidents.map((incident) => (
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
                    </div>

                    {incident.archive_state?.reason ? (
                      <div className="incident-detail">
                        <p>
                          <strong>Reason:</strong> {incident.archive_state.reason}
                        </p>
                      </div>
                    ) : null}

                    <div className="action-row">
                      <button
                        className="button secondary"
                        onClick={() => handleUnarchive(incident.id)}
                        disabled={busyId === incident.id}
                      >
                        Unarchive
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">No archived incidents.</div>
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
