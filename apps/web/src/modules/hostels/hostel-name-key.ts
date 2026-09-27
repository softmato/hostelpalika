/**
 * `Study Sanjal Hostel`, `Study Sanjal`, `study-sanjal hostel.` → one key.
 *
 * Case, punctuation, spacing and the generic words a hostel name is padded
 * with are dropped, because those are exactly the ways the same building gets
 * typed twice by two agents — or by one agent on two visits.
 */
export function hostelNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ]+/g, " ")
    .replace(/\b(hostel|hostels|pg|boys|girls|home|house|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
