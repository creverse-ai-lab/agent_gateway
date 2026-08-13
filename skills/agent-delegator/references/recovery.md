# Recovery

## The one rule

Retry with the handle, never with the prompt. `agent_acp_run {taskId}` cannot start the work twice because it carries no prompt. Re-sending `{sessionId, prompt}` after a timeout, a transport error, or a host reconnect can, because by then the first turn may have finished and left the session idle and promptable.

If the work is expensive to duplicate and you have no handle yet, pass `idempotencyKey` on the first `agent_acp_run`: a repeat with the same key on the same session attaches to the existing run. The last eight keys per session are remembered, and they do not survive a Gateway restart (a restart fails the task anyway).

## Failure triage

| Symptom | What it means | Do |
|---|---|---|
| `status: "working"`, `incomplete: "wait_budget_exceeded"` | the wait ended, the turn did not | `agent_acp_run {taskId}` with a longer `waitMs` |
| `SESSION_ACTIVE` | a turn is already running in this session | attach with the existing `taskId`, or poll; never start a second prompt |
| `PROMPT_TOO_LARGE` | over `limits.maxPromptBytes` from `session_open` | shrink the prompt or pass material by path; no turn was started |
| `PERSISTENCE_UNHEALTHY` | the Gateway cannot durably record a handle | do not retry in a loop; surface it — the alert is in `setup().alerts` |
| `UNKNOWN_TASK` | the TTL elapsed or the handle was swept | the outcome is gone; re-run the work deliberately |
| `TASK_NOT_COMPLETE` | a result was read before the task ended | wait for terminal, honouring `pollInterval` |
| `status: "error"` / `unavailable` | the turn or the provider failed | read `error`, collect what exists, then restore or re-run |
| `disconnected` | the worker process is gone | collect retained results and inbox history, then reuse the session — prompt and config reconnect automatically for a resumable provider |

## Restore and inspect

- Reuse a relevant `sessionId` for follow-up work. Prompt and config attempt reconnect automatically for a resumable disconnected provider; a failed automatic restore leaves the session `unavailable`.
- Use `agent_acp_session_restore` only to register or explicitly restore a known raw provider `acpSessionId`, preferring `method: "auto"`. Inspect existing Gateway sessions first, and never register the same provider session twice.
- `agent_acp_session {action: "list"| "get"}` before opening duplicates. Ask for `includeTranscript` or `includeEvents` only when needed; raw event `data` is omitted, and surviving `dataArtifact` pointers hold the complete payloads.
- Pin only while retention must be suspended, then unpin.
- Close a specific disposable non-active session after recovering evidence. Closing an active session also cancels it, so normally cancel and poll first.
- `clean` immediately deletes every owned session that is neither active nor idle, including `disconnected`, `unavailable`, `error`, and `cancelled`. Never clean a session that may still need restoration or evidence recovery.

## After a Gateway restart

- In-flight tasks come back `failed` with a restart message; unresolved inbox items come back `interrupted`. Both are readable — they are the audit trail, not something to answer.
- Terminal task handles and their results survive until their own TTL, so a completed run is still collectable across a restart.
- Sessions come back `disconnected`. Restore or re-run; do not assume the Worker kept any context the ACP provider did not persist.

## After a Gateway update

The host caches this MCP server's tool list for the life of a session, and a daemon restart swaps only the socket — so a new tool or argument stays invisible until the host reconnects.

1. Update the Gateway, then update the skill (`--update-skill`, adding `--force` if it was customized).
2. Reconnect the front door: Claude `/mcp reconnect` or a new session; Codex, Grok, Auggie need a new session.
3. Verify: `agent_acp_run` is in the tool list, and no response carries `staleFrontDoor`.

`staleFrontDoor` on a `setup` or `session_open` response reports `frontDoorVersion` and `gatewayVersion`. Do not parse either as semver to decide compatibility — they are release labels, and the check is exact equality.
