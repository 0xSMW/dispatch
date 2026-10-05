"""Authored for milestone 8 SDK validation; not run during engineering."""
import unittest
from unittest.mock import Mock
from dispatch import Dispatch


class FormsContract(unittest.TestCase):
    def test_management_preserves_false_null_and_id_paths(self):
        client = Dispatch(api_key="synthetic-key")
        client._request = Mock(return_value={})
        client.update_form("form_1", {"double_opt_in": False, "redirect_url": None})
        client._request.assert_called_with(
            "PATCH", "/forms/form_1", {"double_opt_in": False, "redirect_url": None}
        )
        client.forms(limit=10)
        client._request.assert_called_with("GET", "/forms?limit=10")
        client.delete_form("form_1")
        client._request.assert_called_with("DELETE", "/forms/form_1")
