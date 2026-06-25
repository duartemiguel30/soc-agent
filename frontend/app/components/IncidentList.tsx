"use client";

import { approveIncident, Incident, rejectIncident } from "@/lib/api";
import { useState } from "react";

type IncidentListProps = {
  incidents: Incident[];
  onChanged?: () => Promise<void> | void;
  compact?: boolean;
};

export function isPendingIncident(incident: Incident) {
  const status = (incident.status || "").toLowerCase();
  return status === "pending_human" || status === "pending";
}

export function isCriticalIncident(incident: Incident) {
  const severity = (incident.severity || "").toLowerCase();
  return severity.includes("critical") || (incident.rule_level ?? 0) >= 12;
}

export function isProcessedIncident(incident: Incident) {
  const status = (incident.status || "").toLowerCase();
  const decision = (incident.decision || "").toLowerCase();
  return status.includes("processed") || status.includes("auto") || decision.includes("auto");
}

function formatDate(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function shortId(id: string) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function IncidentList({ incidents, onChanged, compact = false }: IncidentListProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAction(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      if (action === "approve") {
        await approveIncident(id);
      } else {
        await rejectIncident(id);
      }
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incident action failed");
    } finally {
      setBusyId(null);
    }
  }

  if (!incidents.length) {
    return <div className="empty-state">No incidents match this view.</div>;
  }

  return (
    <div className="incident-list">
      {error ? <div className="alert error">{error}</div> : null}
      {incidents.map((incident) => {
        const pending = isPendingIncident(incident);
        return (
          <article key={incident.id} className="incident-card">
            <div className="incident-head">
              <div>
                <span className="mono">#{shortId(incident.id)}</span>
                <h3>{incident.rule_description || `Rule ${incident.rule_id || "unknown"}`}</h3>
              </div>
              <div className="badge-row">
                <span className={`badge ${isCriticalIncident(incident) ? "critical" : ""}`}>
                  {incident.severity || "unknown"}
                </span>
                <span className="badge">{incident.status || "no status"}</span>
              </div>
            </div>

            <div className={compact ? "incident-grid compact" : "incident-grid"}>
              <span>
                <strong>Rule</strong>
                {incident.rule_id || "N/A"}
              </span>
              <span>
                <strong>Level</strong>
                {incident.rule_level ?? "N/A"}
              </span>
              <span>
                <strong>Classification</strong>
                {incident.classification || "N/A"}
              </span>
              <span>
                <strong>Confidence</strong>
                {incident.confidence ?? "N/A"}%
              </span>
              <span>
                <strong>Decision</strong>
                {incident.decision || "N/A"}
              </span>
              <span>
                <strong>Created</strong>
                {formatDate(incident.created_at)}
              </span>
            </div>

            {!compact ? (
              <div className="incident-detail">
                <p>
                  <strong>Reasoning:</strong> {incident.reasoning || "No reasoning returned."}
                </p>
                <p>
                  <strong>Recommended action:</strong>{" "}
                  {incident.recommended_action || "No recommended action returned."}
                </p>
                {incident.mitre_technique ? (
                  <p>
                    <strong>MITRE:</strong> {incident.mitre_technique}
                  </p>
                ) : null}
              </div>
            ) : null}

            {pending ? (
              <div className="action-row">
                <button
                  className="button primary"
                  onClick={() => runAction(incident.id, "approve")}
                  disabled={busyId === incident.id}
                >
                  Approve
                </button>
                <button
                  className="button danger"
                  onClick={() => runAction(incident.id, "reject")}
                  disabled={busyId === incident.id}
                >
                  Reject
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
