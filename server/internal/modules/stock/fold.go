package stock

import (
	"math"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// stock-balance.ts: the arithmetic of the ledger, with no database in it. What is
// left is the sum of the movements; nothing is stored.

// jsRound is Math.round.
func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

// atPlace is ItemAtPlace, in the key order the screens read.
type atPlace struct {
	Adjusted, AdjustedValue, Bought, BoughtValue, Closing float64
	Counted                                               *float64
	CountedAt                                             *time.Time
	In, Left, OnWay, Opening, Out, Short                  float64
	Used, UsedValue, Wasted, WastedValue                  float64
}

type event struct {
	at     time.Time
	item   bson.ObjectID
	move   string
	place  bson.ObjectID
	qty    float64
	rate   *float64
	sent   float64
	system *float64
	when   string
}

type fold struct {
	avg    map[bson.ObjectID]*float64
	byItem map[bson.ObjectID]map[bson.ObjectID]*atPlace
}

func (f *fold) at(item bson.ObjectID, place bson.ObjectID) *atPlace {
	byPlace := f.byItem[item]
	if byPlace == nil {
		byPlace = map[bson.ObjectID]*atPlace{}
		f.byItem[item] = byPlace
	}
	row := byPlace[place]
	if row == nil {
		row = &atPlace{}
		byPlace[place] = row
	}
	return row
}

// figures is the row for an item in a place, or an empty one (emptyAtPlace).
func (f *fold) figures(item, place bson.ObjectID) atPlace {
	if row := f.byItem[item][place]; row != nil {
		return *row
	}
	return atPlace{}
}

// periodOf is hostelPeriodOf for an entry's own day.
func periodOf(t time.Time) string {
	p, _ := bs.PeriodOf(t)
	return p
}

// foldStock walks every building's movements (the average cost is the group's) and keeps
// figures for `places`. `from`..`to` are BS periods, inclusive: the month on screen or a range.
func foldStock(entries []entry, kinds map[bson.ObjectID]string, places []bson.ObjectID, from, to string) *fold {
	wanted := map[bson.ObjectID]bool{}
	for _, p := range places {
		wanted[p] = true
	}
	f := &fold{avg: map[bson.ObjectID]*float64{}, byItem: map[bson.ObjectID]map[bson.ObjectID]*atPlace{}}
	type way struct {
		item, place bson.ObjectID
		qty         float64
	}
	var onWay []way
	var events []event
	for i := range entries {
		e := &entries[i]
		if e.Status == "CANCELLED" || (e.Kind == "COUNT" && e.Status == "PENDING") {
			continue
		}
		when := "in"
		if p := periodOf(e.On); p < from {
			when = "before"
		} else if p > to {
			when = "after"
		}
		for _, l := range e.Lines {
			if _, ok := kinds[l.ItemID]; !ok {
				continue
			}
			base := event{at: e.CreatedAt, item: l.ItemID, place: e.HostelID, qty: l.Qty, rate: l.Rate, system: l.SystemQty, when: when}
			move := map[string]string{"BUY": "buy", "OPENING": "opening", "USE": "use", "WASTE": "waste", "COUNT": "count"}[e.Kind]
			if e.Kind == "SEND" {
				base.move = "sendOut"
				events = append(events, base)
				if e.ToHostelID != nil {
					if e.Status == "PENDING" {
						onWay = append(onWay, way{l.ItemID, *e.ToHostelID, l.Qty})
					} else {
						recv := base
						recv.at = e.CreatedAt
						if e.ReceivedAt != nil {
							recv.at = *e.ReceivedAt
						}
						recv.move, recv.place, recv.qty, recv.sent = "receive", *e.ToHostelID, l.Qty, l.Qty
						if l.ReceivedQ != nil {
							recv.qty = *l.ReceivedQ
						}
						events = append(events, recv)
					}
				}
				continue
			}
			if move == "" {
				continue
			}
			base.move = move
			events = append(events, base)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].at.Before(events[j].at) })

	type key struct{ item, place bson.ObjectID }
	groupQty := map[bson.ObjectID]float64{}
	left := map[key]float64{}
	periodDelta := map[key]float64{}
	for _, ev := range events {
		k := key{ev.item, ev.place}
		before := left[k]
		cost := f.avg[ev.item]
		held := groupQty[ev.item]
		var delta float64
		switch ev.move {
		case "buy", "opening":
			delta = ev.qty
			if ev.rate != nil && ev.qty > 0 {
				var v float64
				if cost == nil || held <= 0 {
					v = *ev.rate
				} else {
					v = (held**cost + ev.qty**ev.rate) / (held + ev.qty)
				}
				f.avg[ev.item] = &v
			}
		case "receive":
			delta = ev.qty
		case "use", "waste", "sendOut":
			delta = -ev.qty
		case "count":
			if ev.system != nil {
				delta = ev.qty - *ev.system
			} else {
				delta = ev.qty - before
			}
		}
		left[k] = before + delta
		groupQty[ev.item] = held + delta
		if !wanted[ev.place] {
			continue
		}
		target := f.at(ev.item, ev.place)
		unitCost := 0.0
		if cost != nil {
			unitCost = *cost
		}
		if ev.move == "count" {
			q, at := ev.qty, ev.at
			target.Counted, target.CountedAt = &q, &at
		}
		if ev.when == "before" {
			target.Opening += delta
			continue
		}
		if ev.when == "after" {
			continue
		}
		periodDelta[k] += delta
		switch ev.move {
		case "buy":
			target.Bought += ev.qty
			rate := unitCost
			if ev.rate != nil {
				rate = *ev.rate
			}
			target.BoughtValue += ev.qty * rate
			target.In += ev.qty
		case "opening":
			target.In += ev.qty
		case "receive":
			target.In += ev.qty
			target.Short += math.Max(0, ev.sent-ev.qty)
		case "sendOut":
			target.Out += ev.qty
		case "use":
			target.Used += ev.qty
			target.UsedValue += ev.qty * unitCost
		case "waste":
			target.Wasted += ev.qty
			target.WastedValue += ev.qty * unitCost
		case "count":
			target.Adjusted += delta
			target.AdjustedValue += delta * unitCost
		}
	}
	for _, w := range onWay {
		if wanted[w.place] {
			f.at(w.item, w.place).OnWay += w.qty
		}
	}
	for item, byPlace := range f.byItem {
		daily := kinds[item] == "DAILY"
		cost := 0.0
		if c := f.avg[item]; c != nil {
			cost = *c
		}
		for place, t := range byPlace {
			k := key{item, place}
			t.Left = left[k]
			t.Closing = t.Opening + periodDelta[k]
			if daily {
				t.Used = math.Max(0, t.In-t.Out)
				t.UsedValue = t.Used * cost
				t.Left, t.Opening, t.Closing = 0, 0, 0
			}
			for _, p := range []*float64{&t.Adjusted, &t.Bought, &t.Closing, &t.In, &t.Left, &t.OnWay, &t.Opening, &t.Out, &t.Short, &t.Used, &t.Wasted} {
				*p = roundQty(*p)
			}
			for _, p := range []*float64{&t.AdjustedValue, &t.BoughtValue, &t.UsedValue, &t.WastedValue} {
				*p = jsRound(*p)
			}
		}
	}
	for item := range kinds {
		if c := f.avg[item]; c != nil {
			v := jsRound(*c*100) / 100
			f.avg[item] = &v
		}
	}
	return f
}

// avgCost is the weighted average cost per unit, or nil if no Bought ever had a price.
func (f *fold) avgCost(item bson.ObjectID) *float64 { return f.avg[item] }

type ledgerBill struct {
	createdAt, on time.Time
	id            string
	paid, total   float64
	status        string
}

type ledgerPayment struct {
	amount        float64
	createdAt, on time.Time
	id, status    string
}

type ledgerRow struct {
	balance, change float64
	createdAt, on   time.Time
	id, kind        string
}

type ledgerOut struct {
	billed, due, paid float64
	rows              []ledgerRow
}

// supplierLedger: bills (credit) against payments (debit), oldest first, each with the balance after it.
func supplierLedger(openingDue float64, bills []ledgerBill, payments []ledgerPayment, openedAt time.Time) ledgerOut {
	var rows []ledgerRow
	out := ledgerOut{}
	for _, b := range bills {
		if b.status == "CANCELLED" {
			continue
		}
		rows = append(rows, ledgerRow{change: b.total - b.paid, createdAt: b.createdAt, id: b.id, kind: "BILL", on: b.on})
		out.billed += b.total
		out.paid += b.paid
	}
	for _, p := range payments {
		if p.status == "CANCELLED" {
			continue
		}
		rows = append(rows, ledgerRow{change: -p.amount, createdAt: p.createdAt, id: p.id, kind: "PAYMENT", on: p.on})
		out.paid += p.amount
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if !rows[i].on.Equal(rows[j].on) {
			return rows[i].on.Before(rows[j].on)
		}
		return rows[i].createdAt.Before(rows[j].createdAt)
	})
	balance := openingDue
	if openingDue != 0 {
		out.rows = append(out.rows, ledgerRow{balance: balance, change: openingDue, createdAt: openedAt, id: "opening", kind: "OPENING", on: openedAt})
	}
	for _, r := range rows {
		balance += r.change
		r.balance = balance
		out.rows = append(out.rows, r)
	}
	out.due = balance
	return out
}

type usageEntry struct {
	byCook         bool
	day            string
	hostel, toHost bson.ObjectID
	hasTo          bool
	kind, status   string
	lines          []line
}

type usageRow struct {
	ByCook, Used, Wasted float64
	Day                  string
	Hostel, Item         bson.ObjectID
}

// usageRows: what was used and thrown away per day, item and building between two days inclusive.
func usageRows(entries []usageEntry, kinds map[bson.ObjectID]string, places []bson.ObjectID, from, to string) []usageRow {
	wanted := map[bson.ObjectID]bool{}
	for _, p := range places {
		wanted[p] = true
	}
	type key struct {
		day         string
		hostel, itm bson.ObjectID
	}
	rows := map[key]*usageRow{}
	add := func(day string, hostel, item bson.ObjectID, used, wasted, byCook float64) {
		if !wanted[hostel] {
			return
		}
		k := key{day, hostel, item}
		r := rows[k]
		if r == nil {
			r = &usageRow{Day: day, Hostel: hostel, Item: item}
			rows[k] = r
		}
		r.Used += used
		r.Wasted += wasted
		r.ByCook += byCook
	}
	for _, e := range entries {
		if e.status == "CANCELLED" || e.day < from || e.day > to {
			continue
		}
		for _, l := range e.lines {
			kind, ok := kinds[l.ItemID]
			if !ok {
				continue
			}
			if kind == "STORE" {
				if e.kind == "USE" {
					cook := 0.0
					if e.byCook {
						cook = l.Qty
					}
					add(e.day, e.hostel, l.ItemID, l.Qty, 0, cook)
				}
				if e.kind == "WASTE" {
					add(e.day, e.hostel, l.ItemID, 0, l.Qty, 0)
				}
				continue
			}
			if e.kind == "BUY" || e.kind == "OPENING" {
				add(e.day, e.hostel, l.ItemID, l.Qty, 0, 0)
			}
			if e.kind == "SEND" {
				add(e.day, e.hostel, l.ItemID, -l.Qty, 0, 0)
				if e.hasTo && e.status == "RECEIVED" {
					got := l.Qty
					if l.ReceivedQ != nil {
						got = *l.ReceivedQ
					}
					add(e.day, e.toHost, l.ItemID, got, 0, 0)
				}
			}
		}
	}
	out := []usageRow{}
	for _, r := range rows {
		r.ByCook, r.Used, r.Wasted = roundQty(math.Max(0, r.ByCook)), roundQty(math.Max(0, r.Used)), roundQty(r.Wasted)
		if r.Used > 0 || r.Wasted > 0 {
			out = append(out, *r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Day != b.Day {
			return a.Day > b.Day
		}
		if a.Item != b.Item {
			return a.Item.Hex() < b.Item.Hex()
		}
		return a.Hostel.Hex() < b.Hostel.Hex()
	})
	return out
}

// reportFigures is one item over a report's range, every building asked about summed.
type reportFigs struct {
	Bought, BoughtValue float64
	Left                *float64
	NextQty             float64
	NextValue           *float64
	Used, UsedValue     float64
	Wasted, WastedValue float64
}

func reportFigures(at []atPlace, kind string, avgCost *float64, days, nextDays int) reportFigs {
	sum := func(pick func(atPlace) float64) (t float64) {
		for _, r := range at {
			t += pick(r)
		}
		return t
	}
	used := sum(func(r atPlace) float64 { return r.Used })
	wasted := sum(func(r atPlace) float64 { return r.Wasted })
	nextQty := ((used + wasted) / math.Max(1, float64(days))) * float64(nextDays)
	out := reportFigs{
		Bought:      roundQty(sum(func(r atPlace) float64 { return r.Bought })),
		BoughtValue: jsRound(sum(func(r atPlace) float64 { return r.BoughtValue })),
		NextQty:     roundQty(nextQty),
		Used:        roundQty(used),
		UsedValue:   jsRound(sum(func(r atPlace) float64 { return r.UsedValue })),
		Wasted:      roundQty(wasted),
		WastedValue: jsRound(sum(func(r atPlace) float64 { return r.WastedValue })),
	}
	if kind == "STORE" {
		l := roundQty(sum(func(r atPlace) float64 { return r.Left }))
		out.Left = &l
	}
	if avgCost != nil {
		v := jsRound(nextQty * *avgCost)
		out.NextValue = &v
	}
	return out
}
