package jobs

import (
	"context"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, Kathmandu)
	if err != nil {
		panic(err)
	}
	return t
}

func TestScheduleMatches(t *testing.T) {
	cases := []struct {
		spec, when string
		want       bool
	}{
		{"* * * * *", "2026-11-03 13:07", true},
		{"*/5 * * * *", "2026-11-03 13:10", true},
		{"*/5 * * * *", "2026-11-03 13:11", false},
		{"*/15 * * * *", "2026-11-03 13:45", true},
		{"0 * * * *", "2026-11-03 13:00", true},
		{"5 * * * *", "2026-11-03 13:00", false},
		{"15 0 * * *", "2026-11-03 00:15", true},
		{"45 8 * * *", "2026-11-03 08:45", true},
		{"45 8 * * *", "2026-11-03 09:45", false},
		{"45 9 * * 1", "2026-11-02 09:45", true}, // Monday
		{"45 9 * * 1", "2026-11-03 09:45", false},
		{"0,30 9-10 * * *", "2026-11-03 10:30", true},
	}
	for _, c := range cases {
		s, err := parseSchedule(c.spec)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.matches(at(c.when)); got != c.want {
			t.Errorf("%q at %s = %v, want %v", c.spec, c.when, got, c.want)
		}
	}
	// The clock is Kathmandu whatever zone the time arrives in.
	s, _ := parseSchedule("15 0 * * *")
	if !s.matches(at("2026-11-03 00:15").UTC()) {
		t.Error("UTC time not read in Kathmandu")
	}
	for _, bad := range []string{"* * * *", "60 * * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"} {
		if _, err := parseSchedule(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestMissedAndNext(t *testing.T) {
	j := &Job{Name: "daily", Schedule: "45 8 * * *"}
	(&Runner{jobs: map[string]*Job{}}).Add(j)
	now := at("2026-11-03 12:00")
	ok := at("2026-11-03 08:45")
	if j.Missed(&ok, now) {
		t.Error("today's run counted as missed")
	}
	old := at("2026-11-02 08:45")
	if !j.Missed(&old, now) {
		t.Error("yesterday's run not missed")
	}
	if !j.Missed(nil, now) {
		t.Error("no run not missed")
	}
	// Right at the due minute the run may still be starting.
	if j.Missed(&old, at("2026-11-03 08:45")) {
		t.Error("due minute counted as missed")
	}
	if n := j.Next(now); n == nil || !n.Equal(at("2026-11-04 08:45")) {
		t.Errorf("next = %v", n)
	}
	if (&Job{}).Next(now) != nil {
		t.Error("on-demand job has a next run")
	}
}

func TestRaiseThrottlesPerJob(t *testing.T) {
	r := &Runner{alerted: map[string]time.Time{}}
	var got []string
	r.OnFailure(func(_ context.Context, job, _ string) { got = append(got, job) })
	r.raise(context.Background(), "billing-cycle", "failed: x")
	r.raise(context.Background(), "billing-cycle", "failed: y") // inside alertEvery: dropped
	r.raise(context.Background(), "platform-push", "timeout: z")
	if len(got) != 2 || got[0] != "billing-cycle" || got[1] != "platform-push" {
		t.Fatalf("alerts = %v, want one per job", got)
	}
}
