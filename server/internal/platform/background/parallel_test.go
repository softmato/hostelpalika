package background

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestParallelSurvivesAPanic(t *testing.T) {
	var ran atomic.Int32
	Parallel(context.Background(),
		func() { ran.Add(1) },
		func() { panic("one send failed") },
		func() { ran.Add(1) },
	)
	if ran.Load() != 2 {
		t.Fatalf("the others must still run: %d", ran.Load())
	}
}

func TestTaskHasADeadline(t *testing.T) {
	r := &Runner{}
	got := make(chan bool, 1)
	r.Go(context.Background(), func(ctx context.Context) error {
		d, ok := ctx.Deadline()
		got <- ok && time.Until(d) <= taskDeadline
		return errors.New("logged and dropped")
	})
	if !<-got {
		t.Fatal("a background task must have a deadline")
	}
	if err := r.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}
