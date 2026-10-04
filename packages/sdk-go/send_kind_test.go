package dispatch

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestSendKindConfigContracts(t *testing.T) {
	for _, config := range []SendEmailConfig{
		{Template: "receipt", Kind: Transactional},
		{Template: "newsletter", Kind: Marketing, TopicID: "topic_1"},
		{Template: "newsletter", Kind: Marketing},
		{Template: "receipt"},
		{Template: "newsletter", TopicID: "topic_1"},
	} {
		t.Run(string(config.Kind)+"/"+config.TopicID, func(t *testing.T) {
			client, calls := recorder(t, nil)
			steps := []AutomationStep{{Key: "send", Type: "send_email", Config: config}}
			input := AutomationInput{Name: "Typed", Status: AutomationDisabled, Steps: steps}
			if _, err := client.CreateAutomation(input); err != nil {
				t.Fatal(err)
			}
			update := AutomationUpdate{Name: input.Name, Status: input.Status, Steps: &steps}
			if _, err := client.UpdateAutomation("auto/1", update); err != nil {
				t.Fatal(err)
			}
			if _, err := client.DryRunAutomation("auto/1", update); err != nil {
				t.Fatal(err)
			}
			want := Map{"template": config.Template}
			if config.Kind != "" {
				want["kind"] = string(config.Kind)
			}
			if config.TopicID != "" {
				want["topic_id"] = config.TopicID
			}
			for i, path := range []string{"/automations", "/automations/auto%2F1", "/automations/auto%2F1?dry_run=true"} {
				call := (*calls)[i]
				if call.Path != path {
					t.Fatalf("path: %s", call.Path)
				}
				got := call.Body.(map[string]any)["steps"].([]any)[0].(map[string]any)["config"]
				if !reflect.DeepEqual(got, map[string]any(want)) {
					t.Fatalf("config: %#v, want %#v", got, want)
				}
			}
		})
	}
}

func TestNormalizedSendKindResponseContracts(t *testing.T) {
	steps := []any{
		map[string]any{"key": "receipt", "type": "send_email", "config": map[string]any{"template": "receipt", "kind": "transactional"}},
		map[string]any{"key": "newsletter", "type": "send_email", "config": map[string]any{"template": "newsletter", "kind": "marketing", "topic_id": "topic_1"}},
	}
	response := Automation{ID: "auto_1", Steps: steps}
	client, calls := recorder(t, map[string]canned{
		"POST /automations":       {200, response},
		"GET /automations/auto_1": {200, response},
	})
	legacy := AutomationInput{Name: "Legacy", Steps: []AutomationStep{
		{Key: "receipt", Type: "send_email", Config: SendEmailConfig{Template: "receipt"}},
	}}
	created, err := client.CreateAutomation(legacy)
	if err != nil || !reflect.DeepEqual(created.Steps, steps) {
		t.Fatalf("created: %+v, %v", created, err)
	}
	config := (*calls)[0].Body.(map[string]any)["steps"].([]any)[0].(map[string]any)["config"].(map[string]any)
	if _, exists := config["kind"]; exists {
		t.Fatal("legacy input gained kind")
	}
	got, err := client.Automation("auto_1")
	if err != nil || !reflect.DeepEqual(got.Steps, steps) {
		t.Fatalf("detail: %+v, %v", got, err)
	}
}

func TestTemplateKindContracts(t *testing.T) {
	for _, kind := range []SendKind{Transactional, Marketing} {
		t.Run(string(kind), func(t *testing.T) {
			template := Template{Object: "template", ID: "template_1", Name: "Template", Kind: kind}
			client, _ := recorder(t, map[string]canned{
				"GET /templates/template_1": {200, template},
				"GET /templates":            {200, ListResponse[Template]{Object: "list", Data: []Template{template}}},
			})
			detail, err := client.Template("template_1")
			if err != nil || detail.Kind != kind {
				t.Fatalf("detail: %+v, %v", detail, err)
			}
			list, err := client.Templates()
			if err != nil || len(list.Data) != 1 || list.Data[0].Kind != kind {
				t.Fatalf("list: %+v, %v", list, err)
			}
		})
	}
}

func TestSendKindDoesNotChangeOrdinarySendInput(t *testing.T) {
	input := SendInput{From: "hello@acme.com", To: "alex@acme.com", Subject: "Hello", Text: "Hello"}
	for _, topic := range []string{"", "topic_1"} {
		input.TopicID = topic
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		var body Map
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		if _, exists := body["kind"]; exists {
			t.Fatal("ordinary sends must not gain kind")
		}
		got, exists := body["topic_id"]
		if exists != (topic != "") || (exists && got != topic) {
			t.Fatalf("topic_id: %#v", body)
		}
	}
}
