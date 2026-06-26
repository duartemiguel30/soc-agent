import { Incident } from "@/lib/api";

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

const severityRank: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

export function normalizeValue(value?: string | null) {
  return (value || "").trim().toLowerCase();
}

export function getSeverity(incident: Incident): Severity {
  const severity = normalizeValue(incident.severity);
  if (severity === "critical" || severity === "high" || severity === "medium" || severity === "low") {
    return severity;
  }
  return "unknown";
}

export function getSeverityRank(incident: Incident) {
  return severityRank[getSeverity(incident)];
}

export function isPendingIncident(incident: Incident) {
  const status = normalizeValue(incident.status);
  return status === "pending_human" || status === "pending";
}

export function isProcessedIncident(incident: Incident) {
  const status = normalizeValue(incident.status);
  const decision = normalizeValue(incident.decision);
  return status === "processed" || status.includes("processed") || decision === "auto_response";
}

export function isCriticalSeverityIncident(incident: Incident) {
  return getSeverity(incident) === "critical";
}

export function isCriticalDecisionIncident(incident: Incident) {
  return normalizeValue(incident.decision) === "critical_alert";
}

export function formatIncidentDate(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function incidentSearchText(incident: Incident) {
  return [
    incident.rule_description,
    incident.rule_id,
    incident.agent_name,
    incident.mitre_technique,
    incident.classification,
    incident.reasoning,
    incident.recommended_action,
    incident.status,
    incident.severity,
    incident.decision,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function shortIncidentId(id: string) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function labelValue(value?: string | null) {
  const normalized = (value || "unknown").replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
