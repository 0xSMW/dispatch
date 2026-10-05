"""Authored for milestone8 SDK validation; not run during engineering."""
import unittest
from unittest.mock import Mock
from dispatch import Dispatch


class IntegrationsContract(unittest.TestCase):
    def test_management_settings_rotation_and_history_paths(self):
        client = Dispatch(api_key="synthetic-key")
        client._request = Mock(return_value={})
        client.update_integration("int_1", {"settings": {"map_plan": False, "stripe_restricted_key": None}})
        client._request.assert_called_with("PATCH", "/integrations/int_1", {"settings": {"map_plan": False, "stripe_restricted_key": None}})
        client.rotate_integration("int_1")
        client._request.assert_called_with("POST", "/integrations/int_1/rotate", {})
        client.integration_deliveries("int_1", limit=20)
        client._request.assert_called_with("GET", "/integrations/int_1/deliveries?limit=20")
        client.delete_integration("int_1")
        client._request.assert_called_with("DELETE", "/integrations/int_1")
