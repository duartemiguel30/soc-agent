export type AdminUser = {
  id?: number;
  username: string;
  display_name?: string | null;
  role?: string;
  permissions?: string[];
  is_active?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  last_login_at?: string | null;
  created_by?: number | null;
  session?: {
    created_at?: string;
    last_activity_at?: string;
    expires_at?: string;
  };
};

export type AdminRole = "super_admin" | "admin" | "analyst" | "viewer";

export type AdminAuditEvent = {
  id: number;
  created_at?: string | null;
  actor_user_id?: number | null;
  actor_username?: string | null;
  actor_role?: string | null;
  event_type: string;
  target_type?: string | null;
  target_id?: string | null;
  target_username?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  success: boolean;
  details?: Record<string, unknown> | null;
};

export type AdminAuditEventsResponse = {
  items: AdminAuditEvent[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

export type AdminAuditMetrics = {
  successful_logins_24h: number;
  failed_logins_24h: number;
  active_sessions: number;
  disabled_users: number;
  total_users: number;
  actions_by_type_7d: Record<string, number>;
  actions_by_user_7d: Record<string, number>;
  permission_denied_7d: number;
  response_actions_7d: Record<string, number>;
};

export type AdminAuditEventParams = {
  event_type?: string;
  actor_username?: string;
  target_username?: string;
  success?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
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
  offset?: number;
  points: AlertEvolutionPoint[];
  total: number;
  data_start?: string | null;
  data_end?: string | null;
  can_go_previous: boolean;
  can_go_next: boolean;
};

export type AlertPeriodItem = {
  kind: "alert_event" | "incident_fallback";
  timestamp?: string | null;
  incident: Incident;
  event?: IncidentAlertEvent | null;
};

export type AlertPeriodResponse = {
  from?: string | null;
  to?: string | null;
  archived: "all" | "true" | "false";
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  items: AlertPeriodItem[];
};

export type IncidentPageResponse = {
  items: Incident[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

export type IncidentPageParams = {
  archived?: "all" | "true" | "false";
  from?: string | null;
  to?: string | null;
  status?: string;
  severity?: string;
  classification?: string;
  decision?: string;
  rule_level?: string;
  mitre?: string;
  agent?: string;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
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

export function hasPermission(user: AdminUser | null | undefined, permission: string) {
  return Boolean(user?.permissions?.includes(permission));
}

export function listAdminUsers() {
  return request<AdminUser[]>("/admin/users");
}

export function createAdminUser(payload: { username: string; display_name?: string; role: AdminRole; password: string }) {
  return request<AdminUser>("/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminUser(
  id: number,
  payload: { display_name?: string | null; role?: AdminRole; is_active?: boolean },
) {
  return request<AdminUser>(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function resetAdminUserPassword(id: number, password: string) {
  return request<{ ok: boolean }>(`/admin/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function disableAdminUser(id: number) {
  return request<AdminUser>(`/admin/users/${id}/disable`, { method: "POST" });
}

export function enableAdminUser(id: number) {
  return request<AdminUser>(`/admin/users/${id}/enable`, { method: "POST" });
}

export function listAdminAuditEvents(params: AdminAuditEventParams = {}) {
  const search = new URLSearchParams({
    limit: String(params.limit || 50),
    offset: String(params.offset || 0),
  });
  if (params.event_type?.trim()) search.set("event_type", params.event_type.trim());
  if (params.actor_username?.trim()) search.set("actor_username", params.actor_username.trim());
  if (params.target_username?.trim()) search.set("target_username", params.target_username.trim());
  if (params.success && params.success !== "all") search.set("success", params.success);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  return request<AdminAuditEventsResponse>(`/admin/audit-events?${search.toString()}`);
}

export function getAdminAuditMetrics() {
  return request<AdminAuditMetrics>("/admin/audit-metrics");
}

export function listIncidents(
  archived: "all" | "true" | "false" = "all",
  range?: { from?: string | null; to?: string | null },
) {
  const search = new URLSearchParams({ archived });
  if (range?.from) {
    search.set("from", range.from);
  }
  if (range?.to) {
    search.set("to", range.to);
  }
  return request<Incident[]>(`/incidents?${search.toString()}`);
}

export function listIncidentsPage(params: IncidentPageParams = {}) {
  const search = new URLSearchParams({
    archived: params.archived || "all",
    limit: String(params.limit || 25),
    offset: String(params.offset || 0),
  });
  if (params.from) {
    search.set("from", params.from);
  }
  if (params.to) {
    search.set("to", params.to);
  }
  if (params.status && params.status !== "all") {
    search.set("status", params.status);
  }
  if (params.severity && params.severity !== "all") {
    search.set("severity", params.severity);
  }
  if (params.classification && params.classification !== "all") {
    search.set("classification", params.classification);
  }
  if (params.decision && params.decision !== "all") {
    search.set("decision", params.decision);
  }
  if (params.rule_level && params.rule_level !== "all") {
    search.set("rule_level", params.rule_level);
  }
  if (params.mitre?.trim()) {
    search.set("mitre", params.mitre.trim());
  }
  if (params.agent?.trim()) {
    search.set("agent", params.agent.trim());
  }
  if (params.q?.trim()) {
    search.set("q", params.q.trim());
  }
  if (params.sort) {
    search.set("sort", params.sort);
  }
  return request<IncidentPageResponse>(`/incidents?${search.toString()}`);
}

export function getAlertEvolution(params: {
  range: AlertEvolutionRange;
  bucket: AlertEvolutionBucket;
  anchor?: string;
  offset?: number;
  archived?: "all" | "true" | "false";
}) {
  const search = new URLSearchParams({
    range: params.range,
    bucket: params.bucket,
    archived: params.archived || "all",
  });
  if (params.anchor) {
    search.set("anchor", params.anchor);
  } else if (typeof params.offset === "number" && params.offset !== 0) {
    search.set("offset", String(params.offset));
  }
  return request<AlertEvolutionResponse>(`/analytics/alert-evolution?${search.toString()}`);
}

export function getAlertPeriod(params: {
  from: string;
  to: string;
  archived?: "all" | "true" | "false";
  limit?: number;
  offset?: number;
}) {
  const search = new URLSearchParams({
    from: params.from,
    to: params.to,
    archived: params.archived || "all",
  });
  if (params.limit) {
    search.set("limit", String(params.limit));
  }
  if (params.offset) {
    search.set("offset", String(params.offset));
  }
  return request<AlertPeriodResponse>(`/analytics/alert-period?${search.toString()}`);
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
