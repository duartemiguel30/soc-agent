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
};

export type ReportResponse = {
  report: string;
  incidents_analyzed?: number;
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

export function listIncidents() {
  return request<Incident[]>("/incidents");
}

export function listPendingIncidents() {
  return request<Incident[]>("/incidents/pending");
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

export function generateReport() {
  return request<ReportResponse>("/report");
}
