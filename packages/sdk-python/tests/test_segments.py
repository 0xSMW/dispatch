import unittest
from unittest.mock import patch
from dispatch import Dispatch, SegmentInput, SegmentUpdateInput


class TestSegments(unittest.TestCase):
    def test_engagement_preview_and_omitted_null_conversion(self):
        client = Dispatch(api_key="synthetic-segment-key")
        rule = {"type": "rule", "field": "email.opened", "operator": "eq",
                "value": False, "scope": {"broadcast_id": "broadcast_1"}, "window": "30 days"}
        with patch.object(client, "_request", return_value={}) as request:
            client.create_segment({"name": "Filter", "rule": rule})
            client.update_segment("s/1", {"name": "Renamed"})
            client.update_segment("s/1", {"rule": None})
            client.preview_segment(rule)
        self.assertEqual([call.args[2] for call in request.call_args_list], [
            {"name": "Filter", "rule": rule}, {"name": "Renamed"}, {"rule": None}, {"rule": rule},
        ])
        self.assertEqual(request.call_args_list[-1].args[:2], ("POST", "/segments/preview"))
        self.assertIn("rule", SegmentInput.__optional_keys__)
        self.assertIn("rule", SegmentUpdateInput.__optional_keys__)
