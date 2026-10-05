package dispatch

import (
	"encoding/json"
	"testing"
)

// Authored for milestone 8; not executed during engineering.
func TestFormsContract(t *testing.T) {
	off := false
	raw, err := json.Marshal(FormInput{Name: "News", TopicIDs: []string{"topic_1"},
		FromEmail: "hello@example.com", AllowedOrigins: []string{"https://example.com"}, DoubleOptIn: &off})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if body["double_opt_in"] != false {
		t.Fatalf("false lost: %s", raw)
	}
	client, calls := recorder(t, nil)
	if _, err := client.UpdateForm("form_1", Map{"redirect_url": nil, "double_opt_in": false}); err != nil {
		t.Fatal(err)
	}
	if (*calls)[0].Path != "/forms/form_1" {
		t.Fatalf("path: %#v", (*calls)[0])
	}
}
