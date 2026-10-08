# Recovery

## The one rule

Retry with the handle, never with the prompt. `agent_acp_run {taskId}` cannot start the work twice because it carries no prompt. Re-sending `{sessionId, prompt}` after a timeout, a transport error, or a host reconnect can, because by then the first turn may have finished and left the session idle and promptable.

If the work is expensive to duplicate and you have no handle yet, pass `idempotencyKey` on the first `agent_acp_run`: a repeat with the same key on the same session attaches to the existing durable Task, including after a Gateway restart, until that Task expires.

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
| `SESSION_QUARANTINED` | the session failed to restore `failures` times in a row; the Gateway stopped retrying it | pick from `details.next`: `check` it, retry once with `agent_acp_session_restore` (same provider, acpSessionId, cwd), or open a new session |
| `NOT_SESSION_OWNER` | the session belongs to another Main, possibly your own from before a restart | if it was yours, take it back as in "After you come back as a new Main" below; otherwise leave it |
| `WORKER_CONTROL_DENIED` | you are running inside a Gateway Worker; Workers never get the Control | do not retry; report back to the Main that gave you the work |
| `SOCKET_UNTRUSTED` | the Gateway socket path holds something this user does not own; nothing was sent | surface it: the user removes a stale file there, or sets `ACP_GATEWAY_SOCKET` to a directory only they can write |
| `DAEMON_IDENTITY_INVALID` | the daemon did not get its identity when it was started | retry the call once, which starts it again; if it recurs, surface it |
| `disconnected` | the worker process is gone | collect retained results and inbox history, then reuse the session — prompt and config reconnect automatically for a resumable provider |

## Restore and inspect

- Reuse a relevant `sessionId` for follow-up work. Prompt and config attempt reconnect automatically for a resumable disconnected provider; a failed automatic restore leaves the session `unavailable`.
- Use `agent_acp_session_restore` only to register or explicitly restore a known raw provider `acpSessionId`, preferring `method: "auto"`. Inspect existing Gateway sessions first; naming one you already hold restores that record in place instead of registering it twice. The same call takes back a session your earlier Main held (see below).
- `agent_acp_session {action: "list"| "get"}` before opening duplicates. Ask for `includeTranscript` or `includeEvents` only when needed; raw event `data` is omitted, and surviving `dataArtifact` pointers hold the complete payloads.
- Pin only while retention must be suspended, then unpin.
- Close a specific disposable non-active session after recovering evidence. Closing an active session also cancels it, so normally cancel and poll first.
- `clean` immediately deletes every owned session that is neither active nor idle, including `disconnected`, `unavailable`, `error`, and `cancelled`. Never clean a session that may still need restoration or evidence recovery.

## After a Gateway restart

- In-flight tasks come back `failed` with a restart message; unresolved inbox items come back `interrupted`. Both are readable — they are the audit trail, not something to answer.
- Terminal task handles and their results survive until their own TTL, so a completed run is still collectable across a restart.
- Sessions come back `disconnected`. Restore or re-run; do not assume the Worker kept any context the ACP provider did not persist.

## After you come back as a new Main

Each Main reaches only the sessions it opened, and a Main is its CLI session (for Codex, its thread). A new conversation is a new Main, and so is a restarted front door that sends no session id (Auggie, Claude Code without `CLAUDE_CODE_SESSION_ID`, Codex calls without thread metadata). Your earlier sessions are then missing from `agent_acp_session {action: "list"}`, and naming one answers `NOT_SESSION_OWNER`. Do not open duplicates; take them back:

1. Get each session's `provider`, `acpSessionId` and `cwd`. Every `agent_acp_session_open` and `agent_acp_session_restore` answer in the earlier conversation carries them. Otherwise ask the user to read them from a management view that lists every session on the Gateway, such as AgenLynk (`acp-gateway-admin` has no session listing).
2. Call `agent_acp_session_restore` with exactly those three. Nothing else hands a session over: not list, get, poll, or a subscription.
3. It works once the earlier Main is gone, that is when its front door is no longer connected. For Codex that front door serves every thread of the process, so another thread cannot take the session while that Codex process runs. While the earlier Main is there, the answer stays `NOT_SESSION_OWNER`: finish the work there or end that conversation, and do not retry in a loop.
4. Read the answer. A restored session now carries `openedBy` (you) and `adoptedFrom` (the earlier Main). `INVALID_ARGUMENT` "already registered" with `details.sessionId` means its Worker was still connected: the session is yours now, under that id. `SESSION_ACTIVE` means a turn is still running: poll it.
5. Its tasks and requests came with it. Call `agent_acp_inbox {action: "attention"}`: it lists the requests waiting on you and the finished runs whose result never reached you; collect each with `agent_acp_run {taskId}`.

Repeating the restore is harmless. If the Gateway crashed right after it, the session can be back with the earlier Main; the same restore takes it again.

## After a Gateway update

The host caches this MCP server's tool list for the life of a session, and a daemon restart swaps only the socket — so a new tool or argument stays invisible until the host reconnects.

1. Update the Gateway, then update the skill (`--update-skill`, adding `--force` if it was customized).
2. Reconnect the front door: Claude `/mcp reconnect` or a new session; Codex, Grok, Auggie need a new session.
3. Verify: `agent_acp_run` is in the tool list, and no response carries `staleFrontDoor`.

`staleFrontDoor` on a `setup` or `session_open` response reports `frontDoorVersion`, `gatewayVersion`, `action` and, when the two order, `reason`. Follow `action` rather than parsing the versions yourself. `reason: "front_door_older"` (or no `reason`) means reconnect as above. `reason: "gateway_older"` means the daemon predates the front door: reconnecting reattaches to the same daemon, so restart it when idle as `action` describes; the next `agent-acp` call starts the front door's version.
