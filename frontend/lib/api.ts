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
  is_archived?: boolean;
  archive_state?: IncidentArchiveState | null;
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
  return request<IncidentPlaybook>(`/incidents/${id}/playbook`);
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
