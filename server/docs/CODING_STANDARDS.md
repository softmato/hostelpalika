# CODING_STANDARDS.md — How Go is written here

## 1. Baseline

- `gofmt` + `goimports` on save; `go vet` and `staticcheck` clean; `golangci-lint`
  with the default set plus `errcheck`, `bodyclose`, `contextcheck`, `noctx`.
- Format only the files you touched.
- Standard library first; then a dependency already in `go.mod`; then a new one
  (with a `CHANGELOG.md` line saying why).

## 2. Naming

- Packages: short, lower-case, no underscores (`bs`, `httpx`, `ratelimit`).
- Module folders keep the TS names; a hyphenated TS name becomes one word or the
  closest Go form (`move-checklist` → `movechecklist`), with the TS name in the
  package comment.
- Exported identifiers say what they are (`IssueInvoices`, not `Process`).
- Errors: `ErrNotFound`-style sentinels for comparisons; `fmt.Errorf("…: %w", err)`
  for context.

## 3. Handler pattern

```go
func (h *Handler) list(c *gin.Context) {
	p := authz.Principal(c) // set by the route's guard middleware
	var q ListQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err) // 422 in zod's shape
		return
	}
	body, etag, err := h.cache.Read(c, p, "notices"+c.Request.URL.RawQuery, func(ctx context.Context) (any, error) {
		return h.svc.List(ctx, q, p)
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKCached(c, body, etag, "Notices loaded")
}
```

Handlers bind, call one service method, respond. No Mongo, no business rules.

## 4. Errors

- Services return typed errors: `httpx.NewError(status, errorCode, message, details)`.
- `httpx.Fail` maps any error to the envelope; unknown errors → 500 + log.
- Never `panic` for control flow; the recover middleware is for bugs.
- Every error from I/O is checked. `_ =` on an error needs a comment.

## 5. Context and goroutines

- Every function doing I/O takes `ctx context.Context` first.
- Never start a bare `go func()`; use `background.Go(name, fn)` so shutdown waits
  for it and panics are recovered and logged.
- Background work gets its own context with a deadline, not the request's.

## 6. Data

- Money: `int64` paisa. A `float64` anywhere near money fails review.
- Time: `time.Time` in UTC; convert to Nepal time only through `internal/platform/bs`.
- IDs: `bson.ObjectID`; parse path params once in the handler, 400/404 as TS does.

## 7. Comments

Say *why*, not *what*. Port the TS comments that explain a non-obvious rule
(there are many — they record real production incidents); drop the ones that
only narrate code.

## 8. Tests

Table-driven, `t.Run` per case, `t.Parallel()` where there's no shared state.
See `TESTING.md`.

## 9. Git

`server/` is gitignored until cut-over. Once it is committed: one PARITY item (or
one platform concern) per commit, message `server(<module>): port <route or concern>`.
