package backup

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Drive is google-drive.ts: Google Drive, appDataFolder only. The scope is
// drive.appdata, a hidden folder only this app can see in the owner's Drive.
type Drive struct {
	ClientID, ClientSecret string
	// Base URLs, swapped in tests.
	AuthURL, TokenURL, RevokeURL, FilesURL, UploadURL string
	HTTP                                              *http.Client
}

const driveScope = "https://www.googleapis.com/auth/drive.appdata"

func NewDrive(id, secret string) *Drive {
	return &Drive{ClientID: id, ClientSecret: secret,
		AuthURL:   "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:  "https://oauth2.googleapis.com/token",
		RevokeURL: "https://oauth2.googleapis.com/revoke",
		FilesURL:  "https://www.googleapis.com/drive/v3/files",
		UploadURL: "https://www.googleapis.com/upload/drive/v3/files",
		HTTP:      &http.Client{Timeout: 100 * time.Second}}
}

// A DriveError is TS's DriveError: status 502, errorCode REVOKED | QUOTA_FULL | ERROR | NOT_CONFIGURED.
func driveErr(code, message string) *httpx.Error { return httpx.NewError(502, code, message, nil) }

// driveCode is the DriveError code of err, "" when err is not one.
func driveCode(err error) string {
	var e *httpx.Error
	if errors.As(err, &e) && e.Status == 502 {
		return e.ErrorCode
	}
	return ""
}

func (d *Drive) Configured() bool { return d.ClientID != "" && d.ClientSecret != "" }

func (d *Drive) client() error {
	if !d.Configured() {
		return driveErr("NOT_CONFIGURED", "Google Drive backup is not set up on this server yet.")
	}
	return nil
}

func (d *Drive) AuthLink(state, redirectURI string) (string, error) {
	if err := d.client(); err != nil {
		return "", err
	}
	// TS's keys are already alphabetical, so Encode's sorting keeps its order.
	q := url.Values{"access_type": {"offline"}, "client_id": {d.ClientID}, "include_granted_scopes": {"true"}, "prompt": {"consent"},
		"redirect_uri": {redirectURI}, "response_type": {"code"}, "scope": {driveScope + " email"}, "state": {state}}
	return d.AuthURL + "?" + q.Encode(), nil
}

// failure reduces Google's error body to what we act on; never the request, it holds tokens.
func failure(res *http.Response, what string) error {
	var body struct {
		Error json.RawMessage `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&body)
	var reason string
	if json.Unmarshal(body.Error, &reason) != nil {
		var nested struct {
			Errors []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		}
		if json.Unmarshal(body.Error, &nested) == nil && len(nested.Errors) > 0 {
			reason = nested.Errors[0].Reason
		}
	}
	switch {
	case reason == "invalid_grant" || res.StatusCode == 401:
		return driveErr("REVOKED", "Google Drive access was removed. Connect Drive again.")
	case reason == "storageQuotaExceeded" || reason == "quotaExceeded":
		return driveErr("QUOTA_FULL", "The Google Drive is full. Free some space, then back up again.")
	}
	return driveErr("ERROR", fmt.Sprintf("Google Drive %s failed (%d).", what, res.StatusCode))
}

func (d *Drive) do(req *http.Request, what string, ok func(int) bool) (*http.Response, error) {
	res, err := d.HTTP.Do(req)
	if err != nil {
		return nil, driveErr("ERROR", "Google Drive "+what+" failed.")
	}
	if !ok(res.StatusCode) {
		defer res.Body.Close()
		return nil, failure(res, what)
	}
	return res, nil
}

func ok2xx(s int) bool { return s >= 200 && s < 300 }

type tokens struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func (d *Drive) token(ctx context.Context, params url.Values) (*tokens, error) {
	if err := d.client(); err != nil {
		return nil, err
	}
	params.Set("client_id", d.ClientID)
	params.Set("client_secret", d.ClientSecret)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.TokenURL, strings.NewReader(params.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
	res, err := d.do(req, "sign-in", ok2xx)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var t tokens
	if err := json.NewDecoder(res.Body).Decode(&t); err != nil {
		return nil, driveErr("ERROR", "Google Drive sign-in failed (200).")
	}
	return &t, nil
}

// Exchange is exchangeDriveCode: code → refresh token, plus the account's email for the screen.
func (d *Drive) Exchange(ctx context.Context, code, redirectURI string) (email, refresh string, err error) {
	t, err := d.token(ctx, url.Values{"code": {code}, "grant_type": {"authorization_code"}, "redirect_uri": {redirectURI}})
	if err != nil {
		return "", "", err
	}
	if t.RefreshToken == "" || !slices.Contains(strings.Split(t.Scope, " "), driveScope) {
		return "", "", driveErr("ERROR", "Google did not grant Drive access. Tick the Drive box and try again.")
	}
	// Straight from Google's token endpoint over TLS, so the payload is read, not verified.
	if parts := strings.Split(t.IDToken, "."); len(parts) > 1 {
		if raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "=")); err == nil {
			var claims struct {
				Email string `json:"email"`
			}
			if json.Unmarshal(raw, &claims) == nil {
				email = claims.Email
			}
		}
	}
	return email, t.RefreshToken, nil
}

func (d *Drive) AccessToken(ctx context.Context, refresh string) (string, error) {
	t, err := d.token(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}})
	if err != nil {
		return "", err
	}
	return t.AccessToken, nil
}

// Revoke is best effort, as in TS.
func (d *Drive) Revoke(ctx context.Context, refresh string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.RevokeURL+"?token="+url.QueryEscape(refresh), nil)
	if err != nil {
		return
	}
	if res, err := d.HTTP.Do(req); err == nil {
		res.Body.Close()
	}
}

type uploaded struct {
	ID          string `json:"id"`
	MD5Checksum string `json:"md5Checksum"`
	Size        string `json:"size"`
}

// Upload is a resumable upload in one PUT: no 5 MB multipart ceiling.
func (d *Drive) Upload(ctx context.Context, access, name string, file []byte) (*uploaded, error) {
	meta, _ := json.Marshal(map[string]any{"mimeType": "application/octet-stream", "name": name, "parents": []string{"appDataFolder"}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.UploadURL+"?uploadType=resumable&fields=id,md5Checksum,size", bytes.NewReader(meta))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	req.Header.Set("X-Upload-Content-Length", strconv.Itoa(len(file)))
	req.Header.Set("X-Upload-Content-Type", "application/octet-stream")
	start, err := d.do(req, "upload", ok2xx)
	if err != nil {
		return nil, err
	}
	start.Body.Close()
	session := start.Header.Get("Location")
	if session == "" {
		return nil, driveErr("ERROR", "Google Drive upload did not start.")
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, session, bytes.NewReader(file))
	if err != nil {
		return nil, err
	}
	put.Header.Set("Content-Type", "application/octet-stream")
	done, err := d.do(put, "upload", ok2xx)
	if err != nil {
		return nil, err
	}
	defer done.Body.Close()
	var u uploaded
	if err := json.NewDecoder(done.Body).Decode(&u); err != nil {
		return nil, driveErr("ERROR", "Google Drive upload failed (200).")
	}
	return &u, nil
}

// Download hands back the open response; the caller closes it.
func (d *Drive) Download(ctx context.Context, access, fileID string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.FilesURL+"/"+url.PathEscape(fileID)+"?alt=media", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	return d.do(req, "download", ok2xx)
}

func (d *Drive) Delete(ctx context.Context, access, fileID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, d.FilesURL+"/"+url.PathEscape(fileID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	res, err := d.do(req, "delete", func(s int) bool { return ok2xx(s) || s == 404 })
	if err != nil {
		return err
	}
	return res.Body.Close()
}
