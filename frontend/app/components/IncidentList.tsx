"use client";

import { approveIncident, Incident, rejectIncident } from "@/lib/api";
import {
  formatIncidentDate,
  getSeverity,
  isPendingIncident,
  labelValue,
  shortIncidentId,
} from "@/lib/incidents";
import { useState } from "react";

type IncidentListProps = {
  incidents: Incident[];
  onChanged?: () => Promise<void> | void;
  compact?: boolean;
  detailed?: boolean;
  onActionResult?: (message: string, type: "success" | "error") => void;
};

export function IncidentList({
  incidents,
  onChanged,
  compact = false,
  detailed = true,
  onActionResult,
}: IncidentListProps) {
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
      onActionResult?.(`Incident ${action === "approve" ? "approved" : "rejected"}.`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Incident action failed";
      setError(message);
      onActionResult?.(message, "error");
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
        const severity = getSeverity(incident);
        return (
          <article key={incident.id} className="incident-card">
            <div className="incident-head">
              <div className="incident-title-block">
                <span className="mono">#{shortIncidentId(incident.id)}</span>
                <h3>{incident.rule_description || `Rule ${incident.rule_id || "unknown"}`}</h3>
              </div>
              <div className="badge-row">
                <span className={`badge severity-${severity}`}>
                  {labelValue(incident.severity)}
                </span>
                <span className="badge">{labelValue(incident.status || "no status")}</span>
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
                {typeof incident.confidence === "number" ? `${incident.confidence}%` : "N/A"}
              </span>
              <span>
                <strong>Decision</strong>
                {labelValue(incident.decision || "N/A")}
              </span>
              <span>
                <strong>Created</strong>
                {formatIncidentDate(incident.created_at)}
              </span>
            </div>

            {!compact && detailed ? (
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
