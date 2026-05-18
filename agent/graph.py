from langgraph.graph import StateGraph, END
from agent.state import AlertState
from agent.nodes import (
    enrich_alert,
    analyze_with_ai,
    decide_action,
    route_decision,
    auto_response,
    human_review,
    critical_alert,
)

def build_graph() -> StateGraph:
    graph = StateGraph(AlertState)

    # Adiciona os nós
    graph.add_node("enrich_alert", enrich_alert)
    graph.add_node("analyze_with_ai", analyze_with_ai)
    graph.add_node("decide_action", decide_action)
    graph.add_node("auto_response", auto_response)
    graph.add_node("human_review", human_review)
    graph.add_node("critical_alert", critical_alert)

    # Define o fluxo
    graph.set_entry_point("enrich_alert")
    graph.add_edge("enrich_alert", "analyze_with_ai")
    graph.add_edge("analyze_with_ai", "decide_action")

    # Routing condicional após decide_action
    graph.add_conditional_edges(
        "decide_action",
        route_decision,
        {
            "auto_response": "auto_response",
            "human_review": "human_review",
            "critical_alert": "critical_alert",
        }
    )

    # Todos os nós terminais vão para END
    graph.add_edge("auto_response", END)
    graph.add_edge("human_review", END)
    graph.add_edge("critical_alert", END)

    return graph.compile()
