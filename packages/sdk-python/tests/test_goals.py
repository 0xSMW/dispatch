"""Authored for milestone 8, not executed during engineering."""
import unittest
from unittest.mock import Mock
from dispatch import Dispatch


class GoalsContract(unittest.TestCase):
    def test_goal_metrics_and_nullable_eligibility(self):
        client = Dispatch(api_key="synthetic-key")
        client._request = Mock(return_value={})
        client.goal_metrics("goal_1", broadcast_id="broadcast_1")
        client._request.assert_called_with("GET", "/goals/goal_1/metrics?broadcast_id=broadcast_1")
        client.update_goal("goal_1", {"eligibility": None, "window_days": 7})
        client._request.assert_called_with("PATCH", "/goals/goal_1", {"eligibility": None, "window_days": 7})
        client.update_library_templates()
        client._request.assert_called_with("POST", "/brand/update-library")
