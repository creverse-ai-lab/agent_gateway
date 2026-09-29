# Gateway 1.5.x management contract

ACP Gateway is the engine. AgenLynk and other consumers render and invoke this contract; they must not independently implement execution, retention, provider or permission policy. API major remains 1 and state schema remains 5. New capability discovery is on **full** `setup`, leaving summary payload costs unchanged.

## Public boundary

Import `GatewayRpcClient`, `GatewayError`, `ERROR_CODES`, `GATEWAY_API_VERSION` from `acp-gateway/client`. No private engine imports are needed. `client.call(method, arguments, timeoutMs, {signal})` returns the RPC result or throws an error with stable `code` and optional `details`. A failed call is never evidence that an already-started worker did not execute; use the Task handle and idempotency key to reconcile.

`GatewayRpcClient({token, rootId, access: "control"|"observer", autoStart})` defaults to control for old consumers. Role is bound on the first authenticated request and cannot change on that connection. Observer uses the existing token, so this is server-enforced read-only behavior, **not** a separate credential boundary against an actor that possesses the control token.

Observer calls: setup without provider/refresh; session list/get; config list without worker restore; poll; task_get/list/result; inbox list/get/attention; subscribe/unsubscribe; gateway_config get; provider list; retention_preview. All other calls fail with `OBSERVER_ACCESS_DENIED`. Observer traffic never attaches owner presence or touches owner activity. Credentials are still required for every method except public guide.

## Engine settings

`gateway_config {action:"get"}` (default action) returns:

```json
{
  "ok": true,
  "revision": 0,
  "activeRevision": 0,
  "pendingRestart": false,
  "pendingLiveApply": false,
  "unsupportedLegacySettings": [],
  "options": [
    {
      "id": "idleUnloadMs", "group": "lifecycle", "type": "number",
      "environment": "ACP_GATEWAY_IDLE_UNLOAD_MS", "minimum": 0,
      "defaultValue": 1800000, "currentValue": 1800000,
      "configuredValue": 1800000, "storedValue": null,
      "source": "default", "editable": true,
      "requiresRestart": true, "pending": false
    }
  ]
}
```

The example shows one option; get returns the complete supported catalog. Number values are safe integers. Booleans are JSON booleans and enum options declare `values`. Unknown settings are rejected; arbitrary provider env, commands, secrets and recovery overrides are not exposed as writable settings.

`gateway_config {action:"set", expectedRevision:N, values:{...}}` stages settings. `gateway_config {action:"reset", expectedRevision:N, ids:[...]}` resets selected keys to defaults. Revision mismatch or ENV-locked keys fail with `CONFIG_CONFLICT`. Invalid values/cross-field budgets fail with `CONFIG_INVALID`; unsupported keys use `INVALID_ARGUMENT`. All settings currently require restart, including adapter update policy. Saving is not applying.

Precedence: environment > engine settings file > defaults. If the engine settings file does not yet exist, supported values from legacy `install.json.gatewayConfig` and `agentUpdates` substitute for stored values. The first successful write materializes them into settings.json without rewriting install identity, managed MCP, skill or UI settings. Unsupported legacy engine keys are reported. Once migrated, legacy changes are not imported again. CLI installer update-policy flags write through the same settings store.

Paths: `ACP_GATEWAY_SETTINGS` overrides the engine settings path. Otherwise it is `settings.json` next to `ACP_GATEWAY_INSTALL_STATE` (default `~/.acp-gateway/install.json`). Use explicit paths for isolated deployments. Writes use exclusive locks, fsynced private temporary files, rename and parent-directory fsync. A `CONFIG_BUSY` lock after a crash requires inspecting its recorded PID and confirming no writer exists before removing only that `.write.lock` file. The engine does not silently steal stale-looking locks.

## Providers

- `provider {action:"list"}` returns `{ok,providers}` including boolean `enabled` and installed adapter metadata.
- `provider {action:"set_enabled",provider:"claude",enabled:false}` persists engine policy and returns `{ok,provider,enabled}`. Off blocks **new registrations**, including external session_restore, before starting work and again at registration. Already registered sessions can continue and reconnect. Policy is read per admission, independent of cached worker clients.
- `provider {action:"install",registryId:"claude-acp",dryRun:true}` uses the official Gateway installer. Dry-run is the default; only explicit `dryRun:false` installs. The result is the installer action/warning envelope. Set an adequate RPC timeout for installation. Request cancellation cannot undo an external package-manager operation that already started. Enabling/disabling is a separate operation; installation preserves the current disabled list.

Consumer-owned npm/uv invocations or copies of provider resolver policy are unnecessary. Distribution verification and provider definitions remain in the engine's installer/registry implementation.

## Safe shutdown and applying settings

`shutdown_if_idle {}` rejects with `SHUTDOWN_BLOCKED`, `details.blockers` when active sessions, tasks, unanswered inbox records, pending session admissions, in-flight mutations, provider starts, maintenance or agent updates exist. A successful admission atomically closes mutation admission before acknowledging shutdown. Further mutations fail with `GATEWAY_DRAINING`. A blocked attempt restores admission.

`daemon_shutdown {}` now uses the same safe default. Since 1.5.2 the public client never autostarts a daemon for `daemon_shutdown` or `shutdown_if_idle`; with nothing listening it returns `{ok:true, alreadyStopped:true}`. `daemon_shutdown {force:true}` is an explicit destructive override for trusted control clients. OS SIGTERM/SIGINT remain unconditional shutdown. Force can interrupt workers; it does not claim their external side effects were rolled back.

Consumer restart sequence: close automatic subscription clients; request safe shutdown; wait for old process/socket/lock to exit; select/start the intended runtime; reconnect and verify build identity and active settings. A successful shutdown is not itself a new runtime activation, and saving config does not restart either application or engine. Legacy 1.4 daemons do not enforce this new safe shutdown contract; require capability before presenting it as safe.

## Permission policy enforcement

`permissionPolicy` is enforced on what reaches the Gateway over ACP: file and terminal callbacks and `session/request_permission`. A worker that edits through its own tools without asking bypasses it. For `read_only` and `ask` sessions, the engine selects the worker's advertised `mode` value `read-only` on open and on every restore. When a provider is known to still edit inside its session roots without a request (Codex), `session_open`/restore put a `{level:"warning", code:"permission_policy_partial", provider}` alert first in `relevantAlerts`. Consumers must show it and must not present such a session as edit-proof. The alert is additive; its absence does not certify complete enforcement for other providers.

Since 1.5.2, automatic decisions also depend on paths:
- The engine compares every path a request names (`toolCall.locations[].path`, and `file_path`/`path`/`notebook_path` in `rawInput`) with the session roots, resolving symlinks.
- A path outside the roots is never auto-approved. `read_only` refuses it. `auto_approve` sends it to Main as a normal pending permission request.
- Gateway-protected paths are refused under every policy, including `ask`, and are never shown to a human. They are `~/.acp-gateway`, the install/settings/state directories, and the control socket. `fs/read_text_file`/`fs/write_text_file` refuse them even inside a root.
- When several offered options share the chosen kind, a refusal prefers the one that lets the worker continue (for example Codex `decline` over `cancel`).

Commands are checked as well:
- A permission request's `rawInput.command` and a `terminal/create` command line are refused under every policy when they name a protected path. That covers the literal path and its `~`, `$HOME`, `${HOME}` and quoted spellings, plus any path-looking word that resolves physically into one, such as `link/../.acp-gateway`.
- Other commands keep the policy's normal treatment. `auto_approve` trusts commands inside the roots, because a shell command's file access cannot be verified from its text.

Claude sessions receive `_meta.claudeCode.options.disallowedTools` on `session/new` and on every restore. `read_only` adds `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`, and every policy adds path rules for the protected paths.

The Grok process is started with its cwd in a Gateway-owned directory (`ACP_GATEWAY_GROK_SANDBOX_DIR`, default `~/.cache/acp-gateway/grok-sandbox`) holding `.grok/sandbox.toml`, and with `GROK_SANDBOX=acp-gateway`:
- The profile extends Grok's `workspace` profile and denies every protected path to the whole process, through Seatbelt on macOS and Landlock on Linux.
- It covers Grok's in-process tools such as grep, which never reach ACP.
- Edits and terminals go through ACP and are unaffected.

`permission_policy_partial` carries `scope`, the list of things the engine cannot enforce for that provider and policy: `edit_inside_roots`, `shell_write_inside_roots`, `read_outside_roots`, `read_protected`.
- Codex under `read_only`/`ask` has all four; under `auto_approve` it has the two read scopes.
- Grok has `read_outside_roots`.
- A consumer should treat any capability absent from `scope` as enforced, and anything listed as possible.

## Snapshot workspaces

`session_open {workspace:"snapshot"}` copies `cwd` twice, before the worker starts: a working tree and an untouched baseline, as clonefile/reflink copies where supported. The diff is baseline → tree, so later edits to the original never show up as reversed worker edits. A symlink inside the tree is re-pointed into the copy; one leaving the tree is not copied and is listed in `workspace.droppedLinks`. Protected directories are never copied, and a protected `cwd` is refused. The diff is capped at 64 MiB, beyond which it fails with `WORKSPACE_ERROR`. The copy lives under `ACP_GATEWAY_WORKSPACES`, default `~/.cache/acp-gateway/workspaces`, never under a protected path. The session's `cwd` is the copy, and the response carries `workspace:{mode,source,path}`. Direct sessions have no `workspace` key.

Symlinks are copied as links, and sockets/FIFOs are skipped. The copy is limited to 1 GiB and 200,000 entries; beyond that, or when `cwd` contains the workspace root, the open fails with `WORKSPACE_ERROR`. `additionalDirectories` are not copied.

`session {action:"workspace_diff", sessionId}` returns `{changed, files, patch, patchBytes, truncated, patchArtifact?}`. `patch` is a `git diff --no-index` patch from the original (a/) to the copy (b/), with tree-relative paths, applicable with `git apply` in the original. It is capped at `maxInlineResultBytes`, with the complete patch as an artifact.

The engine never applies the patch. The copy is deleted on close and by session retention. It survives daemon restarts.

## Caller identity

Since 1.6.0 a control request may carry `caller: {provider, sessionId, pid, instanceId}`. The control MCP server fills it once at startup from the agent CLI that spawned it: `provider` from the parent process name (`claude`, `codex`, `grok`, else `null`), `sessionId` from that CLI's exported id (`CLAUDE_CODE_SESSION_ID`, `GROK_SESSION_ID`, `CODEX_THREAD_ID`; Codex exports none to MCP servers, so `null`), `pid` of the parent, and a random `instanceId` per server process. Every Main on a machine shares one `rootId`; `caller` is what tells them apart.

- `openedBy` is the caller of the `session_open` or first `session_restore` that registered the session. It is set once and never rewritten.
- `promptedBy` is the caller of the latest `prompt`, `run` or `task_prompt`. The same value is on that turn's `turn_start` event, so each turn names the Main its reply is for.
- Both appear on session responses, `session list`, and survive restarts. They are absent when the caller sent nothing (pre-1.6.0 control servers), so the old shapes are unchanged.
- Only `control` connections are recorded. An `observer`'s `caller` is ignored. A malformed `caller` drops attribution, never the call.
- `sessionId` can go stale when the CLI switches sessions (for example Claude `/clear`) while the MCP server keeps running; `pid` and `instanceId` stay valid.

## Task links and scope

- `run`, `task_prompt` and `task_run` accept `parentTaskId` (the task this one follows up) and `inputTaskIds` (1 to 16 unique ids of tasks whose results went into the prompt). Every id must name a task on the caller's root; otherwise `INVALID_ARGUMENT` with `details.unknownTaskIds`, and nothing starts. The Gateway records them as declared and never infers links. `prompt` creates no task, so it refuses them, as does a `run` attach (`{taskId}`).
- Task reads carry `parentTaskId`/`inputTaskIds` only when declared. They survive restarts.
- `task_list` filters `parentTaskId`, `callerSessionId`, `callerInstanceId` combine with `status` and paging. Any of them selects the paged response.
- `scope:"mine"` on `session list` and `task_list` keeps records whose `openedBy`/`caller` is the requester: session ids decide when both sides have one, else `instanceId`. Records with no caller are nobody's. A Codex front door that sends no thread id matches by `instanceId`, so its threads are one Main. A request without a caller (observer, pre-1.6.0 front door) gets `INVALID_ARGUMENT`. Without `scope` the lists are unchanged.

## Idempotency and worker errors

A `run` whose `idempotencyKey` already names a run on the same session attaches only when the prompt, model and declared links digest match (input order aside). Otherwise it fails with `IDEMPOTENCY_CONFLICT`, and `details.taskId` holds the existing task. Changing `waitMs` or `resultBudgetBytes` on a retry is not a conflict. Runs recorded before 1.5.2 carry no digest and keep the old attach behavior.

A JSON-RPC error from the worker becomes `ACP_ERROR`, or `UNKNOWN_SESSION` for a `session/load|resume` of a session the worker does not know. The message keeps the historical `ACP error <code>: <message>` text, and `details.{method,acpCode,acpMessage,acpData?}` preserve the original.

## Adapter generations

A process is reused only while its provider definition (command, args including the adapter pin, env) is unchanged. After an adapter update, the old process keeps serving the sessions it holds, new sessions start a process of the current definition, and maintenance stops the old one when it serves nothing. Summary and full `setup` report `started` from real process liveness. `setup {provider}` adds `runningVersion` and `retiredProcesses`.

When `ACP_GATEWAY_STATE` points outside `~/.acp-gateway` and `ACP_GATEWAY_PROVIDERS` is unset, provider definitions and the registry cache live next to that state file. Reads fall back to the global definitions until the first write, which copies them.

## Retention preview

`retention_preview {values:{sessionRetentionMs,taskRetentionMs,inboxRetentionMs,resultRetentionMs}}` accepts any subset of those keys; direct top-level names are also supported. No deletion occurs. Unsupported policies such as artifactSessionLimit are rejected.

Response: `{ok,advisory:true,scope:"root",calculatedAt,configRevision,values,counts:{sessions,tasks,inbox,results},artifacts:{exact:false,reason}}`. Counts use the same predicates as GC and describe records owned by the caller at the supplied policy. Active work and pending input are protected; pinned records are excluded from age retention. Task TTL is a separate, explicit handle lifetime and can still expire independently of pinning.

Preview is advisory: time, new work, references and settings can change before a restart/GC. Do not show it as an immutable deletion plan or a count covering other roots. Artifact reference protection prevents an exact byte/count forecast from age alone. Consumers should not invent artifact counts. In the normal single-user daemon, one root owns the engine's work.

## Replay and result integrity

`subscribe` returns the existing sessions/events/cursorTruncated fields and `replay`, keyed by session ID: `{complete,retainedTruncated,liveOnlyMissing,fromCursor,nextCursor}`. Message/thought chunks remain live-only; retained control/tool events remain bounded. A missing relevant raw chunk now also sets cursorTruncated, so older consumers cannot call that replay complete. Poll remains a retained-result/control view and does not treat intentional absence of raw chunks as poll history loss.

On client reconnect, `subscription_replay_truncated` still notifies callbacks of incomplete history. A gap/reconnect and healthy transport must never imply complete history. After daemon restart, the prior non-persisted event history is explicitly marked truncated. Fetch completed tasks through task_list/task_result and follow bounded artifact pointers for results; do not resubmit prompts to reconstruct a timeline. No persistent raw transcript journal is advertised.

At most 64 subscriptions per root. Invalid cursors fail before registration. Aborting a run wait releases its waiter immediately and leaves the worker running. Only explicit task/session cancellation cancels the worker.

## Runtime identity and invariants

Full setup adds `runtimeRoot`, `gatewayBuildId`, `instanceId`, `sourceCommit`, `configRevision`, and `capabilities`. Build ID hashes the actual src JS file names/bytes at process start, cached for that process. It is not the archive digest or builder commit. Compare like identities; use instanceId to distinguish restarts. sourceCommit is taken from release manifest and null in a source checkout.

Required invariants and validation:

| Invariant | Gate |
|---|---|
| Work has a durable Task handle before ACP dispatch | crash matrix task-create barriers |
| Completed Task results survive restart or explicitly fail durability | result commit/artifact/fsync crash matrix |
| Unknown execution outcomes are not silently retried | restart recovery + idempotency tests |
| Observer cannot mutate or keep an owner alive | engine management + daemon RPC tests |
| Disabled provider cannot start a new registered session | actual public-client tests, including daemon restart |
| Shutdown cannot race a newly admitted open | engine admission race tests |
| Aborted readers free their budget without cancelling work | TaskStore/run cancellation tests |
| GC cannot remove active obligations or referenced artifacts | retention/resource/persistence tests |
| Unrecoverable event history is explicit | replay completeness tests |

Release builders require a v1.5.x tag (v1.5.0 through v1.5.2), v1.6.0 or v1.7.0 plus an independently supplied reviewed source SHA; verifiers require the same SHA. Existing v1.4.0's historical pin is retained. New archives use the public client and engine from the same source commit. Checksums and local unsigned build records are not signed provenance; the separate release workflow attests and verifies before publishing without overwriting assets.
