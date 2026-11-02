package maps

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

var overpassURLs = []string{"https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"}

const (
	nearbyRadius = 1500
	nearbyMax    = 18
)

// NearbyPlace is a row of the hostel's nearbyPlaces cache.
type NearbyPlace struct {
	Coordinates struct {
		Lat float64 `bson:"lat"`
		Lng float64 `bson:"lng"`
	} `bson:"coordinates"`
	Distance int64  `bson:"distance"`
	Name     string `bson:"name"`
	Type     string `bson:"type"`
}

func place(center, at Coordinates, name, kind string) NearbyPlace {
	p := NearbyPlace{Distance: haversineMeters(center, at), Name: name, Type: kind}
	p.Coordinates.Lat, p.Coordinates.Lng = at.Lat, at.Lng
	return p
}

func haversineMeters(a, b Coordinates) int64 {
	const r = 6_371_000
	rad := math.Pi / 180
	dLat, dLng := (b.Lat-a.Lat)*rad, (b.Lng-a.Lng)*rad
	h := math.Pow(math.Sin(dLat/2), 2) + math.Cos(a.Lat*rad)*math.Cos(b.Lat*rad)*math.Pow(math.Sin(dLng/2), 2)
	return int64(math.Round(2 * r * math.Asin(math.Sqrt(h))))
}

func coord(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// Nearby is fetchNearbyPlaces: Google when a key is set and it finds something,
// else Overpass. nil when every provider failed, so a good cache is never wiped.
func (c *Client) Nearby(ctx context.Context, center Coordinates) []NearbyPlace {
	if c.GoogleKey != "" {
		if places := c.nearbyGoogle(ctx, center); len(places) > 0 {
			return places
		}
	}
	places, err := c.nearbyOverpass(ctx, center)
	if err != nil {
		return nil
	}
	return places
}

func classifyOverpass(tags map[string]string) string {
	switch tags["amenity"] {
	case "college", "university", "school":
		return "college"
	case "hospital", "clinic":
		return "hospital"
	}
	if tags["highway"] == "bus_stop" || tags["public_transport"] == "platform" {
		return "bus_stop"
	}
	switch tags["leisure"] {
	case "park", "garden":
		return "park"
	case "fitness_centre", "sports_centre":
		return "gym"
	}
	switch tags["amenity"] {
	case "restaurant", "cafe", "fast_food":
		return "restaurant"
	case "pharmacy":
		return "pharmacy"
	}
	return "other"
}

type overpassResult struct {
	Elements []struct {
		Center *struct {
			Lat float64 `json:"lat"`
			Lon float64 `json:"lon"`
		} `json:"center"`
		Lat  *float64          `json:"lat"`
		Lon  *float64          `json:"lon"`
		Tags map[string]string `json:"tags"`
	} `json:"elements"`
}

func (c *Client) overpass(ctx context.Context, query string) *overpassResult {
	for _, u := range overpassURLs {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader("data="+url.QueryEscape(query)))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		res, err := c.HTTP.Do(req)
		if err != nil {
			continue
		}
		var data overpassResult
		ok := res.StatusCode/100 == 2 && json.NewDecoder(res.Body).Decode(&data) == nil
		res.Body.Close()
		if ok {
			return &data
		}
	}
	return nil
}

func (c *Client) nearbyOverpass(ctx context.Context, at Coordinates) ([]NearbyPlace, error) {
	around := "(around:" + strconv.Itoa(nearbyRadius) + "," + coord(at.Lat) + "," + coord(at.Lng) + ");"
	data := c.overpass(ctx, `[out:json][timeout:20];(node["amenity"~"college|university|school|hospital|clinic|restaurant|cafe|fast_food|pharmacy"]`+around+
		`way["amenity"~"college|university|hospital"]`+around+`node["highway"="bus_stop"]`+around+
		`node["leisure"~"park|garden|fitness_centre|sports_centre"]`+around+`way["leisure"~"park|garden"]`+around+`);out center `+strconv.Itoa(nearbyMax*4)+`;`)
	if data == nil {
		return nil, errors.New("every Overpass mirror failed")
	}
	byName := map[string]NearbyPlace{}
	for _, e := range data.Elements {
		name := e.Tags["name"]
		lat, lon := e.Lat, e.Lon
		if e.Center != nil {
			if lat == nil {
				lat = &e.Center.Lat
			}
			if lon == nil {
				lon = &e.Center.Lon
			}
		}
		if name == "" || lat == nil || lon == nil {
			continue
		}
		p := place(at, Coordinates{Lat: *lat, Lng: *lon}, name, classifyOverpass(e.Tags))
		if old, ok := byName[name]; !ok || p.Distance < old.Distance {
			byName[name] = p
		}
	}
	places := make([]NearbyPlace, 0, len(byName))
	for _, p := range byName {
		places = append(places, p)
	}
	return closest(places), nil
}

func closest(places []NearbyPlace) []NearbyPlace {
	sort.SliceStable(places, func(i, j int) bool {
		if places[i].Distance != places[j].Distance {
			return places[i].Distance < places[j].Distance
		}
		return places[i].Name < places[j].Name
	})
	if len(places) > nearbyMax {
		places = places[:nearbyMax]
	}
	return places
}

func (c *Client) nearbyGoogle(ctx context.Context, at Coordinates) []NearbyPlace {
	var places []NearbyPlace
	for _, kind := range [][2]string{{"college", "university"}, {"hospital", "hospital"}, {"bus_stop", "bus_station"}, {"park", "park"}, {"gym", "gym"}, {"restaurant", "restaurant"}, {"pharmacy", "pharmacy"}} {
		res := c.fetch(ctx, "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location="+coord(at.Lat)+","+coord(at.Lng)+
			"&radius="+strconv.Itoa(nearbyRadius)+"&type="+kind[1]+"&key="+url.QueryEscape(c.GoogleKey), nil)
		if res == nil {
			continue
		}
		var data struct {
			Results []struct {
				Geometry struct {
					Location Coordinates `json:"location"`
				} `json:"geometry"`
				Name string `json:"name"`
			} `json:"results"`
		}
		ok := res.StatusCode/100 == 2 && json.NewDecoder(res.Body).Decode(&data) == nil
		res.Body.Close()
		if !ok {
			continue
		}
		for i, r := range data.Results {
			if i == 5 {
				break
			}
			places = append(places, place(at, r.Geometry.Location, r.Name, kind[0]))
		}
	}
	return closest(places)
}
