package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"

	dispatch "github.com/dispatch/dispatch-go"
)

func main() {
	apiKey := os.Getenv("DISPATCH_API_KEY")
	if apiKey == "" {
		log.Fatal("DISPATCH_API_KEY is required")
	}
	client := dispatch.New(apiKey)
	response, err := client.Send(map[string]any{
		"from":    "hello@example.com",
		"to":      "go@example.com",
		"subject": "Go SDK smoke",
		"text":    "Sent through the local Dispatch API.",
	}, "go-example")
	if err != nil {
		log.Fatal(err)
	}

	data, _ := json.MarshalIndent(response, "", "  ")
	fmt.Println(string(data))
}
