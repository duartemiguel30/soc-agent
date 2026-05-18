from sqlalchemy import Column, String, Integer, DateTime
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
