package dispatch

import (
	"net/url"
	"testing"
)

// Authored for milestone 8; not executed during engineering.
func TestGoalsContract(t *testing.T) {
	client, calls := recorder(t, nil)
	if _, err := client.GoalMetrics("goal_1", url.Values{"broadcast_id": {"broadcast_1"}, "start_date": {"2026-09-01T00:00:00Z"}}); err != nil {
		t.Fatal(err)
	}
	request, err := url.Parse((*calls)[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if request.Path != "/goals/goal_1/metrics" || request.Query().Get("broadcast_id") != "broadcast_1" {
		t.Fatalf("request: %#v", (*calls)[0])
	}
	if _, err := client.UpdateGoal("goal_1", Map{"eligibility": nil, "window_days": 7}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.UpdateLibraryTemplates(); err != nil {
		t.Fatal(err)
	}
	if (*calls)[2].Path != "/brand/update-library" {
		t.Fatalf("path: %#v", (*calls)[2])
	}
}
