package dispatch

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type Client struct {
	APIKey     string
	BaseURL    string
	UserAgent  string
	HTTPClient *http.Client
}

type Error struct {
	Status int
	Body   any
}

func (e *Error) Error() string {
	return fmt.Sprintf("%d %v", e.Status, e.Body)
}

func New(apiKey string) *Client {
	if apiKey == "" {
		apiKey = os.Getenv("DISPATCH_API_KEY")
	}
	baseURL := os.Getenv("API_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3100"
	}
	return &Client{
		APIKey:    apiKey,
		BaseURL:   strings.TrimRight(baseURL, "/"),
		UserAgent: "dispatch-go/0.1.0",
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) Health() (map[string]any, error) {
	return c.request(http.MethodGet, "/health", nil, "", false)
}

func (c *Client) Setup() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/setup", nil, "", false)
}

func (c *Client) Send(email map[string]any, idempotencyKey string) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/emails", email, idempotencyKey, true)
}

func (c *Client) Batch(emails []map[string]any, idempotencyKey string) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/emails/batch", map[string]any{"emails": emails}, idempotencyKey, true)
}

func (c *Client) Emails() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/emails", nil, "", true)
}

func (c *Client) Email(id string) (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/emails/"+id, nil, "", true)
}

func (c *Client) Domains() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/domains", nil, "", true)
}

func (c *Client) CreateDomain(domain map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/domains", domain, "", true)
}

func (c *Client) Templates() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/templates", nil, "", true)
}

func (c *Client) CreateTemplate(template map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/templates", template, "", true)
}

func (c *Client) Contacts() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/contacts", nil, "", true)
}

func (c *Client) CreateContact(contact map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/contacts", contact, "", true)
}

func (c *Client) Webhooks() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/webhooks", nil, "", true)
}

func (c *Client) CreateWebhook(webhook map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/webhooks", webhook, "", true)
}

func (c *Client) Events() (map[string]any, error) {
	return c.request(http.MethodGet, "/v1/events", nil, "", true)
}

func (c *Client) CreateEvent(event map[string]any) (map[string]any, error) {
	return c.request(http.MethodPost, "/v1/events", event, "", true)
}

func (c *Client) request(method string, path string, body any, idempotencyKey string, auth bool) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		if c.APIKey == "" {
			return nil, fmt.Errorf("dispatch: API key is required")
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}

	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if len(data) > 0 {
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, err
		}
	} else {
		out = map[string]any{}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &Error{Status: res.StatusCode, Body: out}
	}
	return out, nil
}
