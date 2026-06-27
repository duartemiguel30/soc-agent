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
  createIncidentPlaybook,
  dryRunResponseAction,
  executeResponseAction,
  getIncident,
  getIncidentPlaybook,
  getIncidentTimeline,
  hasPermission,
  Incident,
  IncidentActionEvent,
  IncidentAlertEvent,
  IncidentNote,
  IncidentObservable,
  IncidentPlaybook,
  listIncidentAlertEvents,
  listIncidentObservables,
  listIncidentActions,
  listIncidentNotes,
  listIncidentResponseActions,
  PlaybookTemplateSuggestion,
  PlaybookStep,
  rejectIncident,
  ResponseAction,
  ResponseActionResult,
  TimelineEvent,
  unarchiveIncident,
  updatePlaybookStep,
} from "@/lib/api";
import {
  formatIncidentDate,
  getSeverity,
  incidentEventCount,
  isPendingIncident,
  labelValue,
  shortIncidentId,
} from "@/lib/incidents";

const stepStatuses: PlaybookStep["status"][] = ["todo", "in_progress", "done", "skipped"];

function dateTime(value?: string | null) {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

function DetailRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value ?? "N/A"}</strong>
    </div>
  );
}

function resultText(result?: ResponseActionResult | null) {
  if (!result) {
    return null;
  }
  if (result.message) {
    return result.message;
  }
  return JSON.stringify(result);
}

function actionStatusBadges(action: ResponseAction, group?: "suggested" | "available") {
  const badges: { label: string; className?: string }[] = [{ label: "Manual" }];
  if (action.automation_eligible) {
    badges.push({ label: "Automated", className: "available" });
  }
  if (action.automated_attempt) {
    badges.push({
      label: action.automated_attempt.status === "executed" ? "Auto executed" : "Auto dry-run",
      className: action.automated_attempt.status === "executed" ? "available" : undefined,
    });
  }
  if (action.availability_status === "protected") {
    badges.push({ label: "Protected", className: "risk-critical" });
  } else if (!action.available) {
    badges.push({ label: "Unavailable", className: "unavailable" });
  }
  if (action.mode === "dry_run" || action.dry_run?.mode === "dry_run") {
    badges.push({ label: "Dry-run" });
  }
  if (action.result_status === "executed") {
    badges.push({ label: "Executed", className: "available" });
  }
  if (group) {
    badges.push({ label: group === "suggested" ? "Suggested" : "Available", className: "available" });
  }
  return badges;
}

function isAdDryRunAction(action: ResponseAction) {
  return action.key === "disable_ad_account" && action.dry_run?.mode === "dry_run";
}

function actionGroups(actions: ResponseAction[]) {
  return {
    suggested: actions.filter((action) => action.available && action.category === "suggested"),
    available: actions.filter((action) => action.available && action.category !== "suggested"),
    unavailable: actions.filter((action) => !action.available),
  };
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const incidentId = params.id;
  const [incident, setIncident] = useState<Incident | null>(null);
  const [playbook, setPlaybook] = useState<IncidentPlaybook | null>(null);
  const [suggestedTemplate, setSuggestedTemplate] = useState<PlaybookTemplateSuggestion | null>(null);
  const [notes, setNotes] = useState<IncidentNote[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [actions, setActions] = useState<IncidentActionEvent[]>([]);
  const [observables, setObservables] = useState<IncidentObservable[]>([]);
  const [alertEvents, setAlertEvents] = useState<IncidentAlertEvent[]>([]);
  const [responseActions, setResponseActions] = useState<ResponseAction[]>([]);
  const [responseActionResults, setResponseActionResults] = useState<Record<string, ResponseActionResult>>({});
  const [responseActionReasons, setResponseActionReasons] = useState<Record<string, string>>({});
  const [responseActionConfirms, setResponseActionConfirms] = useState<Record<string, string>>({});
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
      const [
        notesData,
        timelineData,
        actionsData,
        observablesData,
        alertEventsData,
        responseActionsData,
      ] = await Promise.all([
        listIncidentNotes(incidentId),
        getIncidentTimeline(incidentId),
        listIncidentActions(incidentId),
        listIncidentObservables(incidentId),
        listIncidentAlertEvents(incidentId),
        listIncidentResponseActions(incidentId).catch(() => []),
      ]);
      setIncident(incidentData);
      setPlaybook(playbookData.playbook);
      setSuggestedTemplate(playbookData.suggested_template || null);
      setNotes(notesData);
      setTimeline([...timelineData].sort((a, b) => dateTime(b.timestamp) - dateTime(a.timestamp)));
      setActions([...actionsData].sort((a, b) => dateTime(b.created_at) - dateTime(a.created_at)));
      setObservables(observablesData);
      setAlertEvents([...alertEventsData].sort((a, b) => dateTime(b.event_timestamp || b.created_at) - dateTime(a.event_timestamp || a.created_at)));
      setResponseActions(responseActionsData);
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
  const groupedResponseActions = useMemo(() => actionGroups(responseActions), [responseActions]);

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

  async function handleCreatePlaybook() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await createIncidentPlaybook(incidentId);
      setPlaybook(response.playbook);
      setSuggestedTemplate(null);
      await refresh();
      setNotice(response.created ? "Manual playbook created." : "Existing manual playbook loaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create manual playbook");
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

  async function handleResponseActionDryRun(actionKey: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await dryRunResponseAction(incidentId, actionKey);
      setResponseActionResults((current) => ({ ...current, [actionKey]: result }));
      setNotice("Dry-run completed. No response action was executed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Response action dry-run failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleResponseActionExecute(action: ResponseAction) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const reason = (responseActionReasons[action.key] || "").trim();
      const confirm = (responseActionConfirms[action.key] || "").trim();
      const result = await executeResponseAction(incidentId, action.key, {
        confirm: action.key === "disable_ad_account" ? confirm : undefined,
        reason: reason || undefined,
      });
      setResponseActionResults((current) => ({ ...current, [action.key]: result }));
      await refresh();
      setNotice(
        result.mode === "dry_run"
          ? result.message || "Dry-run confirmation recorded. No real response action was executed."
          : result.message || "Response action completed.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Response action execution failed");
    } finally {
      setBusy(false);
    }
  }

  function setActionReason(actionKey: string, value: string) {
    setResponseActionReasons((current) => ({ ...current, [actionKey]: value }));
  }

  function setActionConfirm(actionKey: string, value: string) {
    setResponseActionConfirms((current) => ({ ...current, [actionKey]: value }));
  }

  function renderAvailableResponseAction(action: ResponseAction, group: "suggested" | "available", canExecute: boolean) {
    const latestResult = responseActionResults[action.key];
    const previewText = resultText(latestResult || action.dry_run);
    const isHighRisk = action.risk_level === "high" || action.risk_level === "critical";
    const needsAdConfirm = action.key === "disable_ad_account";
    const adDryRun = isAdDryRunAction(action);
    const reason = responseActionReasons[action.key] || "";
    const confirm = responseActionConfirms[action.key] || "";
    const executeDisabled = busy || (needsAdConfirm && (confirm !== "DISABLE_ACCOUNT" || !reason.trim()));

    return (
      <article className={`response-action-card ${group}`} key={action.key}>
        <div className="response-action-head">
          <div>
            <h3>{action.name}</h3>
            <p>{action.description}</p>
          </div>
          <div className="badge-row">
            <span className={`badge risk-${action.risk_level}`}>{labelValue(action.risk_level)}</span>
            {actionStatusBadges(action, group).map((badge) => (
              <span className={badge.className ? `badge ${badge.className}` : "badge"} key={badge.label}>
                {badge.label}
              </span>
            ))}
          </div>
        </div>
        <div className="response-action-meta">
          <span>Requires: {action.required_observables.map(labelValue).join(", ")}</span>
          <span>{action.suggested_reason || action.availability_reason}</span>
          {adDryRun ? <span>No AD account will be disabled in dry-run mode.</span> : null}
          {action.automation_eligible ? <span>Automation policy may run this action for matching new incidents.</span> : null}
          {action.automated_attempt ? (
            <span>
              Last automated attempt: {labelValue(action.automated_attempt.event_type || "automated")}{" "}
              {action.automated_attempt.created_at ? `at ${formatIncidentDate(action.automated_attempt.created_at)}` : ""}
            </span>
          ) : null}
        </div>
        {previewText ? <div className="dry-run-output">{previewText}</div> : null}
        {canExecute && needsAdConfirm && adDryRun ? (
          <div className="confirmation-grid">
            <label className="field">
              Confirmation
              <input
                value={confirm}
                onChange={(event) => setActionConfirm(action.key, event.target.value)}
                placeholder="DISABLE_ACCOUNT"
                disabled={busy}
              />
            </label>
            <label className="field">
              Analyst reason
              <input
                value={reason}
                onChange={(event) => setActionReason(action.key, event.target.value)}
                placeholder="Required before recording dry-run"
                disabled={busy}
              />
            </label>
          </div>
        ) : canExecute && isHighRisk ? (
          <label className="field">
            Analyst reason
            <input
              value={reason}
              onChange={(event) => setActionReason(action.key, event.target.value)}
              placeholder="Recommended for high-risk actions"
              disabled={busy}
            />
          </label>
        ) : null}
        <div className="action-row">
          <button className="button secondary" onClick={() => handleResponseActionDryRun(action.key)} disabled={busy}>
            Dry run
          </button>
          {canExecute ? (
            <button
              className={isHighRisk ? "button danger" : "button primary"}
              onClick={() => handleResponseActionExecute(action)}
              disabled={executeDisabled}
            >
              {adDryRun ? "Record dry-run confirmation" : "Execute"}
            </button>
          ) : null}
        </div>
      </article>
    );
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
                <div className="detail-column detail-column-left">
                  <section className="panel detail-overview-card">
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
                      <DetailRow label="Event count" value={incidentEventCount(incident)} />
                      <DetailRow label="First seen" value={formatIncidentDate(incident.first_seen || incident.created_at)} />
                      <DetailRow label="Last seen" value={formatIncidentDate(incident.last_seen || incident.created_at)} />
                      <DetailRow label="Correlation key" value={incident.correlation_key} />
                      <DetailRow
                        label="Archive state"
                        value={
                          incident.is_archived
                            ? `Archived ${formatIncidentDate(incident.archive_state?.archived_at)}`
                            : "Active"
                        }
                      />
                    </div>
                    {pending && (hasPermission(user, "approve_incidents") || hasPermission(user, "reject_incidents")) ? (
                      <div className="action-row" style={{ marginTop: 14 }}>
                        {hasPermission(user, "approve_incidents") ? (
                          <button className="button primary" onClick={() => runIncidentAction("approve")} disabled={busy}>
                            Approve
                          </button>
                        ) : null}
                        {hasPermission(user, "reject_incidents") ? (
                          <button className="button danger" onClick={() => runIncidentAction("reject")} disabled={busy}>
                            Reject
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {hasPermission(user, "archive_incidents") &&
                    (incident.is_archived ||
                      (!pending && ["approved", "rejected", "processed"].includes((incident.status || "").toLowerCase()))) ? (
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

                  <section className="panel detail-ai-card">
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

                  <section className="panel detail-observables-card">
                    <div className="section-head">
                      <h2>Observables</h2>
                      <span>{observables.length}</span>
                    </div>
                    <p className="section-subtitle">
                      Observables are concrete values extracted from the Wazuh/Sysmon alert, such as source IPs,
                      usernames, processes, hosts, or command lines. Response actions use these values when available.
                    </p>
                    <div className="observable-list">
                      {observables.length ? (
                        observables.map((observable) => (
                          <div className="observable-row" key={observable.id}>
                            <span>{labelValue(observable.key)}</span>
                            <strong>{observable.value}</strong>
                          </div>
                        ))
                      ) : (
                        <div className="empty-state">No observables extracted for this incident.</div>
                      )}
                    </div>
                  </section>

                  <section className="panel detail-notes-card">
                    <div className="section-head">
                      <h2>Analyst Notes</h2>
                      <span>{notes.length}</span>
                    </div>
                    {hasPermission(user, "add_notes") ? (
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
                    ) : null}
                    <div className="notes-list detail-scroll-list notes-scroll" style={{ marginTop: 14 }}>
                      {notes.length ? (
                        notes.map((note) => (
                          <article className="note-card" key={note.id}>
                            <span className="entry-meta">
                              {note.author || "unknown"} - {formatIncidentDate(note.created_at)}
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

                <div className="detail-column detail-column-right">
                  <section className="panel detail-playbook-card">
                    <div className="section-head">
                      <div>
                        <h2>{playbook?.title || "Manual Playbook"}</h2>
                        {playbook?.summary ? <p className="section-subtitle">{playbook.summary}</p> : null}
                        {!playbook && suggestedTemplate ? (
                          <p className="section-subtitle">
                            Suggested template: {suggestedTemplate.title}. {suggestedTemplate.summary}
                          </p>
                        ) : null}
                      </div>
                      <span>{playbook ? labelValue(playbook.status) : "Not created"}</span>
                    </div>
                    <div className="playbook-list detail-scroll-list playbook-scroll">
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
                                  ? ` - completed ${formatIncidentDate(step.completed_at)} by ${step.completed_by || "unknown"}`
                                  : ""}
                              </span>
                            </div>
                            <select
                              className="step-status-select"
                              value={step.status}
                              onChange={(event) =>
                                handleStepChange(step.id, event.target.value as PlaybookStep["status"])
                              }
                              disabled={busy || !hasPermission(user, "manage_playbooks")}
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
                        <div className="empty-state playbook-empty">
                          {suggestedTemplate ? (
                            <>
                              <p>
                                Viewing this incident is read-only. Create a manual playbook only when analyst response
                                work should begin.
                              </p>
                              <ul className="suggestion-list">
                                {suggestedTemplate.steps.map((step) => (
                                  <li key={step}>{step}</li>
                                ))}
                              </ul>
                              {hasPermission(user, "manage_playbooks") ? (
                                <button className="button primary" onClick={handleCreatePlaybook} disabled={busy}>
                                  Create manual playbook
                                </button>
                              ) : null}
                            </>
                          ) : (
                            "No playbook steps found."
                          )}
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="panel detail-alert-card">
                    <div className="section-head">
                      <h2>Alert Activity</h2>
                      <span>{incidentEventCount(incident)}</span>
                    </div>
                    <div className="detail-list">
                      <DetailRow label="Event count" value={incidentEventCount(incident)} />
                      <DetailRow label="First seen" value={formatIncidentDate(incident.first_seen || incident.created_at)} />
                      <DetailRow label="Last seen" value={formatIncidentDate(incident.last_seen || incident.created_at)} />
                    </div>
                    <div className="action-list detail-scroll-list alert-scroll" style={{ marginTop: 14 }}>
                      {alertEvents.length ? (
                        alertEvents.map((event) => (
                          <article className="action-entry" key={event.id}>
                            <span className="entry-meta">
                              {formatIncidentDate(event.event_timestamp || event.created_at)} - Rule{" "}
                              {event.rule_id || "unknown"} - {event.agent_name || "unknown agent"}
                            </span>
                            <p>{event.summary || "Correlated Wazuh alert event."}</p>
                            <span className="entry-meta">
                              Source IP: {event.src_ip || "N/A"} - User: {event.target_username || "N/A"}
                            </span>
                          </article>
                        ))
                      ) : (
                        <div className="empty-state">No correlated alert events recorded for this incident.</div>
                      )}
                    </div>
                  </section>

                  <section className="panel detail-timeline-card">
                    <div className="section-head">
                      <h2>Timeline</h2>
                      <span>{timeline.length}</span>
                    </div>
                    <p className="section-subtitle">
                      Newest first. Incident creation is when Wazuh data was stored; playbook, note, archive, approve,
                      and reject dates are analyst action times.
                    </p>
                    <div className="timeline-list detail-scroll-list timeline-scroll">
                      {timeline.length ? (
                        timeline.map((event, index) => (
                          <article className={`timeline-entry source-${event.source}`} key={`${event.event_type}-${index}`}>
                            <span className="entry-meta">
                              {formatIncidentDate(event.timestamp)} - {labelValue(event.event_type)} -{" "}
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

                  <section className="panel detail-history-card">
                    <div className="section-head">
                      <h2>Action History</h2>
                      <span>{actions.length}</span>
                    </div>
                    <p className="section-subtitle">Newest first. These are raw incident-specific action events.</p>
                    <div className="action-list detail-scroll-list history-scroll">
                      {actions.length ? (
                        actions.map((event) => (
                          <article className="action-entry" key={event.id}>
                            <span className="entry-meta">
                              {formatIncidentDate(event.created_at)} - {labelValue(event.event_type)} -{" "}
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

                  {hasPermission(user, "view_response_actions") ? (
                  <section className="panel detail-response-card">
                    <div className="section-head">
                      <h2>Response Actions</h2>
                      <span>{responseActions.length}</span>
                    </div>
                    <p className="section-subtitle">
                      Actions are shown by context. Suggested actions match incident evidence or AI recommendation text;
                      other available actions are possible but not specifically recommended.
                    </p>
                    <div className="response-action-groups">
                      <div className="response-action-group">
                        <h3>Suggested response actions</h3>
                        {groupedResponseActions.suggested.length ? (
                          <div className="response-action-list">
                            {groupedResponseActions.suggested.map((action) =>
                              renderAvailableResponseAction(action, "suggested", hasPermission(user, "execute_response_actions")),
                            )}
                          </div>
                        ) : (
                          <div className="empty-state compact">No response actions are specifically suggested for this incident.</div>
                        )}
                      </div>

                      {groupedResponseActions.available.length ? (
                        <div className="response-action-group secondary-group">
                          <h3>Other available actions</h3>
                          <div className="response-action-list">
                            {groupedResponseActions.available.map((action) =>
                              renderAvailableResponseAction(action, "available", hasPermission(user, "execute_response_actions")),
                            )}
                          </div>
                        </div>
                      ) : null}

                      {groupedResponseActions.unavailable.length ? (
                        <details className="unavailable-actions">
                          <summary>Unavailable actions ({groupedResponseActions.unavailable.length})</summary>
                          <div className="unavailable-action-list">
                            {groupedResponseActions.unavailable.map((action) => (
                              <div className="unavailable-action-row" key={action.key}>
                                <strong>{action.name}</strong>
                                <div className="badge-row">
                                  {actionStatusBadges(action).map((badge) => (
                                    <span className={badge.className ? `badge ${badge.className}` : "badge"} key={badge.label}>
                                      {badge.label}
                                    </span>
                                  ))}
                                </div>
                                <span>Unavailable: {action.availability_reason}</span>
                                <small>Requires: {action.required_observables.map(labelValue).join(", ")}</small>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </section>
                  ) : null}
                </div>
              </div>
            )}
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
