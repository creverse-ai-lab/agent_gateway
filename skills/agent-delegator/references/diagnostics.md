# Diagnostics, paging, and contract mismatches

## Response profiles

Per call, never sticky. Check `responseProfiles` on the `session_open` or `setup` response first; if the key is absent the Gateway is older and every profile argument is silently ignored.

- `current` — the default and the frozen shape. Omitting the argument and sending `"current"` produce the same bytes.
- `compact` — `{ok, sessionId, turnId, status, nextCursor, events}` plus `result` when the turn is terminal. `filteredCount` and `cursorTruncated` appear only when non-zero and true, so their absence is information. `stopReason` moves inside `result`, because an active turn does not have one.
- `diagnostic` — everything in `current` plus `queue` (`depth`, and `reserved` when a command has been admitted but has not yet changed status), `illegalTransitions` for this session, and `pending` counts of unanswered permissions and elicitations. On a result it also includes `usageSummary` and `inspection` without asking. Use it when a session is behaving unexpectedly, not routinely.

An unknown profile name is rejected with `INVALID_ARGUMENT`, so a typo cannot be mistaken for a silent downgrade.

## Paging events

- `maxEvents` counts delivered events and defaults to 200 with a cap of 1000; trust the live schema after an upgrade. `nextCursor` also advances over filtered-out events, so keep paging until the cursor reaches the live end or your `toCursor`.
- `toCursor` makes the read a bounded retrospective range, and a bounded read never waits.
- `eventTypes` matches exactly, with a trailing `*` for prefixes: `["tool_call"]` excludes updates, `["tool_call*"]` includes `tool_call_update`.
- `usage_update` is never delivered or retained as an event; use `includeUsage`.

## Paging the inbox

`agent_acp_inbox {action: "list"}` with no paging arguments returns every matching row, exactly as it always has. Passing `limit` or `cursor` switches to keyset paging:

- Rows are newest first, and `nextCursor` is `null` on the last page rather than absent — one shape per page.
- Pass the previous `nextCursor` to continue. Rows created between pages are not resurrected into an earlier page and no row is delivered twice.
- Filter with `status`, `sessionId`, and `type`. Filtering alone does not switch on paging.
- `detail: "summary"` drops `options`, `message`, and `requestedSchema` and reduces `toolCall` to its id, title, and kind. It is a projection of the same row, not a different record — use it to survey a backlog, then `action: "get"` on the one row you are about to answer. On a row whose payload already spilled to an artifact the saving is small, because the oversized field is already a pointer.

## Contract mismatches

- On unknown arguments, schema errors, or missing tools, compare the live tool schema against the Gateway version and reconnect the front door. A response carrying `staleFrontDoor` says this explicitly.
- On an active-session error, poll until idle or cancel before changing config or starting another prompt.
- On a model mismatch, distinguish provider default, session-scoped config, prompt-level selection, and process-scoped startup. Stop rather than falling back silently.
- On a provider exit, inspect the existing session plus `pending` and `interrupted` inbox history before restoring or re-prompting. Do not open a duplicate immediately.
- On missing evidence, distinguish event-ring truncation (`cursorTruncated`), result-retention cleanup, Task TTL expiry, artifact rejection, and provider disconnection before retrying work.
- `setup {mode: "summary"}` is the cheap health read: versions, response profiles, persistence health, alerts, providers, and live session count. Use full `setup` when you need `detected` install paths, `resourceLimits`, `lifecycle`, or `metrics`.
