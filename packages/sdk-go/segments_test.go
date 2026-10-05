package dispatch

import (
	"encoding/json"
	"testing"
)

func TestSegmentRuleNullAndEngagementContract(t *testing.T) {
	rule := Rule{Type: "rule", Field: "email.opened", Operator: "eq", Value: false,
		Scope: &EngagementScope{AutomationID: "auto_1"}, Window: "30 days"}
	raw, err := json.Marshal(SegmentInput{Name: "Filter", Rule: rule})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	leaf := body["rule"].(map[string]any)
	if leaf["value"] != false || leaf["scope"].(map[string]any)["automation_id"] != "auto_1" {
		t.Fatalf("engagement shape: %s", raw)
	}
	for _, test := range []struct {
		rule    any
		present bool
	}{
		{nil, false}, {json.RawMessage("null"), true},
	} {
		raw, err := json.Marshal(SegmentUpdate{Rule: test.rule})
		if err != nil {
			t.Fatal(err)
		}
		body = nil
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		if _, present := body["rule"]; present != test.present {
			t.Fatalf("omission/null: %s", raw)
		}
	}
	client, calls := recorder(t, nil)
	if _, err := client.PreviewSegment(rule); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].Path != "/segments/preview" {
		t.Fatalf("preview: %#v", (*calls)[0])
	}
}
