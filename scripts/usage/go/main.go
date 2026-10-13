package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	dispatch "github.com/dispatch/dispatch-go"
)

var contactID string

func must[T any](value T, err error) T {
	if err != nil {
		fail("SDK request failed")
	}
	return value
}

func fail(message string) {
	body, _ := json.Marshal(map[string]any{"id": contactID, "error": message})
	fmt.Println(string(body))
	os.Exit(1)
}

func main() {
	if len(os.Args) != 2 {
		fail("Unique fixture marker required")
	}
	email := "usage-" + os.Args[1] + "@example.net"
	client := dispatch.New("")
	contact := must(client.CreateContact(dispatch.Map{"email": email, "first_name": "Usage Go", "last_name": os.Args[1]}))
	contactID = contact.ID
	if must(client.Contact(email)).ID != contactID {
		fail("Contact lookup mismatch")
	}
	listed := false
	for _, row := range must(client.Contacts(url.Values{"q": {email}, "limit": {"100"}})).Data {
		listed = listed || row.ID == contactID
	}
	if !listed {
		fail("Contact absent from list")
	}
	if must(client.DeleteContact(email))["deleted"] != true {
		fail("Contact deletion failed")
	}
	body, _ := json.Marshal(map[string]any{"id": contactID, "email": email, "listed": listed, "deleted": true})
	fmt.Println(string(body))
}
