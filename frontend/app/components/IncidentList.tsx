"use client";

import { AdminUser, archiveIncident, approveIncident, hasPermission, Incident, rejectIncident, unarchiveIncident } from "@/lib/api";
import {
  formatIncidentDate,
  getSeverity,
  hasDistinctLastSeen,
  incidentEventCount,
  isPendingIncident,
  labelValue,
  shortIncidentId,
} from "@/lib/incidents";
import Link from "next/link";
import { useState } from "react";

type IncidentListProps = {
  incidents: Incident[];
  onChanged?: () => Promise<void> | void;
  compact?: boolean;
  detailed?: boolean;
  onActionResult?: (message: string, type: "success" | "error") => void;
  linkToDetail?: boolean;
  showArchiveActions?: boolean;
  user?: AdminUser;
};

export function IncidentList({
  incidents,
  onChanged,
  compact = false,
  detailed = true,
  onActionResult,
  linkToDetail = true,
  showArchiveActions = true,
  user,
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

  async function runArchiveAction(id: string, archived?: boolean) {
    setBusyId(id);
    setError(null);
    try {
      if (archived) {
        await unarchiveIncident(id);
        onActionResult?.("Incident restored to active views.", "success");
      } else {
        await archiveIncident(id);
        onActionResult?.("Incident archived.", "success");
      }
      await onChanged?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Archive action failed";
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
        const status = (incident.status || "").toLowerCase();
        const eventCount = incidentEventCount(incident);
        const showLastSeen = hasDistinctLastSeen(incident);
        const canApprove = hasPermission(user, "approve_incidents");
        const canReject = hasPermission(user, "reject_incidents");
        const canManageArchive =
          hasPermission(user, "archive_incidents") &&
          showArchiveActions &&
          (incident.is_archived || (!pending && ["approved", "rejected", "processed"].includes(status)));
        return (
          <article key={incident.id} className="incident-card">
            <div className="incident-head">
              <div className="incident-title-block">
                <span className="mono">#{shortIncidentId(incident.id)}</span>
                <h3>
                  {linkToDetail ? (
                    <Link href={`/incidents/${incident.id}`}>
                      {incident.rule_description || `Rule ${incident.rule_id || "unknown"}`}
                    </Link>
                  ) : (
                    incident.rule_description || `Rule ${incident.rule_id || "unknown"}`
                  )}
                </h3>
              </div>
              <div className="badge-row">
                <span className={`badge severity-${severity}`}>
                  {labelValue(incident.severity)}
                </span>
                <span className="badge">{labelValue(incident.status || "no status")}</span>
                <span className="badge">{labelValue(incident.decision || "no decision")}</span>
                {eventCount > 1 ? <span className="badge">{eventCount} events</span> : null}
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
                <strong>Events</strong>
                {eventCount}
              </span>
              <span>
                <strong>First seen</strong>
                {formatIncidentDate(incident.first_seen || incident.created_at)}
              </span>
              {showLastSeen ? (
                <span>
                  <strong>Last seen</strong>
                  {formatIncidentDate(incident.last_seen)}
                </span>
              ) : null}
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
                {linkToDetail ? (
                  <Link className="button secondary" href={`/incidents/${incident.id}`}>
                    Open detail
                  </Link>
                ) : null}
                {canApprove ? (
                  <button
                    className="button primary"
                    onClick={() => runAction(incident.id, "approve")}
                    disabled={busyId === incident.id}
                  >
                    Approve
                  </button>
                ) : null}
                {canReject ? (
                  <button
                    className="button danger"
                    onClick={() => runAction(incident.id, "reject")}
                    disabled={busyId === incident.id}
                  >
                    Reject
                  </button>
                ) : null}
              </div>
            ) : null}

            {!pending && (linkToDetail || canManageArchive) ? (
              <div className="action-row">
                {linkToDetail ? (
                  <Link className="button secondary" href={`/incidents/${incident.id}`}>
                    Open detail
                  </Link>
                ) : null}
                {canManageArchive ? (
                  <button
                    className="button secondary"
                    onClick={() => runArchiveAction(incident.id, incident.is_archived)}
                    disabled={busyId === incident.id}
                  >
                    {incident.is_archived ? "Unarchive" : "Archive"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
