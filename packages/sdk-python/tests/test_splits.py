"""Authored for the milestone8 Python SDK gate; not executed during engineering."""
import unittest
from unittest.mock import Mock
from dispatch import Dispatch


class SplitContracts(unittest.TestCase):
    def test_stored_split_metrics_and_guarded_winner_wire(self):
        client = Dispatch(api_key="synthetic", base_url="https://dispatch.example.test")
        client._request = Mock(return_value={"id": "a"})
        client.automation_split_metrics("a/1", "s/1", start_date="2026-09-01")
        client._request.assert_called_with("GET", "/automations/a%2F1/steps/s%2F1/metrics?start_date=2026-09-01")
        client.pick_automation_winner("a/1", "s/1", "b", 0)
        client._request.assert_called_with("POST", "/automations/a%2F1/steps/s%2F1/winner", {"variant": "b", "version": 0})


if __name__ == "__main__":
    unittest.main()
