import json
from datetime import datetime

from db.models import (
    IncidentActionEvent,
    IncidentPlaybook,
    IncidentPlaybookStep,
)
from playbooks.templates import select_template
from sqlalchemy.exc import IntegrityError


def utc_now() -> datetime:
    return datetime.utcnow()


def log_action_event(db, incident_id: str, actor: str | None, event_type: str, message: str, metadata=None):
    event = IncidentActionEvent(
        incident_id=incident_id,
        actor=actor,
        event_type=event_type,
        message=message,
        metadata_json=json.dumps(metadata) if metadata else None,
    )
    db.add(event)
    return event


def get_or_create_playbook(db, incident, actor: str | None = None):
    def load_existing():
        existing_playbook = (
            db.query(IncidentPlaybook)
            .filter(IncidentPlaybook.incident_id == incident.id)
            .order_by(IncidentPlaybook.created_at.asc())
            .first()
        )
        if not existing_playbook:
            return None, [], False
        existing_steps = (
            db.query(IncidentPlaybookStep)
            .filter(IncidentPlaybookStep.playbook_id == existing_playbook.id)
            .order_by(IncidentPlaybookStep.step_order.asc())
            .all()
        )
        return existing_playbook, existing_steps, False

    playbook = (
        db.query(IncidentPlaybook)
        .filter(IncidentPlaybook.incident_id == incident.id)
        .order_by(IncidentPlaybook.created_at.asc())
        .first()
    )
    created = False
    if playbook:
        return load_existing()

    template = select_template(incident)
    playbook = IncidentPlaybook(
        incident_id=incident.id,
        template_key=template.key,
        title=template.title,
        summary=template.summary,
        status="open",
    )
    db.add(playbook)
    try:
        db.flush()

        steps = []
        for index, title in enumerate(template.steps, start=1):
            step = IncidentPlaybookStep(
                playbook_id=playbook.id,
                step_order=index,
                title=title,
                description=None,
                status="todo",
                is_required=True,
            )
            db.add(step)
            steps.append(step)

        log_action_event(
            db,
            incident.id,
            actor,
            "playbook_created",
            f"Manual playbook created from template: {template.title}",
            {"template_key": template.key},
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        return load_existing()

    created = True
    return playbook, steps, created
