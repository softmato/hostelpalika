package realtime

import (
	_ "embed"
	"encoding/json"
	"slices"
	"strings"
)

// Topic names a slice of data a screen reloads when it moves.
type Topic string

const (
	Attendance       Topic = "attendance"
	Bookings         Topic = "bookings"
	Community        Topic = "community"
	Complaints       Topic = "complaints"
	Food             Topic = "food"
	Hostels          Topic = "hostels"
	Inquiries        Topic = "inquiries"
	Maintenance      Topic = "maintenance"
	Notices          Topic = "notices"
	Notifications    Topic = "notifications"
	Payments         Topic = "payments"
	Residents        Topic = "residents"
	Reviews          Topic = "reviews"
	Rooms            Topic = "rooms"
	Safety           Topic = "safety"
	ServiceProviders Topic = "service-providers"
	Store            Topic = "store"
)

// topics.json is TOPIC_ENDPOINTS and CATEGORY_TOPICS, written by the vector generator.
//
//go:embed topics.json
var topicsJSON []byte

var bridge struct {
	Endpoints  map[Topic][]string `json:"endpoints"`
	Categories map[string][]Topic `json:"categories"`
}

func init() {
	if err := json.Unmarshal(topicsJSON, &bridge); err != nil {
		panic(err) // generated file
	}
}

// TopicsForCategory maps a notification category to the topics it moves.
func TopicsForCategory(category string) []Topic {
	if t, ok := bridge.Categories[category]; ok {
		return t
	}
	return []Topic{}
}

// EndpointsForTopics is the de-duplicated endpoint patterns, in topic order.
func EndpointsForTopics(topics []Topic) []string {
	out := []string{}
	for _, t := range topics {
		for _, e := range bridge.Endpoints[t] {
			if !slices.Contains(out, e) {
				out = append(out, e)
			}
		}
	}
	return out
}

// writeTopics is announce-writes.ts's WRITE_TOPICS: a write under a prefix moves these topics.
var writeTopics = []struct {
	prefix string
	topics []Topic
}{
	{"/api/v1/hostel-admin/residents", []Topic{Residents, Payments, Rooms}},
	{"/api/v1/hostel-admin/resident-scan", []Topic{Residents, Payments, Rooms}},
	{"/api/v1/hostel-admin/rooms", []Topic{Rooms, Residents}},
	{"/api/v1/hostel-admin/room-types", []Topic{Rooms}},
	{"/api/v1/hostel-admin/profile", []Topic{Rooms, Hostels}},
	{"/api/v1/hostel-admin/kyc", []Topic{Hostels}},
	{"/api/v1/hostel-admin/settings", []Topic{Hostels, Payments}},
	{"/api/v1/hostel-admin/finance", []Topic{Payments}},
	{"/api/v1/hostel-admin/expenses", []Topic{Payments}},
	{"/api/v1/hostel-admin/bookings", []Topic{Bookings, Rooms, Residents}},
	{"/api/v1/hostel-admin/move-events", []Topic{Residents, Payments, Rooms}},
	{"/api/v1/resident/finance", []Topic{Payments}},
	{"/api/v1/resident/room", []Topic{Rooms}},
}

// IsRead is GET/HEAD/OPTIONS — the methods that never announce.
func IsRead(method string) bool {
	switch strings.ToUpper(method) {
	case "GET", "HEAD", "OPTIONS":
		return true
	}
	return false
}

// TopicsForWrite is the longest matching prefix's topics; none for a read.
func TopicsForWrite(method, path string) []Topic {
	if IsRead(method) {
		return []Topic{}
	}
	best := -1
	for i, w := range writeTopics {
		if (path == w.prefix || strings.HasPrefix(path, w.prefix+"/")) && (best < 0 || len(w.prefix) > len(writeTopics[best].prefix)) {
			best = i
		}
	}
	if best < 0 {
		return []Topic{}
	}
	return writeTopics[best].topics
}
