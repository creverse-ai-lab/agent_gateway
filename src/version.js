export const GATEWAY_VERSION = "1.4.0";
// Control-plane API contract version. Bump only on a breaking change to a
// control response shape or method set, never for additive fields.
export const GATEWAY_API_VERSION = 1;
// Persisted state schema version. Bump only when the persisted shape becomes
// incompatible with the previous reader. v5 = state.snapshot.json + state.wal.ndjson.
export const STATE_SCHEMA_VERSION = 5;
// The shape still written to state.json alongside v5, as downgrade insurance: an
// older daemon rolled back onto this machine reads it and recovers every session.
// Sunsets in 1.5.0.
export const LEGACY_STATE_SCHEMA_VERSION = 4;
