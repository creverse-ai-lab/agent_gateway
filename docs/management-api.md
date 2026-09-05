# Gateway 1.5.0 management contract

ACP Gateway is the engine. AgenLynk and other consumers render and invoke this contract; they must not independently implement execution, retention, provider or permission policy. API major remains 1 and state schema remains 5. New capability discovery is on **full** `setup`, leaving summary payload costs unchanged.

## Public boundary

Import `GatewayRpcClient`, `GatewayError`, `ERROR_CODES`, `GATEWAY_API_VERSION` from `acp-gateway/client`. No private engine imports are needed. `client.call(method, arguments, timeoutMs, {signal})` returns the RPC result or throws an error with stable `code` and optional `details`. A failed call is never evidence that an already-started worker did not execute; use the Task handle and idempotency key to reconcile.

`GatewayRpcClient({token, rootId, access: "control"|"observer", autoStart})` defaults to control for old consumers. Role is bound on the first authenticated request and cannot change on that connection. Observer uses the existing token, so this is server-enforced read-only behavior, **not** a separate credential boundary against an actor that possesses the control token.

Observer calls: setup without provider/refresh; session list/get; config list without worker restore; poll; task_get/list/result; inbox list/get; subscribe/unsubscribe; gateway_config get; provider list; retention_preview. All other calls fail with `OBSERVER_ACCESS_DENIED`. Observer traffic never attaches owner presence or touches owner activity. Credentials are still required for every method except public guide.

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

`daemon_shutdown {}` now uses the same safe default. `daemon_shutdown {force:true}` is an explicit destructive override for trusted control clients. OS SIGTERM/SIGINT remain unconditional shutdown. Force can interrupt workers; it does not claim their external side effects were rolled back.

Consumer restart sequence: close automatic subscription clients; request safe shutdown; wait for old process/socket/lock to exit; select/start the intended runtime; reconnect and verify build identity and active settings. A successful shutdown is not itself a new runtime activation, and saving config does not restart either application or engine. Legacy 1.4 daemons do not enforce this new safe shutdown contract; require capability before presenting it as safe.

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

Release builders require v1.5.0 plus an independently supplied reviewed source SHA; verifiers require the same SHA. Existing v1.4.0's historical pin is retained. New archives use the public client and engine from the same source commit. Checksums and local unsigned build records are not signed provenance; the separate release workflow attests and verifies before publishing without overwriting assets.
