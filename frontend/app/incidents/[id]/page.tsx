"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import {
  addIncidentNote,
  archiveIncident,
  approveIncident,
  getIncident,
  getIncidentPlaybook,
  getIncidentTimeline,
  Incident,
  IncidentActionEvent,
  IncidentNote,
  IncidentPlaybook,
  listIncidentActions,
  listIncidentNotes,
  PlaybookStep,
  rejectIncident,
  TimelineEvent,
  unarchiveIncident,
  updatePlaybookStep,
} from "@/lib/api";
import {
  formatIncidentDate,
  getSeverity,
  isPendingIncident,
  labelValue,
  shortIncidentId,
} from "@/lib/incidents";

const stepStatuses: PlaybookStep["status"][] = ["todo", "in_progress", "done", "skipped"];

function DetailRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value ?? "N/A"}</strong>
    </div>
  );
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const incidentId = params.id;
  const [incident, setIncident] = useState<Incident | null>(null);
  const [playbook, setPlaybook] = useState<IncidentPlaybook | null>(null);
  const [notes, setNotes] = useState<IncidentNote[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [actions, setActions] = useState<IncidentActionEvent[]>([]);
  const [noteBody, setNoteBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [incidentData, playbookData] = await Promise.all([
        getIncident(incidentId),
        getIncidentPlaybook(incidentId),
      ]);
      const [notesData, timelineData, actionsData] = await Promise.all([
        listIncidentNotes(incidentId),
        getIncidentTimeline(incidentId),
        listIncidentActions(incidentId),
      ]);
      setIncident(incidentData);
      setPlaybook(playbookData);
      setNotes(notesData);
      setTimeline(timelineData);
      setActions(actionsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load incident detail");
    } finally {
      setLoading(false);
    }
  }, [incidentId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(initialLoad);
  }, [refresh]);

  const pending = useMemo(() => (incident ? isPendingIncident(incident) : false), [incident]);

  async function handleStepChange(stepId: number, status: PlaybookStep["status"]) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await updatePlaybookStep(stepId, status);
      await refresh();
      setNotice("Playbook step updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update playbook step");
    } finally {
      setBusy(false);
    }
  }

  async function handleNoteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = noteBody.trim();
    if (!body) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await addIncidentNote(incidentId, body);
      setNoteBody("");
      await refresh();
      setNotice("Analyst note added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add note");
    } finally {
      setBusy(false);
    }
  }

  async function runIncidentAction(action: "approve" | "reject") {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      if (action === "approve") {
        await approveIncident(incidentId);
      } else {
        await rejectIncident(incidentId);
      }
      await refresh();
      setNotice(action === "approve" ? "Incident approved." : "Incident rejected.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incident action failed");
    } finally {
      setBusy(false);
    }
  }

  async function runArchiveAction(archived?: boolean) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      if (archived) {
        await unarchiveIncident(incidentId);
        setNotice("Incident restored to active views.");
      } else {
        await archiveIncident(incidentId);
        setNotice("Incident archived.");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Incident detail</p>
                <h1>{incident ? incident.rule_description || `Rule ${incident.rule_id || "unknown"}` : "Incident"}</h1>
              </div>
              <div className="toolbar">
                <Link className="button secondary" href="/incidents">
                  Back to incidents
                </Link>
                <button className="button secondary" onClick={refresh} disabled={busy || loading}>
                  Refresh
                </button>
              </div>
            </div>

            {notice ? <div className="alert success">{notice}</div> : null}
            {error ? <div className="alert error">{error}</div> : null}

            {loading || !incident ? (
              <div className="loading-panel">Loading incident detail...</div>
            ) : (
              <div className="detail-grid">
                <div className="detail-stack">
                  <section className="panel">
                    <div className="section-head">
                      <h2>Incident Overview</h2>
                      <div className="badge-row">
                        <span className={`badge severity-${getSeverity(incident)}`}>{labelValue(incident.severity)}</span>
                        <span className="badge">{labelValue(incident.status)}</span>
                      </div>
                    </div>
                    <div className="detail-list">
                      <DetailRow label="Incident ID" value={shortIncidentId(incident.id)} />
                      <DetailRow label="Agent" value={incident.agent_name} />
                      <DetailRow label="Rule ID" value={incident.rule_id} />
                      <DetailRow label="Rule level" value={incident.rule_level} />
                      <DetailRow label="Created" value={formatIncidentDate(incident.created_at)} />
                      <DetailRow
                        label="Archive state"
                        value={
                          incident.is_archived
                            ? `Archived ${formatIncidentDate(incident.archive_state?.archived_at)}`
                            : "Active"
                        }
                      />
                    </div>
                    {pending ? (
                      <div className="action-row" style={{ marginTop: 14 }}>
                        <button className="button primary" onClick={() => runIncidentAction("approve")} disabled={busy}>
                          Approve
                        </button>
                        <button className="button danger" onClick={() => runIncidentAction("reject")} disabled={busy}>
                          Reject
                        </button>
                      </div>
                    ) : null}
                    {incident.is_archived ||
                    (!pending && ["approved", "rejected", "processed"].includes((incident.status || "").toLowerCase())) ? (
                      <div className="action-row" style={{ marginTop: 14 }}>
                        <button
                          className="button secondary"
                          onClick={() => runArchiveAction(incident.is_archived)}
                          disabled={busy}
                        >
                          {incident.is_archived ? "Unarchive" : "Archive"}
                        </button>
                      </div>
                    ) : null}
                    {incident.archive_state?.reason ? (
                      <p className="section-subtitle" style={{ marginTop: 14 }}>
                        Archive reason: {incident.archive_state.reason}
                      </p>
                    ) : null}
                  </section>

                  <section className="panel">
                    <div className="section-head">
                      <h2>AI Analysis</h2>
                      <span>{typeof incident.confidence === "number" ? `${incident.confidence}% confidence` : "N/A"}</span>
                    </div>
                    <div className="detail-list">
                      <DetailRow label="Classification" value={labelValue(incident.classification)} />
                      <DetailRow label="Decision" value={labelValue(incident.decision)} />
                      <DetailRow label="MITRE technique" value={incident.mitre_technique} />
                      <div className="detail-row">
                        <span>Reasoning</span>
                        <p>{incident.reasoning || "No reasoning returned."}</p>
                      </div>
                      <div className="detail-row">
                        <span>Recommended action</span>
                        <p>{incident.recommended_action || "No recommended action returned."}</p>
                      </div>
                    </div>
                  </section>

                  <section className="panel">
                    <div className="section-head">
                      <h2>Analyst Notes</h2>
                      <span>{notes.length}</span>
                    </div>
                    <form className="note-form" onSubmit={handleNoteSubmit}>
                      <label className="field">
                        Add note
                        <textarea
                          value={noteBody}
                          onChange={(event) => setNoteBody(event.target.value)}
                          placeholder="Document analyst observations, evidence, or closure rationale."
                        />
                      </label>
                      <button className="button primary" disabled={busy || !noteBody.trim()} type="submit">
                        Add note
                      </button>
                    </form>
                    <div className="notes-list" style={{ marginTop: 14 }}>
                      {notes.length ? (
                        notes.map((note) => (
                          <article className="note-card" key={note.id}>
                            <span className="entry-meta">
                              {note.author || "unknown"} · {formatIncidentDate(note.created_at)}
                            </span>
                            <p>{note.body}</p>
                          </article>
                        ))
                      ) : (
                        <div className="empty-state">No analyst notes yet.</div>
                      )}
                    </div>
                  </section>
                </div>

                <div className="detail-stack">
                  <section className="panel">
                    <div className="section-head">
                      <div>
                        <h2>{playbook?.title || "Manual Playbook"}</h2>
                        {playbook?.summary ? <p className="section-subtitle">{playbook.summary}</p> : null}
                      </div>
                      <span>{labelValue(playbook?.status)}</span>
                    </div>
                    <div className="playbook-list">
                      {playbook?.steps.length ? (
                        playbook.steps.map((step) => (
                          <article className="playbook-step" key={step.id}>
                            <span className="step-order">{step.step_order}</span>
                            <div className="step-body">
                              <h3>{step.title}</h3>
                              {step.description ? <p>{step.description}</p> : null}
                              <span className="step-meta">
                                {step.is_required ? "Required" : "Optional"}
                                {step.completed_at
                                  ? ` · completed ${formatIncidentDate(step.completed_at)} by ${step.completed_by || "unknown"}`
                                  : ""}
                              </span>
                            </div>
                            <select
                              className="step-status-select"
                              value={step.status}
                              onChange={(event) =>
                                handleStepChange(step.id, event.target.value as PlaybookStep["status"])
                              }
                              disabled={busy}
                              aria-label={`Status for step ${step.step_order}`}
                            >
                              {stepStatuses.map((status) => (
                                <option key={status} value={status}>
                                  {labelValue(status)}
                                </option>
                              ))}
                            </select>
                          </article>
                        ))
                      ) : (
                        <div className="empty-state">No playbook steps found.</div>
                      )}
                    </div>
                  </section>

                  <section className="panel">
                    <div className="section-head">
                      <h2>Timeline</h2>
                      <span>{timeline.length}</span>
                    </div>
                    <div className="timeline-list">
                      {timeline.length ? (
                        timeline.map((event, index) => (
                          <article className={`timeline-entry source-${event.source}`} key={`${event.event_type}-${index}`}>
                            <span className="entry-meta">
                              {formatIncidentDate(event.timestamp)} · {labelValue(event.event_type)} ·{" "}
                              {event.actor || event.source}
                            </span>
                            <p>{event.message}</p>
                          </article>
                        ))
                      ) : (
                        <div className="empty-state">No timeline events found.</div>
                      )}
                    </div>
                  </section>

                  <section className="panel">
                    <div className="section-head">
                      <h2>Action History</h2>
                      <span>{actions.length}</span>
                    </div>
                    <div className="action-list">
                      {actions.length ? (
                        actions.map((event) => (
                          <article className="action-entry" key={event.id}>
                            <span className="entry-meta">
                              {formatIncidentDate(event.created_at)} · {labelValue(event.event_type)} ·{" "}
                              {event.actor || "system"}
                            </span>
                            <p>{event.message}</p>
                          </article>
                        ))
                      ) : (
                        <div className="empty-state">No action events recorded yet.</div>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
