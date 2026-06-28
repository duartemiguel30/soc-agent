from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.sql import func
from db.database import Base

class Incident(Base):
    __tablename__ = "incidents"

    id = Column(String, primary_key=True)
    agent_name = Column(String)
    rule_id = Column(String)
    rule_description = Column(String)
    rule_level = Column(Integer)
    mitre_technique = Column(String)
    classification = Column(String)
    confidence = Column(Integer)
    severity = Column(String)
    reasoning = Column(String)
    recommended_action = Column(String)
    decision = Column(String)
    status = Column(String)
    created_at = Column(DateTime, default=func.now())


class IncidentObservable(Base):
    __tablename__ = "incident_observables"
    __table_args__ = (
        UniqueConstraint("incident_id", "key", "value", name="uq_incident_observable_key_value"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), index=True, nullable=False)
    key = Column(String, index=True, nullable=False)
    value = Column(Text, nullable=False)
    source = Column(String, default="wazuh", nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)


class IncidentAlertEvent(Base):
    __tablename__ = "incident_alert_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), index=True, nullable=False)
    correlation_key = Column(String, index=True, nullable=False)
    alert_hash = Column(String, unique=True, nullable=False)
    rule_id = Column(String, index=True, nullable=True)
    agent_name = Column(String, index=True, nullable=True)
    src_ip = Column(String, index=True, nullable=True)
    target_username = Column(String, index=True, nullable=True)
    event_timestamp = Column(DateTime, nullable=True)
    summary = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)


class AdminUser(Base):
    __tablename__ = "admin_users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    role = Column(String, default="admin", nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)
    last_login_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, ForeignKey("admin_users.id"), nullable=True)


class AdminSession(Base):
    __tablename__ = "admin_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    admin_user_id = Column(Integer, ForeignKey("admin_users.id"), index=True, nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    last_activity_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    user_agent = Column(String, nullable=True)
    client_ip = Column(String, nullable=True)


class AdminAuditEvent(Base):
    __tablename__ = "admin_audit_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(DateTime, default=func.now(), index=True, nullable=False)
    actor_user_id = Column(Integer, nullable=True)
    actor_username = Column(String, index=True, nullable=True)
    actor_role = Column(String, nullable=True)
    event_type = Column(String, index=True, nullable=False)
    target_type = Column(String, nullable=True)
    target_id = Column(String, nullable=True)
    target_username = Column(String, index=True, nullable=True)
    ip_address = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    success = Column(Boolean, default=True, nullable=False)
    details_json = Column(Text, nullable=True)


class IncidentPlaybook(Base):
    __tablename__ = "incident_playbooks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), unique=True, index=True, nullable=False)
    template_key = Column(String, nullable=False)
    title = Column(String, nullable=False)
    summary = Column(Text, nullable=True)
    status = Column(String, default="open", nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)
    completed_at = Column(DateTime, nullable=True)


class IncidentPlaybookStep(Base):
    __tablename__ = "incident_playbook_steps"
    __table_args__ = (
        UniqueConstraint("playbook_id", "step_order", name="uq_incident_playbook_step_order"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    playbook_id = Column(Integer, ForeignKey("incident_playbooks.id"), index=True, nullable=False)
    step_order = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    status = Column(String, default="todo", nullable=False)
    is_required = Column(Boolean, default=True, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    completed_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)


class IncidentNote(Base):
    __tablename__ = "incident_notes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), index=True, nullable=False)
    author = Column(String, nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)


class IncidentActionEvent(Base):
    __tablename__ = "incident_action_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), index=True, nullable=False)
    actor = Column(String, nullable=True)
    event_type = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    metadata_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)


class IncidentArchiveState(Base):
    __tablename__ = "incident_archive_states"

    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), unique=True, index=True, nullable=False)
    archived_at = Column(DateTime, nullable=False)
    archived_by = Column(String, nullable=True)
    reason = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
