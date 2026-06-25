from sqlalchemy import Boolean, Column, DateTime, Integer, String
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


class AdminUser(Base):
    __tablename__ = "admin_users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="admin", nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)
