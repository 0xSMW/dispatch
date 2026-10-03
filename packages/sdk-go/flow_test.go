package dispatch

import (
	"encoding/json"
	"net/url"
	"reflect"
	"testing"
)

func TestRuleValueContracts(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		json  string
	}{
		{"omitted", nil, `{"type":"rule","field":"contact.plan","operator":"eq"}`},
		{"null", json.RawMessage("null"), `{"type":"rule","field":"contact.plan","operator":"eq","value":null}`},
		{"false", false, `{"type":"rule","field":"contact.plan","operator":"eq","value":false}`},
		{"zero", 0, `{"type":"rule","field":"contact.plan","operator":"eq","value":0}`},
		{"empty", "", `{"type":"rule","field":"contact.plan","operator":"eq","value":""}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(Rule{Type: "rule", Field: "contact.plan", Operator: "eq", Value: tc.value})
			if err != nil || string(raw) != tc.json {
				t.Fatalf("rule value: %s, %v", raw, err)
			}
		})
	}
}

func TestFlowConfigContracts(t *testing.T) {
	rule := Rule{Type: "rule", Field: "contact.activated", Operator: "eq", Value: false}
	branch := BranchConfig{Paths: []BranchPath{
		{Key: "free", Label: "Free", Rule: Rule{Type: "rule", Field: "contact.plan", Operator: "eq", Value: "free"}},
		{Key: "active", Label: "Active", Rule: Rule{Type: "and", Rules: []Rule{
			{Type: "rule", Field: "contact.score", Operator: "gte", Value: 0},
			{Type: "rule", Field: "event.isTrial", Operator: "eq", Value: true},
		}}},
	}}
	for _, scope := range []string{"next", "following"} {
		t.Run(scope, func(t *testing.T) {
			steps := []AutomationStep{
				{Key: "start", Type: "trigger", Config: AutomationTriggerConfig{Type: TriggerContactCreated}},
				{Key: "audience", Type: "filter", Config: FilterConfig{Rule: rule, Scope: scope}},
				{Key: "choose", Type: "branch", Config: branch},
				{Key: "end", Type: "exit", Config: ExitConfig{}},
			}
			connections := []AutomationConnection{
				{From: "start", To: "audience"},
				{From: "audience", To: "choose", Type: "default"},
				{From: "choose", To: "end", Type: "branch", Path: "free"},
				{From: "choose", To: "end", Type: "branch", Path: "active"},
				{From: "choose", To: "end", Type: "branch", Path: "otherwise"},
			}
			client, calls := recorder(t, nil)
			input := AutomationInput{Name: "Onboarding", Status: AutomationDisabled, Steps: steps, Connections: connections, Reentry: ReentryOnce}
			if _, err := client.CreateAutomation(input); err != nil {
				t.Fatal(err)
			}
			update := AutomationUpdate{Name: input.Name, Status: input.Status, Steps: &steps, Connections: &connections, Reentry: input.Reentry}
			if _, err := client.UpdateAutomation("a/1", update); err != nil {
				t.Fatal(err)
			}
			if _, err := client.DryRunAutomation("a/1", update); err != nil {
				t.Fatal(err)
			}
			for i, path := range []string{"/automations", "/automations/a%2F1", "/automations/a%2F1?dry_run=true"} {
				if (*calls)[i].Path != path {
					t.Fatalf("path: %s", (*calls)[i].Path)
				}
				if !reflect.DeepEqual((*calls)[i].Body, (*calls)[0].Body) {
					t.Fatalf("changed graph: %#v", (*calls)[i].Body)
				}
			}
			body := (*calls)[0].Body.(map[string]any)
			gotSteps := body["steps"].([]any)
			if !reflect.DeepEqual(gotSteps[3].(map[string]any)["config"], map[string]any{}) {
				t.Fatalf("exit config: %#v", gotSteps[3])
			}
			gotRule := gotSteps[1].(map[string]any)["config"].(map[string]any)["rule"].(map[string]any)
			if gotRule["value"] != false {
				t.Fatalf("lost boolean value: %#v", gotRule)
			}
			gotPaths := gotSteps[2].(map[string]any)["config"].(map[string]any)["paths"].([]any)
			if gotPaths[0].(map[string]any)["key"] != "free" || gotPaths[1].(map[string]any)["key"] != "active" {
				t.Fatalf("changed path order: %#v", gotPaths)
			}
			rules := gotPaths[1].(map[string]any)["rule"].(map[string]any)["rules"].([]any)
			if rules[0].(map[string]any)["value"] != float64(0) || rules[1].(map[string]any)["value"] != true {
				t.Fatalf("changed nested values: %#v", rules)
			}
			gotConnections := body["connections"].([]any)
			if _, present := gotConnections[0].(map[string]any)["path"]; present {
				t.Fatal("non-branch edge gained path")
			}
			for i, key := range []string{"free", "active", "otherwise"} {
				if gotConnections[i+2].(map[string]any)["path"] != key {
					t.Fatalf("lost path: %#v", gotConnections[i+2])
				}
			}
		})
	}
}

func TestFlowRunContracts(t *testing.T) {
	for _, tc := range []struct {
		status string
		reason *AutomationExitReason
	}{
		{"running", nil}, {"failed", nil}, {"completed", Ptr(ExitCompleted)},
		{"completed", Ptr(ExitExplicit)}, {"completed", Ptr(ExitFilter)},
		{"cancelled", Ptr(ExitStopped)}, {"cancelled", Ptr(ExitStranded)},
	} {
		t.Run(tc.status+"/"+stringValue(tc.reason), func(t *testing.T) {
			want := AutomationRun{
				Object: "automation_run", ID: "r/1", AutomationID: "a/1", Status: tc.status, ExitReason: tc.reason,
				Guards: []AutomationGuard{{Filter: "audience", Rule: Rule{Type: "rule", Field: "contact.activated", Operator: "eq", Value: false}}},
				Event:  Map{"id": "ev1", "name": "user.created", "email": nil},
				Steps: []AutomationRunStep{
					{Key: "choose", Type: "branch", Status: "completed", Output: Map{"path": "active"}},
					{Key: "send", Type: "send_email", Status: "completed", Output: Map{"exited": "filter", "filter": "audience"}},
				},
			}
			client, calls := recorder(t, map[string]canned{
				"GET /automations/a%2F1/runs/r%2F1":               {200, want},
				"GET /automations/a%2F1/runs?status=" + tc.status: {200, ListResponse[AutomationRun]{Object: "list", Data: []AutomationRun{want}}},
			})
			got, err := client.AutomationRun("a/1", "r/1")
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var typed AutomationRun
			if err := json.Unmarshal(raw, &typed); err != nil || !reflect.DeepEqual(typed, want) {
				t.Fatalf("run: %+v, %v", typed, err)
			}
			list, err := client.AutomationRuns("a/1", url.Values{"status": {tc.status}})
			if err != nil || len(list.Data) != 1 || !reflect.DeepEqual(list.Data[0]["guards"], got["guards"]) || !reflect.DeepEqual(list.Data[0]["exit_reason"], got["exit_reason"]) {
				t.Fatalf("list: %+v, %v", list, err)
			}
			if (*calls)[0].Path != "/automations/a%2F1/runs/r%2F1" {
				t.Fatal("IDs were not escaped")
			}
		})
	}
	empty := AutomationRun{Guards: []AutomationGuard{}}
	raw, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	var body Map
	if err := json.Unmarshal(raw, &body); err != nil || !reflect.DeepEqual(body["guards"], []any{}) {
		t.Fatalf("empty guards must be an array: %s, %v", raw, err)
	}
}

func stringValue(reason *AutomationExitReason) string {
	if reason == nil {
		return "null"
	}
	return string(*reason)
}

func TestFlowWebhookContracts(t *testing.T) {
	for _, tc := range []struct {
		state  string
		reason *AutomationExitReason
	}{
		{"ready", nil}, {"failed", nil}, {"done", Ptr(ExitCompleted)}, {"done", Ptr(ExitExplicit)},
		{"done", Ptr(ExitFilter)}, {"stopped", Ptr(ExitStopped)}, {"stopped", Ptr(ExitStranded)},
	} {
		want := AutomationRunEvent{AutomationID: "a1", RunID: "r1", State: tc.state, ExitReason: tc.reason}
		raw, err := json.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		var body Map
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		if _, exists := body["exit_reason"]; !exists {
			t.Fatal("nullable exit_reason must not be omitted")
		}
		var got AutomationRunEvent
		if err := json.Unmarshal(raw, &got); err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("event: %+v, %v", got, err)
		}
	}
}
