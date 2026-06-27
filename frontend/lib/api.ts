export type AdminUser = {
  username: string;
  role?: string;
  session?: {
    created_at?: string;
    expires_at?: string;
  };
};

export type Incident = {
  id: string;
  agent_name?: string | null;
  rule_id?: string | null;
  rule_description?: string | null;
  rule_level?: number | null;
  mitre_technique?: string | null;
  classification?: string | null;
  confidence?: number | null;
  severity?: string | null;
  reasoning?: string | null;
  recommended_action?: string | null;
  decision?: string | null;
  status?: string | null;
  created_at?: string | null;
  event_count?: number;
  first_seen?: string | null;
  last_seen?: string | null;
  correlation_key?: string | null;
  is_archived?: boolean;
  archive_state?: IncidentArchiveState | null;
};

export type IncidentAlertEvent = {
  id: number;
  incident_id: string;
  correlation_key: string;
  rule_id?: string | null;
  agent_name?: string | null;
  src_ip?: string | null;
  target_username?: string | null;
  event_timestamp?: string | null;
  summary?: string | null;
  created_at?: string | null;
};

export type AlertEvolutionRange = "24h" | "7d" | "1m" | "1y" | "all";

export type AlertEvolutionBucket = "hour" | "day" | "week" | "month" | "year";

export type AlertEvolutionPoint = {
  label: string;
  start: string;
  end: string;
  count: number;
};

export type AlertEvolutionResponse = {
  range: AlertEvolutionRange;
  bucket: AlertEvolutionBucket;
  archived: "all" | "true" | "false";
  window_start?: string | null;
  window_end?: string | null;
  window_label: string;
  mode?: "rolling" | "anchored";
  points: AlertEvolutionPoint[];
  total: number;
  data_start?: string | null;
  data_end?: string | null;
  can_go_previous: boolean;
  can_go_next: boolean;
};

export type IncidentArchiveState = {
  id: number;
  incident_id: string;
  archived_at?: string | null;
  archived_by?: string | null;
  reason?: string | null;
  created_at?: string | null;
};

export type ReportResponse = {
  report: string;
  incidents_analyzed?: number;
};

export type PlaybookStep = {
  id: number;
  playbook_id: number;
  step_order: number;
  title: string;
  description?: string | null;
  status: "todo" | "in_progress" | "done" | "skipped";
  is_required: boolean;
  completed_at?: string | null;
  completed_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type IncidentPlaybook = {
  id: number;
  incident_id: string;
  template_key: string;
  title: string;
  summary?: string | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  steps: PlaybookStep[];
};

export type PlaybookTemplateSuggestion = {
  key: string;
  title: string;
  summary?: string | null;
  steps: string[];
};

export type IncidentPlaybookResponse = {
  playbook: IncidentPlaybook | null;
  suggested_template?: PlaybookTemplateSuggestion | null;
};

export type CreateIncidentPlaybookResponse = {
  playbook: IncidentPlaybook;
  created: boolean;
};

export type IncidentNote = {
  id: number;
  incident_id: string;
  author?: string | null;
  body: string;
  created_at?: string | null;
};

export type IncidentActionEvent = {
  id: number;
  incident_id: string;
  actor?: string | null;
  event_type: string;
  message: string;
  metadata_json?: string | null;
  created_at?: string | null;
};

export type IncidentObservable = {
  id: number;
  incident_id: string;
  key: string;
  value: string;
  source?: string | null;
  created_at?: string | null;
};

export type ResponseActionResult = {
  ok?: boolean;
  mode?: string;
  target?: string;
  command?: string;
  message?: string;
  needs_human_review?: boolean;
  already_present?: boolean;
  reason?: string | null;
  [key: string]: unknown;
};

export type ResponseAction = {
  key: string;
  name: string;
  description: string;
  risk_level: "low" | "medium" | "high" | "critical" | string;
  required_observables: string[];
  available: boolean;
  availability_reason: string;
  needs_human_review?: boolean;
  dry_run?: ResponseActionResult | null;
  suggested?: boolean;
  suggested_reason?: string | null;
  category?: "suggested" | "available" | "unavailable" | string;
};

export type TimelineEvent = {
  timestamp?: string | null;
  source: "system" | "ai" | "analyst" | string;
  event_type: string;
  actor?: string | null;
  message: string;
  metadata_json?: string | null;
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const API_PREFIX = "/backend";

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.detail === "string") {
      return data.detail;
    }
    if (typeof data?.error === "string") {
      return data.error;
    }
    return JSON.stringify(data);
  } catch {
    return response.statusText || "Request failed";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }

  return response.json() as Promise<T>;
}

export function login(username: string, password: string) {
  return request<AdminUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export function getCurrentUser() {
  return request<AdminUser>("/auth/me");
}

export function listIncidents(archived: "all" | "true" | "false" = "all") {
  return request<Incident[]>(`/incidents?archived=${archived}`);
}

export function getAlertEvolution(params: {
  range: AlertEvolutionRange;
  bucket: AlertEvolutionBucket;
  anchor?: string;
  archived?: "all" | "true" | "false";
}) {
  const search = new URLSearchParams({
    range: params.range,
    bucket: params.bucket,
    archived: params.archived || "all",
  });
  if (params.anchor) {
    search.set("anchor", params.anchor);
  }
  return request<AlertEvolutionResponse>(`/analytics/alert-evolution?${search.toString()}`);
}

export function getIncident(id: string) {
  return request<Incident>(`/incidents/${id}`);
}

export function listPendingIncidents() {
  return request<Incident[]>("/incidents/pending");
}

export function listArchivedIncidents() {
  return request<Incident[]>("/incidents/archive");
}

export function approveIncident(id: string) {
  return request<{ incident_id: string; status: string; action?: string }>(`/incidents/${id}/approve`, {
    method: "POST",
  });
}

export function rejectIncident(id: string) {
  return request<{ incident_id: string; status: string }>(`/incidents/${id}/reject`, {
    method: "POST",
  });
}

export function archiveIncident(id: string, reason?: string) {
  return request<{ incident_id: string; is_archived: boolean; archive_state?: IncidentArchiveState }>(
    `/incidents/${id}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    },
  );
}

export function unarchiveIncident(id: string) {
  return request<{ incident_id: string; is_archived: boolean }>(`/incidents/${id}/unarchive`, {
    method: "POST",
  });
}

export function generateReport() {
  return request<ReportResponse>("/report");
}

export function getIncidentPlaybook(id: string) {
  return request<IncidentPlaybookResponse>(`/incidents/${id}/playbook`);
}

export function createIncidentPlaybook(id: string) {
  return request<CreateIncidentPlaybookResponse>(`/incidents/${id}/playbook`, {
    method: "POST",
  });
}

export function updatePlaybookStep(stepId: number, status: PlaybookStep["status"]) {
  return request<PlaybookStep>(`/playbook/steps/${stepId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function addIncidentNote(id: string, body: string) {
  return request<IncidentNote>(`/incidents/${id}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function listIncidentNotes(id: string) {
  return request<IncidentNote[]>(`/incidents/${id}/notes`);
}

export function getIncidentTimeline(id: string) {
  return request<TimelineEvent[]>(`/incidents/${id}/timeline`);
}

export function listIncidentActions(id: string) {
  return request<IncidentActionEvent[]>(`/incidents/${id}/actions`);
}

export function listIncidentObservables(id: string) {
  return request<IncidentObservable[]>(`/incidents/${id}/observables`);
}

export function listIncidentAlertEvents(id: string) {
  return request<IncidentAlertEvent[]>(`/incidents/${id}/alert-events`);
}

export function listIncidentResponseActions(id: string) {
  return request<ResponseAction[]>(`/incidents/${id}/response-actions`);
}

export function dryRunResponseAction(id: string, actionKey: string) {
  return request<ResponseActionResult>(`/incidents/${id}/response-actions/${actionKey}/dry-run`, {
    method: "POST",
  });
}

export function executeResponseAction(id: string, actionKey: string, body?: { confirm?: string; reason?: string }) {
  return request<ResponseActionResult>(`/incidents/${id}/response-actions/${actionKey}/execute`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}
