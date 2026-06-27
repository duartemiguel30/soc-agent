from response_actions.executors.block_ip import BlockSourceIpAction
from response_actions.executors.disable_ad_account import DisableAdAccountAction
from response_actions.executors.endpoint_isolation import IsolateEndpointAction
from response_actions.executors.host_context import CollectHostContextAction


def get_response_actions():
    return [
        BlockSourceIpAction(),
        DisableAdAccountAction(),
        IsolateEndpointAction(),
        CollectHostContextAction(),
    ]


def get_response_action(action_key: str):
    for action in get_response_actions():
        if action.key == action_key:
            return action
    return None

