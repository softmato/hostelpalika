/**
 * "Did you mean ram@gmail.com?" for the admission form's login email.
 *
 * The address a warden types becomes the resident's login, so `gmial.com` or
 * `gmail.con` silently opens an account nobody can sign in to. A one-tap
 * suggestion catches that without an OTP step.
 *
 * Only the domain is checked: the part before `@` can't be guessed.
 */

const COMMON = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"];

/** Real providers one or two letters away from a common one — never "fixed". */
const REAL = new Set([...COMMON, "mail.com", "ymail.com", "email.com", "gmx.com", "live.com", "aol.com", "proton.me", "protonmail.com"]);

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
}

/** The corrected address, or `null` when it looks right (or can't be read). */
export function suggestEmail(raw: string): string | null {
  const addr = raw.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1) return null;
  const domain = addr.slice(at + 1);
  if (!domain || REAL.has(domain)) return null;
  // "gmail" with no ".com" at all.
  const bare = COMMON.find((d) => d.split(".")[0] === domain);
  if (bare) return `${addr.slice(0, at)}@${bare}`;
  let best: string | null = null;
  let bestScore = 3;
  for (const d of COMMON) {
    const score = distance(domain, d);
    if (score < bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best ? `${addr.slice(0, at)}@${best}` : null;
}
