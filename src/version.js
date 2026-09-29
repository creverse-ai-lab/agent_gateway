export const GATEWAY_VERSION = "1.6.0";
// Control-plane API contract version. Bump only on a breaking change to a
// control response shape or method set, never for additive fields.
export const GATEWAY_API_VERSION = 1;
// Persisted state schema version. Bump only when the persisted shape becomes
// incompatible with the previous reader. v5 = state.snapshot.json + state.wal.ndjson.
export const STATE_SCHEMA_VERSION = 5;
// The shape still written to state.json alongside v5, as downgrade insurance: an
// older daemon rolled back onto this machine reads it and recovers every session.
// Retained through 1.5.x for explicit 1.4.0 rollback compatibility.
export const LEGACY_STATE_SCHEMA_VERSION = 4;

// Numeric major.minor.patch order of two release labels (-1, 0 or 1); null
// when either does not parse. A suffix such as -rc.1 is ignored.
export function compareReleases(left, right) {
  const a = releaseParts(left);
  const b = releaseParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function releaseParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(value));
  return match ? match.slice(1, 4).map(Number) : null;
}
