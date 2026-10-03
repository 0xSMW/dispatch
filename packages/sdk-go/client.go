package dispatch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Client struct {
	APIKey     string
	BaseURL    string
	UserAgent  string
	HTTPClient *http.Client

	ctx context.Context
}

// WithContext returns a copy of the client whose requests carry ctx, so one call can be
// cancelled or given a deadline:
//
//	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
//	defer cancel()
//	email, err := client.WithContext(ctx).Send(input, "")
//
// The copy shares the HTTP client. Without a context, only HTTPClient.Timeout applies.
func (c *Client) WithContext(ctx context.Context) *Client {
	next := *c
	next.ctx = ctx
	return &next
}

// Field is a value in an update that can also be an explicit null. A nil *Field is left out of
// the request and the stored value stays as it is. Set gives a new value. Null clears it.
type Field[T any] struct {
	value T
	null  bool
}

// Set is an update field with a new value.
func Set[T any](value T) *Field[T] { return &Field[T]{value: value} }

// Null is an update field that clears the stored value.
func Null[T any]() *Field[T] { return &Field[T]{null: true} }

func (f Field[T]) MarshalJSON() ([]byte, error) {
	if f.null {
		return []byte("null"), nil
	}
	return json.Marshal(f.value)
}

// Ptr returns a pointer to value, for optional fields such as Unsubscribed, where false is a
// real value and must not be dropped.
func Ptr[T any](value T) *T { return &value }

// Error is returned for a non-2xx response. A request that never got a
// response comes back with Status 0, Name "application_error", and the
// transport error in Cause.
type Error struct {
	Status    int    `json:"status"`
	Name      string `json:"name"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Body      any    `json:"body"`
	Cause     error  `json:"-"`
}

func (e *Error) Error() string {
	if e.Status == 0 {
		return e.Message
	}
	if e.Message != "" {
		return fmt.Sprintf("%d %s", e.Status, e.Message)
	}
	return fmt.Sprintf("%d %v", e.Status, e.Body)
}

func (e *Error) Unwrap() error { return e.Cause }

type ListResponse[T any] struct {
	Object    string `json:"object"`
	Data      []T    `json:"data"`
	HasMore   bool   `json:"has_more"`
	RequestID string `json:"request_id,omitempty"`
}

type Deleted struct {
	Object  string `json:"object"`
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Email struct {
	Object      string       `json:"object,omitempty"`
	ID          string       `json:"id"`
	Emails      []SplitEmail `json:"emails,omitempty"`
	MessageID   *string      `json:"message_id,omitempty"`
	From        string       `json:"from,omitempty"`
	To          []string     `json:"to,omitempty"`
	Cc          []string     `json:"cc,omitempty"`
	Bcc         []string     `json:"bcc,omitempty"`
	ReplyTo     []string     `json:"reply_to,omitempty"`
	Subject     string       `json:"subject,omitempty"`
	HTML        *string      `json:"html,omitempty"`
	Text        *string      `json:"text,omitempty"`
	LastEvent   string       `json:"last_event,omitempty"`
	ScheduledAt *string      `json:"scheduled_at,omitempty"`
	Tags        []Tag        `json:"tags,omitempty"`
	CreatedAt   string       `json:"created_at,omitempty"`
}

type SplitEmail struct {
	ID string `json:"id"`
	To string `json:"to"`
}

type ContactActivity struct {
	Object       string  `json:"object"`
	ID           string  `json:"id"`
	Type         string  `json:"type"`
	ResourceID   *string `json:"resource_id"`
	Label        *string `json:"label"`
	EmailID      *string `json:"email_id"`
	AutomationID *string `json:"automation_id"`
	RunID        *string `json:"run_id"`
	CreatedAt    string  `json:"created_at"`
}

const (
	EmailUnsubscribed      = "email.unsubscribed"
	AutomationRunStarted   = "automation.run.started"
	AutomationRunCompleted = "automation.run.completed"
	AutomationRunFailed    = "automation.run.failed"
)

type AutomationRunEvent struct {
	AutomationID string  `json:"automation_id"`
	RunID        string  `json:"run_id"`
	ContactID    *string `json:"contact_id"`
	State        string  `json:"state"`
}

type BatchResponse struct {
	Data []struct {
		ID     string       `json:"id"`
		Emails []SplitEmail `json:"emails,omitempty"`
	} `json:"data"`
	Errors []struct {
		Index   int    `json:"index"`
		Message string `json:"message"`
	} `json:"errors,omitempty"`
}

type Domain struct {
	Object            string  `json:"object,omitempty"`
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Region            string  `json:"region"`
	Status            string  `json:"status"`
	CustomReturnPath  string  `json:"custom_return_path,omitempty"`
	OpenTracking      bool    `json:"open_tracking"`
	ClickTracking     bool    `json:"click_tracking"`
	TrackingSubdomain string  `json:"tracking_subdomain,omitempty"`
	TLS               string  `json:"tls,omitempty"`
	Capabilities      any     `json:"capabilities,omitempty"`
	Records           []any   `json:"records,omitempty"`
	CheckedAt         *string `json:"checked_at,omitempty"`
	CreatedAt         string  `json:"created_at,omitempty"`
}

type TemplateVariable struct {
	Key           string `json:"key"`
	Type          string `json:"type,omitempty"`
	FallbackValue any    `json:"fallback_value,omitempty"`
}

type Template struct {
	Object                 string             `json:"object,omitempty"`
	ID                     string             `json:"id"`
	Name                   string             `json:"name"`
	Alias                  *string            `json:"alias,omitempty"`
	From                   *string            `json:"from,omitempty"`
	ReplyTo                []string           `json:"reply_to,omitempty"`
	Subject                *string            `json:"subject,omitempty"`
	HTML                   *string            `json:"html,omitempty"`
	Text                   *string            `json:"text,omitempty"`
	Variables              []TemplateVariable `json:"variables,omitempty"`
	Status                 string             `json:"status,omitempty"`
	PublishedAt            *string            `json:"published_at,omitempty"`
	CurrentVersionID       *string            `json:"current_version_id,omitempty"`
	HasUnpublishedVersions bool               `json:"has_unpublished_versions,omitempty"`
	CreatedAt              string             `json:"created_at,omitempty"`
	UpdatedAt              string             `json:"updated_at,omitempty"`
}

type Contact struct {
	Object       string         `json:"object,omitempty"`
	ID           string         `json:"id"`
	Email        string         `json:"email"`
	FirstName    *string        `json:"first_name,omitempty"`
	LastName     *string        `json:"last_name,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
	Unsubscribed bool           `json:"unsubscribed"`
	CreatedAt    string         `json:"created_at,omitempty"`
	UpdatedAt    string         `json:"updated_at,omitempty"`
}

type ContactProperty struct {
	Object        string `json:"object,omitempty"`
	ID            string `json:"id"`
	Key           string `json:"key"`
	Type          string `json:"type"`
	FallbackValue any    `json:"fallback_value,omitempty"`
	CreatedAt     string `json:"created_at,omitempty"`
}

type Topic struct {
	Object              string  `json:"object,omitempty"`
	ID                  string  `json:"id"`
	Name                string  `json:"name"`
	Key                 string  `json:"key,omitempty"`
	Description         *string `json:"description,omitempty"`
	Visibility          string  `json:"visibility,omitempty"`
	DefaultSubscription string  `json:"default_subscription,omitempty"`
	CreatedAt           string  `json:"created_at,omitempty"`
	UpdatedAt           string  `json:"updated_at,omitempty"`
}

type Segment struct {
	Object    string `json:"object,omitempty"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Contacts  int    `json:"contacts,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type Suppression struct {
	Object    string  `json:"object,omitempty"`
	ID        string  `json:"id"`
	Email     string  `json:"email"`
	Origin    string  `json:"origin,omitempty"`
	SourceID  *string `json:"source_id,omitempty"`
	CreatedAt string  `json:"created_at,omitempty"`
}

type Broadcast struct {
	Object      string   `json:"object,omitempty"`
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	From        string   `json:"from,omitempty"`
	Subject     *string  `json:"subject,omitempty"`
	ReplyTo     []string `json:"reply_to,omitempty"`
	PreviewText *string  `json:"preview_text,omitempty"`
	HTML        *string  `json:"html,omitempty"`
	Text        *string  `json:"text,omitempty"`
	TopicID     *string  `json:"topic_id,omitempty"`
	SegmentID   *string  `json:"segment_id,omitempty"`
	Status      string   `json:"status"`
	ScheduledAt *string  `json:"scheduled_at,omitempty"`
	SentAt      *string  `json:"sent_at,omitempty"`
	CreatedAt   string   `json:"created_at,omitempty"`
}

type Automation struct {
	Object      string `json:"object,omitempty"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Status      string `json:"status,omitempty"`
	Steps       []any  `json:"steps,omitempty"`
	Connections []any  `json:"connections,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
}

type Webhook struct {
	Object        string   `json:"object,omitempty"`
	ID            string   `json:"id"`
	Endpoint      string   `json:"endpoint"`
	Events        []string `json:"events"`
	Status        string   `json:"status"`
	SigningSecret string   `json:"signing_secret,omitempty"`
	CreatedAt     string   `json:"created_at,omitempty"`
}

type LogEntry struct {
	Object         string  `json:"object,omitempty"`
	ID             string  `json:"id"`
	CreatedAt      string  `json:"created_at"`
	Endpoint       string  `json:"endpoint"`
	Method         string  `json:"method"`
	ResponseStatus int     `json:"response_status"`
	UserAgent      *string `json:"user_agent,omitempty"`
	RequestBody    any     `json:"request_body,omitempty"`
	ResponseBody   any     `json:"response_body,omitempty"`
}

type LogsExportResponse struct {
	ExportedAt string     `json:"exported_at"`
	Logs       []LogEntry `json:"logs"`
	Count      int        `json:"count"`
	RequestID  string     `json:"request_id"`
}

type Brand struct {
	Object         string  `json:"object,omitempty"`
	ProductName    *string `json:"product_name,omitempty"`
	ProductURL     *string `json:"product_url,omitempty"`
	LogoURL        *string `json:"logo_url,omitempty"`
	Color          *string `json:"color,omitempty"`
	SupportEmail   *string `json:"support_email,omitempty"`
	SupportURL     *string `json:"support_url,omitempty"`
	PrivacyURL     *string `json:"privacy_url,omitempty"`
	CompanyName    *string `json:"company_name,omitempty"`
	CompanyAddress *string `json:"company_address,omitempty"`
	// The heading and the line under it on the public unsubscribe page.
	UnsubscribeTitle       *string `json:"unsubscribe_title,omitempty"`
	UnsubscribeDescription *string `json:"unsubscribe_description,omitempty"`
	TextColor              string  `json:"text_color,omitempty"`
}

// Request inputs
type SendInput struct {
	From        string            `json:"from"`
	To          any               `json:"to"`
	Cc          any               `json:"cc,omitempty"`
	Bcc         any               `json:"bcc,omitempty"`
	ReplyTo     any               `json:"reply_to,omitempty"`
	Subject     string            `json:"subject,omitempty"`
	HTML        string            `json:"html,omitempty"`
	Text        string            `json:"text,omitempty"`
	Template    any               `json:"template,omitempty"`
	Variables   map[string]any    `json:"variables,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Tags        []Tag             `json:"tags,omitempty"`
	TopicID     string            `json:"topic_id,omitempty"`
	ScheduledAt string            `json:"scheduled_at,omitempty"`
	Attachments []AttachmentInput `json:"attachments,omitempty"`
}

type AttachmentInput struct {
	Filename    string `json:"filename"`
	Content     string `json:"content,omitempty"`
	Path        string `json:"path,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	ContentID   string `json:"content_id,omitempty"`
	Disposition string `json:"disposition,omitempty"`
}

// EmailUpdateInput changes a scheduled email. HTML and Text can be cleared with Null.
type EmailUpdateInput struct {
	Subject     *string           `json:"subject,omitempty"`
	HTML        *Field[string]    `json:"html,omitempty"`
	Text        *Field[string]    `json:"text,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Tags        []Tag             `json:"tags,omitempty"`
	ScheduledAt *Field[string]    `json:"scheduled_at,omitempty"`
}

type DomainCapabilities struct {
	Sending   string `json:"sending,omitempty"`
	Receiving string `json:"receiving,omitempty"`
}

type DomainInput struct {
	Name              string              `json:"name"`
	Region            string              `json:"region,omitempty"`
	CustomReturnPath  string              `json:"custom_return_path,omitempty"`
	OpenTracking      bool                `json:"open_tracking,omitempty"`
	ClickTracking     bool                `json:"click_tracking,omitempty"`
	TrackingSubdomain string              `json:"tracking_subdomain,omitempty"`
	TLS               string              `json:"tls,omitempty"`
	Capabilities      *DomainCapabilities `json:"capabilities,omitempty"`
}

// The Update types below are for the Update methods. Every field is optional, a field left nil
// is not sent, and false is sent when set. The Input types above are for creating, where a
// required name would otherwise go out empty.

// DomainUpdate changes a domain's settings. The name and region cannot change.
type DomainUpdate struct {
	OpenTracking      *bool               `json:"open_tracking,omitempty"`
	ClickTracking     *bool               `json:"click_tracking,omitempty"`
	TrackingSubdomain *string             `json:"tracking_subdomain,omitempty"`
	TLS               *string             `json:"tls,omitempty"`
	Capabilities      *DomainCapabilities `json:"capabilities,omitempty"`
}

// TemplateUpdate changes a template. Alias, From, ReplyTo, Subject, HTML, and Text can be
// cleared with Null.
type TemplateUpdate struct {
	Name      *string            `json:"name,omitempty"`
	Alias     *Field[string]     `json:"alias,omitempty"`
	From      *Field[string]     `json:"from,omitempty"`
	ReplyTo   *Field[[]string]   `json:"reply_to,omitempty"`
	Subject   *Field[string]     `json:"subject,omitempty"`
	HTML      *Field[string]     `json:"html,omitempty"`
	Text      *Field[string]     `json:"text,omitempty"`
	Variables []TemplateVariable `json:"variables,omitempty"`
	Track     *bool              `json:"track,omitempty"`
	Publish   *bool              `json:"publish,omitempty"`
}

// ContactUpdate changes a contact. Set Unsubscribed to Ptr(false) to resubscribe.
type ContactUpdate struct {
	FirstName    *Field[string] `json:"first_name,omitempty"`
	LastName     *Field[string] `json:"last_name,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
	Unsubscribed *bool          `json:"unsubscribed,omitempty"`
}

// TopicUpdate changes a topic. The default subscription cannot change after creation.
type TopicUpdate struct {
	Name        *string        `json:"name,omitempty"`
	Description *Field[string] `json:"description,omitempty"`
	Visibility  *string        `json:"visibility,omitempty"`
}

// WebhookUpdate changes a webhook. Set Enabled to Ptr(false) to pause deliveries.
type WebhookUpdate struct {
	Endpoint *string  `json:"endpoint,omitempty"`
	Events   []string `json:"events,omitempty"`
	Enabled  *bool    `json:"enabled,omitempty"`
}

type TemplateInput struct {
	Name      string             `json:"name"`
	Alias     string             `json:"alias,omitempty"`
	From      string             `json:"from,omitempty"`
	ReplyTo   any                `json:"reply_to,omitempty"`
	Subject   string             `json:"subject,omitempty"`
	HTML      string             `json:"html,omitempty"`
	Text      string             `json:"text,omitempty"`
	Variables []TemplateVariable `json:"variables,omitempty"`
	Publish   bool               `json:"publish,omitempty"`
}

type ContactInput struct {
	Email      string         `json:"email"`
	FirstName  string         `json:"first_name,omitempty"`
	LastName   string         `json:"last_name,omitempty"`
	Properties map[string]any `json:"properties,omitempty"`
	// A pointer, so false can be sent: creating a contact that exists updates it, and
	// Ptr(false) resubscribes it.
	Unsubscribed *bool               `json:"unsubscribed,omitempty"`
	Segments     []map[string]string `json:"segments,omitempty"`
	Topics       []TopicChoice       `json:"topics,omitempty"`
}

type TopicChoice struct {
	ID           string `json:"id"`
	Subscription string `json:"subscription"`
}

type ContactPropertyInput struct {
	Key           string `json:"key"`
	Type          string `json:"type,omitempty"`
	FallbackValue any    `json:"fallback_value,omitempty"`
}

type ContactImportInput struct {
	File       []byte
	Filename   string
	ColumnMap  map[string]any
	OnConflict string
	Segments   []map[string]string
	Topics     []TopicChoice
}

type TopicInput struct {
	Name                string `json:"name"`
	Key                 string `json:"key,omitempty"`
	Description         string `json:"description,omitempty"`
	Visibility          string `json:"visibility,omitempty"`
	DefaultSubscription string `json:"default_subscription,omitempty"`
}

type TopicSubscriptionInput struct {
	Email  string `json:"email"`
	Status string `json:"status,omitempty"`
}

type SegmentInput struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type BroadcastInput struct {
	Name        string         `json:"name,omitempty"`
	From        string         `json:"from"`
	Subject     string         `json:"subject,omitempty"`
	ReplyTo     any            `json:"reply_to,omitempty"`
	PreviewText string         `json:"preview_text,omitempty"`
	HTML        string         `json:"html,omitempty"`
	Text        string         `json:"text,omitempty"`
	Template    string         `json:"template,omitempty"`
	Variables   map[string]any `json:"variables,omitempty"`
	TopicID     string         `json:"topic_id,omitempty"`
	SegmentID   string         `json:"segment_id"`
	ScheduledAt string         `json:"scheduled_at,omitempty"`
	Send        bool           `json:"send,omitempty"`
}

type AutomationStep struct {
	Key    string         `json:"key"`
	Type   string         `json:"type"`
	Config map[string]any `json:"config,omitempty"`
}

type AutomationConnection struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type,omitempty"`
}

type AutomationInput struct {
	Name        string                 `json:"name"`
	Status      string                 `json:"status,omitempty"`
	Steps       []AutomationStep       `json:"steps"`
	Connections []AutomationConnection `json:"connections,omitempty"`
}

type EventInput struct {
	Event     string         `json:"event"`
	ContactID string         `json:"contact_id,omitempty"`
	Email     string         `json:"email,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
}

type EventDefinitionInput struct {
	Name   string            `json:"name"`
	Schema map[string]string `json:"schema,omitempty"`
}

type WebhookInput struct {
	Endpoint string   `json:"endpoint"`
	Events   []string `json:"events,omitempty"`
	Status   string   `json:"status,omitempty"`
}

func New(apiKey string) *Client {
	if apiKey == "" {
		apiKey = os.Getenv("DISPATCH_API_KEY")
	}
	// DISPATCH_API_URL is the name the CLI uses. The generic API_URL is not read: many
	// unrelated projects set it, and the key must not go to whatever host it names.
	baseURL := os.Getenv("DISPATCH_BASE_URL")
	if baseURL == "" {
		baseURL = os.Getenv("DISPATCH_API_URL")
	}
	if baseURL == "" {
		baseURL = "http://localhost:3100"
	}
	return &Client{
		APIKey:    apiKey,
		BaseURL:   strings.TrimRight(baseURL, "/"),
		UserAgent: "dispatch-go:0.1.0",
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// at joins escaped path segments into a route, so IDs and email addresses are safe in the path.
func at(parts ...string) string {
	escaped := make([]string, len(parts))
	for i, part := range parts {
		escaped[i] = url.PathEscape(part)
	}
	return "/" + strings.Join(escaped, "/")
}

// with appends optional query parameters such as limit, after, before, and filters.
func with(path string, query []url.Values) string {
	values := url.Values{}
	for _, q := range query {
		for key, list := range q {
			for _, value := range list {
				values.Add(key, value)
			}
		}
	}
	if encoded := values.Encode(); encoded != "" {
		return path + "?" + encoded
	}
	return path
}

func get[T any](c *Client, path string) (*T, error) {
	return call[T](c, http.MethodGet, path, nil, "", true)
}

func post[T any](c *Client, path string, body any) (*T, error) {
	if body == nil {
		body = map[string]any{}
	}
	return call[T](c, http.MethodPost, path, body, "", true)
}

func patch[T any](c *Client, path string, body any) (*T, error) {
	return call[T](c, http.MethodPatch, path, body, "", true)
}

func remove(c *Client, path string) (*Deleted, error) {
	return call[Deleted](c, http.MethodDelete, path, nil, "", true)
}

func call[T any](c *Client, method, path string, body any, idempotencyKey string, auth bool) (*T, error) {
	data, err := c.do(method, path, body, idempotencyKey, auth, nil)
	if err != nil {
		return nil, err
	}
	return decode[T](data)
}

type Map = map[string]any

// Health and platform
func (c *Client) Health() (Map, error) {
	return object(call[Map](c, http.MethodGet, "/health", nil, "", false))
}

// Setup is sent with the key. Where public setup is on the route ignores it; in production it needs it.
func (c *Client) Setup() (Map, error) {
	return object(call[Map](c, http.MethodGet, "/setup", nil, "", true))
}

func (c *Client) Me() (Map, error) { return object(get[Map](c, "/me")) }

func (c *Client) Users(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/users", query))
}

func (c *Client) CreateUser(user any) (Map, error) { return object(post[Map](c, "/users", user)) }

func (c *Client) UpdateUser(id string, user any) (Map, error) {
	return object(patch[Map](c, at("users", id), user))
}

func (c *Client) DeleteUser(id string) (*Deleted, error) { return remove(c, at("users", id)) }

func (c *Client) Roles(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/roles", query))
}

func (c *Client) CreateRole(role any) (Map, error) { return object(post[Map](c, "/roles", role)) }

func (c *Client) UpdateRole(id string, role any) (Map, error) {
	return object(patch[Map](c, at("roles", id), role))
}

func (c *Client) DeleteRole(id string) (*Deleted, error) { return remove(c, at("roles", id)) }

func (c *Client) Memberships(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/memberships", query))
}

func (c *Client) CreateMembership(userID, roleID string) (Map, error) {
	return object(post[Map](c, "/memberships", Map{"user_id": userID, "role_id": roleID}))
}

func (c *Client) DeleteMembership(id string) (*Deleted, error) {
	return remove(c, at("memberships", id))
}

func (c *Client) Sessions(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/sessions", query))
}

// CreateSession signs a user in with their email and password.
func (c *Client) CreateSession(email, password string) (Map, error) {
	return object(call[Map](c, http.MethodPost, "/sessions", Map{"email": email, "password": password}, "", false))
}

func (c *Client) DeleteSession(id string) (*Deleted, error) { return remove(c, at("sessions", id)) }

func (c *Client) AuditLogs(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/audit-logs", query))
}

// Emails
func (c *Client) Send(email any, idempotencyKey string) (*Email, error) {
	return call[Email](c, http.MethodPost, "/emails", email, idempotencyKey, true)
}

// Batch sends up to 100 emails. validation is "strict" (the default when empty) or "permissive".
func (c *Client) Batch(emails any, idempotencyKey string, validation string) (*BatchResponse, error) {
	var headers map[string]string
	if validation != "" {
		headers = map[string]string{"X-Batch-Validation": validation}
	}
	data, err := c.do(http.MethodPost, "/emails/batch", emails, idempotencyKey, true, headers)
	if err != nil {
		return nil, err
	}
	return decode[BatchResponse](data)
}

func (c *Client) Emails(query ...url.Values) (*ListResponse[Email], error) {
	return get[ListResponse[Email]](c, with("/emails", query))
}

func (c *Client) Email(id string) (*Email, error) { return get[Email](c, at("emails", id)) }

func (c *Client) UpdateEmail(id string, update any) (Map, error) {
	return object(patch[Map](c, at("emails", id), update))
}

func (c *Client) CancelEmail(id string) (Map, error) {
	return object(post[Map](c, at("emails", id, "cancel"), nil))
}

func (c *Client) RetryEmail(id string) (Map, error) {
	return object(post[Map](c, at("emails", id, "retry"), nil))
}

func (c *Client) EmailJobs(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/email-jobs", query))
}

func (c *Client) EmailJob(id string) (Map, error) { return object(get[Map](c, at("email-jobs", id))) }

func (c *Client) EmailAttachments(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("emails", id, "attachments"), query))
}

func (c *Client) EmailAttachment(id, attachmentID string) (Map, error) {
	return object(get[Map](c, at("emails", id, "attachments", attachmentID)))
}

func (c *Client) EmailEvents(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("emails", id, "events"), query))
}

func (c *Client) EmailMetrics(query url.Values) (Map, error) {
	return object(get[Map](c, with("/emails/metrics", []url.Values{query})))
}

func (c *Client) ShareEmail(id string, expiresIn string) (Map, error) {
	body := Map{}
	if expiresIn != "" {
		body["expires_in"] = expiresIn
	}
	return object(post[Map](c, at("emails", id, "share"), body))
}

// Received emails
func (c *Client) ReceivedEmails(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/emails/receiving", query))
}

func (c *Client) ReceivedEmail(id string, query ...url.Values) (Map, error) {
	return object(get[Map](c, with(at("emails", "receiving", id), query)))
}

func (c *Client) SimulateReceivedEmail(email any) (Map, error) {
	return object(post[Map](c, "/emails/receiving/simulate", email))
}

func (c *Client) ReceivedAttachments(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("emails", "receiving", id, "attachments"), query))
}

func (c *Client) ReceivedAttachment(id, attachmentID string) (Map, error) {
	return object(get[Map](c, at("emails", "receiving", id, "attachments", attachmentID)))
}

// ForwardReceivedEmail fetches a received email and sends it on through POST /emails, with
// its attachments. Inline images keep their cid: references and travel as inline attachments.
func (c *Client) ForwardReceivedEmail(id string, to any, from string, idempotencyKey string) (*Email, error) {
	received, err := c.ReceivedEmail(id, url.Values{"html_format": {"cid"}})
	if err != nil {
		return nil, err
	}
	attachments, err := c.receivedFiles(id)
	if err != nil {
		return nil, err
	}
	subject, _ := received["subject"].(string)
	if subject == "" {
		subject = "(no subject)"
	}
	if !strings.HasPrefix(strings.ToLower(subject), "fwd:") {
		subject = "Fwd: " + subject
	}
	email := Map{"from": from, "to": to, "subject": subject}
	if html, ok := received["html"].(string); ok && html != "" {
		email["html"] = html
	}
	if text, ok := received["text"].(string); ok && text != "" {
		email["text"] = text
	}
	if len(attachments) > 0 {
		email["attachments"] = attachments
	}
	return c.Send(email, idempotencyKey)
}

// receivedFiles downloads a received email's attachments through their signed URLs.
func (c *Client) receivedFiles(id string) ([]AttachmentInput, error) {
	listed, err := c.ReceivedAttachments(id, url.Values{"limit": {"100"}})
	if err != nil {
		return nil, err
	}
	files := []AttachmentInput{}
	for _, item := range listed.Data {
		link, _ := item["download_url"].(string)
		if link == "" {
			continue
		}
		name, _ := item["filename"].(string)
		if name == "" {
			name = "attachment"
		}
		ctx := c.ctx
		if ctx == nil {
			ctx = context.Background()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
		if err != nil {
			return nil, err
		}
		res, err := c.HTTPClient.Do(req)
		if err != nil {
			return nil, &Error{Name: "application_error", Message: "Could not download the attachment " + name, Cause: err}
		}
		data, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, &Error{Status: res.StatusCode, Name: "application_error", Message: "Could not download the attachment " + name, Body: map[string]any{}}
		}
		file := AttachmentInput{Filename: name, Content: base64.StdEncoding.EncodeToString(data)}
		file.ContentType, _ = item["content_type"].(string)
		file.ContentID, _ = item["content_id"].(string)
		files = append(files, file)
	}
	return files, nil
}

// Domains
func (c *Client) Domains(query ...url.Values) (*ListResponse[Domain], error) {
	return get[ListResponse[Domain]](c, with("/domains", query))
}

func (c *Client) CreateDomain(domain any) (*Domain, error) {
	return post[Domain](c, "/domains", domain)
}

func (c *Client) Domain(id string) (*Domain, error) { return get[Domain](c, at("domains", id)) }

func (c *Client) UpdateDomain(id string, domain any) (*Domain, error) {
	return patch[Domain](c, at("domains", id), domain)
}

func (c *Client) VerifyDomain(id string) (Map, error) {
	return object(post[Map](c, at("domains", id, "verify"), nil))
}

func (c *Client) DoctorDomain(id string) (Map, error) {
	return object(get[Map](c, at("domains", id, "doctor")))
}

func (c *Client) PublishRoute53(id string) (Map, error) {
	return object(post[Map](c, at("domains", id, "publish-route53"), nil))
}

func (c *Client) DeleteDomain(id string) (*Deleted, error) { return remove(c, at("domains", id)) }

// API keys
func (c *Client) APIKeys(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/api-keys", query))
}

func (c *Client) CreateAPIKey(key any) (Map, error) { return object(post[Map](c, "/api-keys", key)) }

func (c *Client) UpdateAPIKey(id, name string) (Map, error) {
	return object(patch[Map](c, at("api-keys", id), Map{"name": name}))
}

func (c *Client) DeleteAPIKey(id string) (*Deleted, error) { return remove(c, at("api-keys", id)) }

// Brand and template library
func (c *Client) Brand() (*Brand, error) { return get[Brand](c, "/brand") }

type Settings struct {
	Object                   string   `json:"object"`
	ImportTriggerAutomations bool     `json:"import_trigger_automations"`
	SandboxDomains           []string `json:"sandbox_domains"`
}

func (c *Client) Settings() (*Settings, error) { return get[Settings](c, "/settings") }

func (c *Client) UpdateSettings(settings any) (*Settings, error) {
	return patch[Settings](c, "/settings", settings)
}

func (c *Client) UpdateBrand(brand any) (*Brand, error) { return patch[Brand](c, "/brand", brand) }

func (c *Client) TemplateLibrary() (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, "/template-library")
}

func (c *Client) TemplateLibraryEntry(slug string) (Map, error) {
	return object(get[Map](c, at("template-library", slug)))
}

func (c *Client) InstallTemplate(slug string) (*Template, error) {
	return post[Template](c, at("template-library", slug, "install"), nil)
}

// Templates. Every id may also be an alias.
func (c *Client) Templates(query ...url.Values) (*ListResponse[Template], error) {
	return get[ListResponse[Template]](c, with("/templates", query))
}

func (c *Client) CreateTemplate(template any) (*Template, error) {
	return post[Template](c, "/templates", template)
}

func (c *Client) Template(id string) (*Template, error) { return get[Template](c, at("templates", id)) }

func (c *Client) UpdateTemplate(id string, template any) (*Template, error) {
	return patch[Template](c, at("templates", id), template)
}

// PublishTemplate publishes the latest version, or versionID when it is not empty.
func (c *Client) PublishTemplate(id string, versionID string) (*Template, error) {
	body := Map{}
	if versionID != "" {
		body["version_id"] = versionID
	}
	return post[Template](c, at("templates", id, "publish"), body)
}

func (c *Client) DuplicateTemplate(id string, name string) (*Template, error) {
	body := Map{}
	if name != "" {
		body["name"] = name
	}
	return post[Template](c, at("templates", id, "duplicate"), body)
}

func (c *Client) TemplateVersions(id string) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, at("templates", id, "versions"))
}

func (c *Client) CreateTemplateVersion(id string, version any) (*Template, error) {
	return post[Template](c, at("templates", id, "versions"), version)
}

func (c *Client) RenderTemplate(id string, variables map[string]any) (Map, error) {
	if variables == nil {
		variables = Map{}
	}
	return object(post[Map](c, at("templates", id, "render"), Map{"variables": variables}))
}

func (c *Client) DeleteTemplate(id string) (*Deleted, error) { return remove(c, at("templates", id)) }

// Contacts. Every contact argument is an ID or an email address.
func (c *Client) Contacts(query ...url.Values) (*ListResponse[Contact], error) {
	return get[ListResponse[Contact]](c, with("/contacts", query))
}

func (c *Client) CreateContact(contact any) (*Contact, error) {
	return post[Contact](c, "/contacts", contact)
}

func (c *Client) Contact(contact string) (*Contact, error) {
	return get[Contact](c, at("contacts", contact))
}

func (c *Client) UpdateContact(contact string, update any) (*Contact, error) {
	return patch[Contact](c, at("contacts", contact), update)
}

func (c *Client) DeleteContact(contact string) (Map, error) {
	return object(call[Map](c, http.MethodDelete, at("contacts", contact), nil, "", true))
}

func (c *Client) ContactActivity(contact string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("contacts", contact, "activity"), query))
}

func (c *Client) ContactSegments(contact string, query ...url.Values) (*ListResponse[Segment], error) {
	return get[ListResponse[Segment]](c, with(at("contacts", contact, "segments"), query))
}

func (c *Client) AddContactSegment(contact, segmentID string) (Map, error) {
	return object(post[Map](c, at("contacts", contact, "segments", segmentID), nil))
}

func (c *Client) RemoveContactSegment(contact, segmentID string) (*Deleted, error) {
	return remove(c, at("contacts", contact, "segments", segmentID))
}

func (c *Client) ContactTopics(contact string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("contacts", contact, "topics"), query))
}

func (c *Client) UpdateContactTopics(contact string, topics []TopicChoice) (*ListResponse[Map], error) {
	return patch[ListResponse[Map]](c, at("contacts", contact, "topics"), Map{"topics": topics})
}

// Contact imports
func (c *Client) ImportContacts(input ContactImportInput) (Map, error) {
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	field := func(name string, value any) error {
		if text, ok := value.(string); ok {
			return form.WriteField(name, text)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		return form.WriteField(name, string(encoded))
	}
	if input.ColumnMap != nil {
		if err := field("column_map", input.ColumnMap); err != nil {
			return nil, err
		}
	}
	if input.OnConflict != "" {
		if err := field("on_conflict", input.OnConflict); err != nil {
			return nil, err
		}
	}
	if input.Segments != nil {
		if err := field("segments", input.Segments); err != nil {
			return nil, err
		}
	}
	if input.Topics != nil {
		if err := field("topics", input.Topics); err != nil {
			return nil, err
		}
	}
	filename := input.Filename
	if filename == "" {
		filename = "contacts.csv"
	}
	part, err := form.CreateFormFile("file", filename)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(input.File); err != nil {
		return nil, err
	}
	if err := form.Close(); err != nil {
		return nil, err
	}
	data, err := c.send(http.MethodPost, "/contacts/imports", &buf, form.FormDataContentType(), "", true, nil)
	if err != nil {
		return nil, err
	}
	return object(decode[Map](data))
}

func (c *Client) ContactImports(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/contacts/imports", query))
}

func (c *Client) ContactImport(id string) (Map, error) {
	return object(get[Map](c, at("contacts", "imports", id)))
}

// Contact properties
func (c *Client) ContactProperties(query ...url.Values) (*ListResponse[ContactProperty], error) {
	return get[ListResponse[ContactProperty]](c, with("/contact-properties", query))
}

func (c *Client) CreateContactProperty(property any) (*ContactProperty, error) {
	return post[ContactProperty](c, "/contact-properties", property)
}

func (c *Client) ContactProperty(id string) (*ContactProperty, error) {
	return get[ContactProperty](c, at("contact-properties", id))
}

func (c *Client) UpdateContactProperty(id string, fallbackValue any) (*ContactProperty, error) {
	return patch[ContactProperty](c, at("contact-properties", id), Map{"fallback_value": fallbackValue})
}

func (c *Client) DeleteContactProperty(id string) (*Deleted, error) {
	return remove(c, at("contact-properties", id))
}

// Topics
func (c *Client) Topics(query ...url.Values) (*ListResponse[Topic], error) {
	return get[ListResponse[Topic]](c, with("/topics", query))
}

func (c *Client) CreateTopic(topic any) (*Topic, error) { return post[Topic](c, "/topics", topic) }

func (c *Client) Topic(id string) (*Topic, error) { return get[Topic](c, at("topics", id)) }

func (c *Client) UpdateTopic(id string, topic any) (*Topic, error) {
	return patch[Topic](c, at("topics", id), topic)
}

func (c *Client) DeleteTopic(id string) (*Deleted, error) { return remove(c, at("topics", id)) }

func (c *Client) TopicSubscriptions(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("topics", id, "subscriptions"), query))
}

func (c *Client) SubscribeTopic(topicID string, input any) (Map, error) {
	body := input
	if email, ok := input.(string); ok {
		body = Map{"email": email, "status": "subscribed"}
	}
	return object(post[Map](c, at("topics", topicID, "subscriptions"), body))
}

func (c *Client) UnsubscribeTopic(topicID string, email string) (Map, error) {
	return object(post[Map](c, at("topics", topicID, "subscriptions"), Map{"email": email, "status": "unsubscribed"}))
}

// Segments
func (c *Client) Segments(query ...url.Values) (*ListResponse[Segment], error) {
	return get[ListResponse[Segment]](c, with("/segments", query))
}

func (c *Client) CreateSegment(segment any) (*Segment, error) {
	return post[Segment](c, "/segments", segment)
}

func (c *Client) Segment(id string) (*Segment, error) { return get[Segment](c, at("segments", id)) }

func (c *Client) UpdateSegment(id string, segment any) (*Segment, error) {
	return patch[Segment](c, at("segments", id), segment)
}

func (c *Client) DeleteSegment(id string) (*Deleted, error) { return remove(c, at("segments", id)) }

func (c *Client) SegmentContacts(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("segments", id, "contacts"), query))
}

func (c *Client) AddSegmentContact(segmentID string, contact any) (Map, error) {
	body := contact
	if email, ok := contact.(string); ok {
		body = Map{"email": email}
	}
	return object(post[Map](c, at("segments", segmentID, "contacts"), body))
}

func (c *Client) RemoveSegmentContact(segmentID string, contactID string) (*Deleted, error) {
	return remove(c, at("segments", segmentID, "contacts", contactID))
}

// Suppressions. Lookups and deletes take an ID or an email address.
func (c *Client) Suppressions(query ...url.Values) (*ListResponse[Suppression], error) {
	return get[ListResponse[Suppression]](c, with("/suppressions", query))
}

func (c *Client) Suppress(suppression any) (*Suppression, error) {
	body := suppression
	if email, ok := suppression.(string); ok {
		body = Map{"email": email}
	}
	return post[Suppression](c, "/suppressions", body)
}

func (c *Client) Suppression(idOrEmail string) (*Suppression, error) {
	return get[Suppression](c, at("suppressions", idOrEmail))
}

func (c *Client) Unsuppress(idOrEmail string) (*Deleted, error) {
	return remove(c, at("suppressions", idOrEmail))
}

func (c *Client) SuppressBatch(emails []string) (*ListResponse[Suppression], error) {
	return post[ListResponse[Suppression]](c, "/suppressions/batch/add", Map{"emails": emails})
}

// UnsuppressBatch removes by email addresses, or by IDs when emails is empty.
func (c *Client) UnsuppressBatch(emails []string, ids []string) (*ListResponse[Map], error) {
	body := Map{"emails": emails}
	if len(emails) == 0 {
		body = Map{"ids": ids}
	}
	return post[ListResponse[Map]](c, "/suppressions/batch/remove", body)
}

// Broadcasts
func (c *Client) Broadcasts(query ...url.Values) (*ListResponse[Broadcast], error) {
	return get[ListResponse[Broadcast]](c, with("/broadcasts", query))
}

func (c *Client) CreateBroadcast(broadcast any) (*Broadcast, error) {
	return post[Broadcast](c, "/broadcasts", broadcast)
}

func (c *Client) Broadcast(id string) (*Broadcast, error) {
	return get[Broadcast](c, at("broadcasts", id))
}

func (c *Client) UpdateBroadcast(id string, broadcast any) (*Broadcast, error) {
	return patch[Broadcast](c, at("broadcasts", id), broadcast)
}

func (c *Client) DeleteBroadcast(id string) (*Deleted, error) { return remove(c, at("broadcasts", id)) }

// SendBroadcast sends now, or at scheduledAt when it is not empty. scheduledAt takes ISO 8601 or a phrase like "in 1 hour".
func (c *Client) SendBroadcast(id string, scheduledAt string) (Map, error) {
	body := Map{}
	if scheduledAt != "" {
		body["scheduled_at"] = scheduledAt
	}
	return object(post[Map](c, at("broadcasts", id, "send"), body))
}

func (c *Client) PauseBroadcast(id string) (*Broadcast, error) {
	return post[Broadcast](c, at("broadcasts", id, "pause"), nil)
}

func (c *Client) ResumeBroadcast(id string) (*Broadcast, error) {
	return post[Broadcast](c, at("broadcasts", id, "resume"), nil)
}

func (c *Client) CancelBroadcast(id string) (*Broadcast, error) {
	return post[Broadcast](c, at("broadcasts", id, "cancel"), nil)
}

func (c *Client) DuplicateBroadcast(id string, name string) (*Broadcast, error) {
	body := Map{}
	if name != "" {
		body["name"] = name
	}
	return post[Broadcast](c, at("broadcasts", id, "duplicate"), body)
}

// BroadcastRecipients lists recipients by event type: sent, delivered, opened, clicked, bounced, complained, unsubscribed, or suppressed.
func (c *Client) BroadcastRecipients(id string, recipientType string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("broadcasts", id, "recipients"), append([]url.Values{{"type": {recipientType}}}, query...)))
}

func (c *Client) BroadcastClickedLinks(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("broadcasts", id, "clicked-links"), query))
}

// BroadcastAudience reports who a send would reach now, and how many are left out and why.
func (c *Client) BroadcastAudience(id string) (Map, error) {
	return object(get[Map](c, at("broadcasts", id, "audience")))
}

// Automations
func (c *Client) Automations(query ...url.Values) (*ListResponse[Automation], error) {
	return get[ListResponse[Automation]](c, with("/automations", query))
}

func (c *Client) CreateAutomation(automation any) (*Automation, error) {
	return post[Automation](c, "/automations", automation)
}

func (c *Client) Automation(id string) (*Automation, error) {
	return get[Automation](c, at("automations", id))
}

func (c *Client) UpdateAutomation(id string, automation any) (*Automation, error) {
	return patch[Automation](c, at("automations", id), automation)
}

func (c *Client) DeleteAutomation(id string) (*Deleted, error) {
	return remove(c, at("automations", id))
}

func (c *Client) DuplicateAutomation(id string) (*Automation, error) {
	return post[Automation](c, at("automations", id, "duplicate"), nil)
}

func (c *Client) StopAutomation(id string) (Map, error) {
	return object(post[Map](c, at("automations", id, "stop"), nil))
}

func (c *Client) AutomationRuns(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("automations", id, "runs"), query))
}

func (c *Client) AutomationRun(automationID, runID string) (Map, error) {
	return object(get[Map](c, at("automations", automationID, "runs", runID)))
}

func (c *Client) AutomationRunMetrics(automationID string, query ...url.Values) (Map, error) {
	return object(get[Map](c, with(at("automations", automationID, "runs", "metrics"), query)))
}

// Events. /events holds definitions, /events/send fires one, /fired-events lists what fired.
func (c *Client) SendEvent(event EventInput) (Map, error) {
	return object(post[Map](c, "/events/send", event))
}

func (c *Client) Events(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/events", query))
}

func (c *Client) CreateEvent(definition any) (Map, error) {
	return object(post[Map](c, "/events", definition))
}

func (c *Client) Event(idOrName string) (Map, error) {
	return object(get[Map](c, at("events", idOrName)))
}

func (c *Client) UpdateEvent(idOrName string, schema map[string]string) (Map, error) {
	return object(patch[Map](c, at("events", idOrName), Map{"schema": schema}))
}

func (c *Client) DeleteEvent(idOrName string) (*Deleted, error) {
	return remove(c, at("events", idOrName))
}

func (c *Client) FiredEvents(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/fired-events", query))
}

func (c *Client) FiredEvent(id string) (Map, error) {
	return object(get[Map](c, at("fired-events", id)))
}

// Webhooks
func (c *Client) Webhooks(query ...url.Values) (*ListResponse[Webhook], error) {
	return get[ListResponse[Webhook]](c, with("/webhooks", query))
}

func (c *Client) CreateWebhook(webhook any) (*Webhook, error) {
	return post[Webhook](c, "/webhooks", webhook)
}

func (c *Client) Webhook(id string) (*Webhook, error) { return get[Webhook](c, at("webhooks", id)) }

func (c *Client) UpdateWebhook(id string, webhook any) (*Webhook, error) {
	return patch[Webhook](c, at("webhooks", id), webhook)
}

func (c *Client) DeleteWebhook(id string) (*Deleted, error) { return remove(c, at("webhooks", id)) }

func (c *Client) RotateWebhookSecret(id string) (*Webhook, error) {
	return post[Webhook](c, at("webhooks", id, "signing-secret", "rotate"), nil)
}

func (c *Client) WebhookEvents(id string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("webhooks", id, "events"), query))
}

func (c *Client) WebhookEvent(id, eventID string) (Map, error) {
	return object(get[Map](c, at("webhooks", id, "events", eventID)))
}

func (c *Client) WebhookEventAttempts(id, eventID string, query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with(at("webhooks", id, "events", eventID, "attempts"), query))
}

func (c *Client) ReplayWebhook(id, eventID string) (Map, error) {
	return object(post[Map](c, at("webhooks", id, "events", eventID, "replay"), nil))
}

func (c *Client) TestWebhook() (Map, error) { return object(post[Map](c, "/webhooks/test", nil)) }

// Logs, usage, and system
func (c *Client) Logs(query ...url.Values) (*ListResponse[LogEntry], error) {
	return get[ListResponse[LogEntry]](c, with("/logs", query))
}

func (c *Client) Log(id string) (*LogEntry, error) { return get[LogEntry](c, at("logs", id)) }

func (c *Client) LogsExport() (*LogsExportResponse, error) {
	return get[LogsExportResponse](c, "/logs/export")
}

func (c *Client) Timeline(query ...url.Values) (*ListResponse[Map], error) {
	return get[ListResponse[Map]](c, with("/timeline", query))
}

func (c *Client) Usage() (Map, error) { return object(get[Map](c, "/usage")) }

func (c *Client) System() (Map, error) { return object(get[Map](c, "/system")) }

func (c *Client) CheckLinks(urls []string) (Map, error) {
	return object(post[Map](c, "/links/check", Map{"urls": urls}))
}

// Internal HTTP handling
func (c *Client) do(method, path string, body any, idempotencyKey string, auth bool, headers map[string]string) ([]byte, error) {
	if body == nil {
		return c.send(method, path, nil, "", idempotencyKey, auth, headers)
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return c.send(method, path, bytes.NewReader(data), "application/json", idempotencyKey, auth, headers)
}

func (c *Client) send(method, path string, reader io.Reader, contentType, idempotencyKey string, auth bool, headers map[string]string) ([]byte, error) {
	ctx := c.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
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
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, &Error{
			Name:    "application_error",
			Message: "Unable to fetch data. The request could not be resolved.",
			Cause:   err,
		}
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return data, nil
	}

	failure := &Error{Status: res.StatusCode, Name: "application_error", Message: res.Status, Body: map[string]any{}}
	if len(data) > 0 {
		var m map[string]any
		if err := json.Unmarshal(data, &m); err == nil {
			failure.Body = m
			if name, ok := m["name"].(string); ok {
				failure.Name = name
			}
			if message, ok := m["message"].(string); ok {
				failure.Message = message
			}
			if rid, ok := m["request_id"].(string); ok {
				failure.RequestID = rid
			}
		} else {
			failure.Body = string(data)
		}
	}
	if failure.RequestID == "" {
		failure.RequestID = res.Header.Get("X-Request-Id")
	}
	return nil, failure
}

func object(m *Map, err error) (Map, error) {
	if err != nil {
		return nil, err
	}
	return *m, nil
}

func decode[T any](data []byte) (*T, error) {
	var out T
	if len(data) > 0 {
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, err
		}
	}
	return &out, nil
}
