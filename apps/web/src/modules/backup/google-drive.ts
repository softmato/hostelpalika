/**
 * Google Drive, `appDataFolder` only (docs/FIELD_REVIEW_2026_10_27.md I5).
 *
 * The scope is `drive.appdata`: a hidden folder only this app can see, in the
 * owner's own Drive. We never ask for, and cannot read, the rest of their Drive.
 *
 * Plain `fetch` against Google's REST endpoints — four calls do not need the
 * googleapis SDK.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export type DriveErrorCode = "REVOKED" | "QUOTA_FULL" | "ERROR" | "NOT_CONFIGURED";

export class DriveError extends Error {
  status = 502;

  constructor(
    public errorCode: DriveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

/** Its own client if one is set, else the sign-in client — one Google project, one consent screen. */
function client() {
  const id = process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

  if (!id || !secret) {
    throw new DriveError("NOT_CONFIGURED", "Google Drive backup is not set up on this server yet.");
  }

  return { id, secret };
}

export function isDriveConfigured() {
  try {
    return Boolean(client());
  } catch {
    return false;
  }
}

export function driveAuthUrl(state: string, redirectUri: string) {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: client().id,
    include_granted_scopes: "true",
    prompt: "consent", // always hand back a refresh token, also on reconnect
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `${DRIVE_SCOPE} email`,
    state,
  });

  return `${AUTH_URL}?${params}`;
}

/** Google's error body, reduced to what we act on. Never the request — it holds tokens. */
async function failure(response: Response, what: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string | { errors?: Array<{ reason?: string }>; message?: string };
  };
  const reason = typeof body.error === "string" ? body.error : body.error?.errors?.[0]?.reason;

  if (reason === "invalid_grant" || response.status === 401) {
    throw new DriveError("REVOKED", "Google Drive access was removed. Connect Drive again.");
  }

  if (reason === "storageQuotaExceeded" || reason === "quotaExceeded") {
    throw new DriveError("QUOTA_FULL", "The Google Drive is full. Free some space, then back up again.");
  }

  throw new DriveError("ERROR", `Google Drive ${what} failed (${response.status}).`);
}

async function tokenRequest(params: Record<string, string>) {
  const { id, secret } = client();
  const response = await fetch(TOKEN_URL, {
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
    method: "POST",
  });

  if (!response.ok) await failure(response, "sign-in");

  return (await response.json()) as { access_token: string; id_token?: string; refresh_token?: string; scope?: string };
}

/** Code → refresh token, and the Google account's email for the screen. */
export async function exchangeDriveCode(code: string, redirectUri: string) {
  const tokens = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri });

  if (!tokens.refresh_token || !tokens.scope?.split(" ").includes(DRIVE_SCOPE)) {
    throw new DriveError("ERROR", "Google did not grant Drive access. Tick the Drive box and try again.");
  }

  // Straight from Google's token endpoint over TLS, so the payload is read, not verified.
  const payload = tokens.id_token?.split(".")[1];
  const email = payload ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).email as string | undefined) : undefined;

  return { email, refreshToken: tokens.refresh_token };
}

export async function driveAccessToken(refreshToken: string) {
  return (await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken })).access_token;
}

export async function revokeDriveToken(refreshToken: string) {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, { method: "POST" }).catch(() => undefined);
}

/** Resumable upload in one PUT — no 5 MB multipart ceiling. */
export async function uploadToAppData(accessToken: string, name: string, bytes: Uint8Array) {
  const start = await fetch(`${UPLOAD_URL}?uploadType=resumable&fields=id,md5Checksum,size`, {
    body: JSON.stringify({ mimeType: "application/octet-stream", name, parents: ["appDataFolder"] }),
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(bytes.length),
      "x-upload-content-type": "application/octet-stream",
    },
    method: "POST",
  });

  if (!start.ok) await failure(start, "upload");

  const session = start.headers.get("location");

  if (!session) throw new DriveError("ERROR", "Google Drive upload did not start.");

  const done = await fetch(session, { body: new Uint8Array(bytes), headers: { "content-type": "application/octet-stream" }, method: "PUT" });

  if (!done.ok) await failure(done, "upload");

  return (await done.json()) as { id: string; md5Checksum?: string; size?: string };
}

export async function downloadFromAppData(accessToken: string, fileId: string) {
  const response = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) await failure(response, "download");

  return response;
}

export async function deleteFromAppData(accessToken: string, fileId: string) {
  const response = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    method: "DELETE",
  });

  if (!response.ok && response.status !== 404) await failure(response, "delete");
}
