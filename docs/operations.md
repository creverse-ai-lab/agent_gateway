# Operations guide

[한국어](operations.ko.md) | **English**

Details on installer options, the update procedure, Worker control, and session and data management that the README does not cover. If you are installing for the first time, start with the Quick start in the [README](../README.md).

## Installing and updating

If a daemon from an earlier version is still running, the installer compares the version in the health response, replaces the daemon automatically, and then checks again. A manual upgrade that runs `git pull` and `npm ci` followed by `--install-all --refresh-registry` is therefore also supported.

To register several agents as orchestrator candidates, you can use `--target all`. This option puts a Control MCP with orchestrator permissions into each agent's configuration, so use it only with local agents you trust.

To review the installation plan again later:

```bash
acp-gateway-bootstrap --install-all --dry-run
```

How you update depends on how the Gateway was installed (see below). In a source checkout it is this one command:

```bash
acp-gateway-bootstrap --update
```

In a source checkout, `--update` fetches the upstream commit, installs and tests it in a temporary worktree (`npm ci`, then `npm run ci`), and only then fast-forwards the checkout. It also checks upstream changes to the ACP protocol and the official registry, and proceeds only once snapshot verification and the full automated test suite pass. It then prints the internal dry-run plan and updates the ACP registry, the adapters, and the MCP registrations. Finally, it restarts the running Gateway daemon on the new version and verifies the actual version. The installation state, the Control identity, and the front door selected at first installation are kept as they are. If the upstream check fails temporarily, it logs a warning but continues the local verification of the source it already fetched, and a test failure aborts the whole update before the daemon is replaced.

`--update` first works out how this Gateway was installed, from where its package sits. Only a source checkout (a directory with `.git`) is pulled and verified as described above. For an npm install (a package inside `node_modules`), `--update` runs neither Git nor npm: it checks the `latest` version of `acp-gateway-daemon` on the npm registry, reports `npm install -g acp-gateway-daemon@latest` when a newer release exists, and then goes straight on to the dry-run plan, the registry, adapter and MCP refresh, and the daemon restart. Install the new release first, then run `--update`:

```bash
npm install -g acp-gateway-daemon@latest
acp-gateway-bootstrap --update
```

An app-managed runtime (under `~/.acp-gateway/runtime/versions/`) reports `managed`: its app replaces the Gateway, and `--update` only refreshes this install's registrations.

The Claude Worker runs a Claude CLI you have installed, found in this order: `CLAUDE_CODE_EXECUTABLE` if it is not blank; otherwise the first executable `claude` in an absolute directory on the daemon's PATH, skipping copies inside the Gateway's own dependencies and any binary bundled with the Claude Agent SDK; otherwise `~/.local/bin/claude`. If none exists, Claude is reported as not installed. From 1.7.2, neither an npm install (with npm 10, 11 or 12) nor the GitHub runtime release includes the Claude Code binary that the Claude Agent SDK bundles; 1.7.1 already left it out of the runtime release and of npm installs made with npm 10 or 11.

To protect a user-modified `agent-delegator`, the skill is installed only on the first `--install-all` and is not touched by `--update`. `--install-skill` is also meant for first installation, so it does not automatically overwrite a copy that the installer already manages. To protect local source changes, the update aborts if the Git working tree is not clean, so commit or stash your changes first. The `npm link` that connects directly to the source does not need to be repeated after the first installation.

To apply only the latest default skill included in the current checkout, review the plan first and then update.

```bash
acp-gateway-bootstrap --update-skill --dry-run
acp-gateway-bootstrap --update-skill
```

`--update-skill` targets every `agent-delegator` copy recorded in the installer state, and it does not pull the Gateway source, change adapters or MCP, or restart the daemon. It replaces a copy only when the SHA-256 tree digest recorded at installation matches the currently installed copy, so a user-modified skill is preserved with a `customized` warning. A copy installed with v1.3.0 or earlier that has no digest is also preserved as `legacy-unverified`, even if its content is identical to the current default. Use `--update-skill --force` only when you want to overwrite with the default after reviewing the contents. To fetch the latest Gateway source first, run it as a separate command after `acp-gateway-bootstrap --update` succeeds.

### Host reconnection procedure

After upgrading the Gateway to a new version, you **must reconnect the host (Claude/Codex/Grok/Auggie) session** before the new tools and arguments become visible. An MCP host caches the tool list that the server first responded with for the duration of the session, and a daemon restart only replaces the socket (the RPC reconnects transparently), so the stale schema remains without any error. Bumping the server version does not break the cache.

Run the steps in order.

```bash
acp-gateway-bootstrap --update          # 1. Update the Gateway source, adapters and daemon
acp-gateway-bootstrap --update-skill    # 2. Update the skill (use --force if it was modified)
```

3. **Reconnect the host** — for Claude Code, use `/mcp reconnect` or start a new session; for Codex, Grok and Auggie, start a new session.
4. **Verify** — everything is fine if `agent_acp_run` is in the tool list and the `agent_acp_setup` response has no `staleFrontDoor`.

`staleFrontDoor` is a notice attached to `agent_acp_setup` and `agent_acp_session_open` responses when the version of the front door (the MCP process registered with the host) differs from the version of the running daemon, and it contains `frontDoorVersion`, `gatewayVersion`, the required `action` and, when the two versions can be ordered, a `reason`. With `reason: "front_door_older"` (or no `reason`), perform step 3. With `reason: "gateway_older"` the daemon is the older side, and reconnecting would only reattach to it: restart the daemon when idle with `acp-gateway-admin shutdown_if_idle` (it refuses while work is in flight, so retry later), and the next `agent-acp` call starts the front door's version. `acp-gateway-bootstrap --update` also repoints a managed `agent-acp` entry whose script is gone or that is a fixed path to an older Gateway, but only when the entry is provably the one this installer registered. From 1.7.2 the install state records the launch (command and args) of each registration and the names of its environment variables, and the entry must still launch exactly that, with exactly those variables and the current Control token and Main ID. An entry whose env changed since (a variable added, such as `HTTP_PROXY` or `NODE_OPTIONS`, one removed, or another token or Main ID) is kept with a warning, because replacing it would drop the change. An entry registered before 1.7.2 has no such record, and nothing tells it apart from an older Gateway install the user pointed it at, so it is never repointed automatically: unless it already launches this install, it is kept with a warning, and rerunning with `--force` once re-registers it and records its launch, after which `--update` moves it on its own. An entry that fails these checks is kept with a warning, and `--force` re-registers it. An entry that goes through a symlink another app manages is kept, with a warning if it resolves to an older Gateway, the link is broken, or the script behind it is missing. The agent CLIs have no atomic replace, so before removing an entry the installer reads its command, args and env; if the new entry then cannot be added, the previous one is put back exactly as it was (after `--rotate-token`, an entry this installer wrote gets the new Control token and Main ID instead of the retired ones). An update does not remove an entry it could not put back exactly (for example, when the CLI does not report its env); it keeps it with a warning, and `--force` replaces it anyway.

### Main installer options

| Option | Description |
|---|---|
| `--version`, `-V` | Show the currently installed ACP Gateway version |
| `--update` | After source pull, upstream check and full tests (source checkouts only; npm and app-managed installs skip Git) and a dry-run, update the Adapter, MCP and daemon — user skills are kept |
| `--install-all` | Install all Adapters, the Guide and the skill, then register Control with one front door |
| `--front-door codex\|claude\|grok` | Explicitly specify the Control MCP target of `--install-all` |
| `--install-control` | Install only the Control MCP for the orchestrator |
| `--install-guide` | Install only the read-only Guide MCP |
| `--install-skill` | Install the `agent-delegator` skill for the first time on discovered AIs — existing managed copies are preserved |
| `--update-skill` | Separately update only the unchanged installer-managed skills with the default from the current checkout |
| `--discover-agents` | Compare installed AIs against the official ACP registry |
| `--registry-agent ID` | Selectively install one registry agent, regardless of whether it was discovered |
| `--refresh-registry` | Ignore the 24-hour cache and refresh the official registry |
| `--offline` | Use only the stored registry cache |
| `--target codex\|claude\|grok\|auggie\|all` | Select the installation target of the Control MCP for the orchestrator |
| `--dry-run` | Print the plan without making actual changes |
| `--rotate-token` | Replace the Control token and the orchestrator identifier (Main ID) |
| `--force` | Explicitly replace unmanaged items or managed skills that the user modified |
| `--agent-auto-update on\|off` | Set ACP agent/adapter automatic updates, then restart the daemon |
| `--agent-update-notifications on\|off` | Set health check update notifications, then restart the daemon |

The Control token and the orchestrator identifier (Main ID) are stored in `~/.acp-gateway/install.json` with permission `0600` and are reused across repeated installations.

Skills are installed to Codex `~/.codex/skills`, Claude `~/.claude/skills`, Grok `~/.grok/skills`, and Auggie `~/.augment/skills`. Registry providers with no known dedicated path use the shared `~/.agents/skills`. If several providers use the same shared path, the skill files are copied only once, and the installer state records every one of those providers.

Control and Guide MCP registration supports Codex, Claude, Grok, and Auggie. In the default `--install-all`, Control is registered only with the one of Codex, Claude and Grok that the user selected as the front door, while the Guide and the skill are installed on all discovered supported agents. `--target` is kept for advanced manual targeting. The Control MCP has full control permission over the Gateway, so install it only on local agents you trust. Its token is stored in that agent's MCP configuration, where a Worker whose own tools read files without going through the Gateway (measured with Codex, even under `read_only`) can read it and act as a Main; see [Permission policies](../README.md#permission-policies) before giving such a Worker untrusted content.

The official registry source is `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, cached for 24 hours in `~/.acp-gateway/registry.json`. The execution definitions of discovered providers are stored in `~/.acp-gateway/providers.json`. `npx` and `uvx` distributions install the version pinned in the registry, while binary distributions use an already installed executable. An arbitrary AI that is not listed in the registry is not registered automatically, because its ACP execution contract cannot be inferred safely.

### Monitoring ACP upstream versions

The maintainer checks the official ACP protocol repository and the registry manually with the commands below. When a protocol release or public wire version changes, or a registry agent is added or removed or its version or distribution information changes, update the snapshot, review it, and commit it to `dev`. Regular version updates for npm and GitHub Actions are managed by Dependabot as separate PRs targeting `dev`. Security updates target the default branch, `main`, under GitHub policy.

```bash
npm run monitor:check   # If there are changes, print a report and return exit code 2
npm run monitor:update  # Update the review snapshot to the current upstream state
npm run monitor:sync-dependencies  # Sync the ACP adapter versions that the repository includes directly
npm run update:upstream  # Manual maintenance path that runs the update above and the full CI at once
```

When the maintainer runs `npm run update:upstream`, the snapshot update, the synchronization of the pin and lockfile of the managed ACP adapters, and the full CI can all be done locally in one go. This command does not commit or push automatically. Review the protocol and registry changes and the test results with `git diff`, then commit to `dev`. For regular users, `acp-gateway-bootstrap --update` does not modify repository files arbitrarily; it reports upstream changes and safely updates only the runtime adapters.

The two update paths have different roles.

- **ACP agent/adapter versions:** The daemon periodically checks the versions pinned in the official registry and updates automatically. Running `acp-gateway-bootstrap --update` also immediately re-reads the registry and performs the same update.
- **ACP protocol wire version:** A new major version is detected and flagged as a warning in the `monitor:check` report, but it is not applied automatically. After compatibility testing, you must change `src/acp-version.js` and the monitor configuration together.
- **Gateway npm dependencies:** Review the lockfile and the CI results in the Dependabot PR before merging.

The current runtime uses ACP wire version 1. `schema/v2` in the official repository is also detected, but it is not marked as v2 support and there is no automatic switch. A snapshot update is a notification and a starting point for review; it does not perform an automatic merge or a Gateway release.

Since v1.1.0, the daemon checks the official ACP registry at startup and every 24 hours afterward. If a discovered `npx` or `uvx` adapter has a newer version, it is installed automatically and the provider definition is updated. Worker processes that are already running are not interrupted, and the updated adapter applies from new processes or sessions. Binary distributions that must be installed manually are not replaced automatically and are left as a health warning.

The `agentUpdates` field of the `agent_acp_setup` health response contains the check time, the applied versions, the remaining manual updates, and errors. When notifications are on, `alerts` in the same response contains messages to show to the user. In other words, the Gateway does not push anything to the screen on its own; the orchestrator relays the notifications to the user when it receives the health check result. To check again immediately, call setup with `refreshAgentUpdates: true`.

The Gateway itself is never pulled or installed automatically. On the same cycle, a source checkout checks only the `package.json` version published on the remote `main` of its Git repository, and an npm install checks only the `latest` version of `acp-gateway-daemon` on the npm registry. If a higher version exists, `gatewayUpdate` in health (which carries `installMode`) and the `gateway_source_update_available` alert direct you to run `acp-gateway-bootstrap --update` for a source checkout, or `npm install -g acp-gateway-daemon@latest` followed by `acp-gateway-bootstrap --update` for an npm install. An app-managed runtime checks nothing and reports `status: "managed"`; its app updates it. As a result, the installed Gateway, the installation state, and custom skills do not change until the user explicitly updates.

Automatic updates and notifications are on by default. After installation, you can turn each off or back on as follows, and custom skills are not changed.

```bash
acp-gateway-bootstrap --agent-auto-update off
acp-gateway-bootstrap --agent-update-notifications off

acp-gateway-bootstrap --agent-auto-update on
acp-gateway-bootstrap --agent-update-notifications on
```

The Dependabot configuration must exist on GitHub's default branch to be activated, and the remote `dev` branch must be kept for PRs targeting `dev`.

### Publishing to npm (maintainers)

The Gateway is published to npm as `acp-gateway-daemon` (the command names stay `acp-gateway-*`). Publish only a commit whose release version is already in `package.json`, `package-lock.json`, `GATEWAY_VERSION` in `src/version.js` and the newest heading of both changelogs; `npm run ci` checks that they agree. npm versions are immutable: a published version number can never be reused, even after an unpublish, so a mistake is fixed only by a new version.

- **GitHub Actions (the usual path):** Push the release tag, then run the `Publish npm` workflow (`.github/workflows/publish-npm.yml`, manual `workflow_dispatch`) on that tag with the input `version`, for example `gh workflow run publish-npm.yml --ref v1.7.2 -f version=1.7.2`. The run fails unless it was dispatched on `refs/tags/v<version>`, the input equals the `package.json` version and `GATEWAY_VERSION`, the package name is `acp-gateway-daemon`, and the checked-out commit is the tag's commit (a tag moved after the dispatch is refused). It refuses a version that is already on npm. In a job that cannot publish, it installs with `npm ci --omit=optional`, runs `npm run ci` and `npm run smoke:npm` (npm 10, 11 and 12), and packs through `scripts/pack-release.js`, failing unless the packed tarball's sha256 equals that of the tarball the smoke test installed; a second job, the only one allowed to request a GitHub OIDC token, runs no repository code and publishes exactly that tarball with npm 11 (`npm publish --provenance --access public`).
  - Publishing uses npm trusted publishing (OIDC): no npm token is stored in the repository or used by the workflow. On npmjs.com, `acp-gateway-daemon` → Settings → Trusted Publisher must list GitHub Actions with organization `creverse-ai-lab`, repository `agent_gateway`, workflow filename `publish-npm.yml`, no environment, and allowed actions that include `npm publish`. A configuration created after 2026-09-03 allows only `npm stage publish` unless `npm publish` is also ticked, and this workflow runs `npm publish`. The fields are case-sensitive and npm does not check them when you save; a mismatch shows up only as a failure in the publish job (for example `ENEEDAUTH` or `E404`). Renaming the workflow file stops publishing until that setting is updated.
  - With trusted publishing working, set Settings → Publishing access to "Require two-factor authentication and disallow tokens"; trusted publishing keeps working and a leaked token can no longer publish.
  - npm attaches provenance only for a public GitHub repository, and trusted publishing needs a GitHub-hosted runner, so the workflow cannot publish while the repository is private.
- **Local publish:** From a clean checkout of the release tag, install with `npm ci --omit=optional`, run the checks, log in and publish. The package bundles `node_modules` as installed, and `npm publish` runs the `prepack` guard (`scripts/pack-release.js`), which refuses a tree that is not exactly the locked production tree; do not pass `--ignore-scripts`. This path publishes without provenance.

```bash
git clone --branch v1.7.2 https://github.com/creverse-ai-lab/agent_gateway.git
cd agent_gateway
npm ci --omit=optional
npm run ci
npm run smoke:npm
npm login
npm publish --access public
```

Publishing to npm does not replace the GitHub runtime release (`acp-gateway-runtime-darwin-arm64.tar.gz`) that the desktop app installs. That release is still built separately by the `Release runtime` workflow and keeps the package name `acp-gateway`; publishing one does not produce the other.

## Worker parameter control

`agent_acp_config` queries and changes the session parameters that a Worker exposes directly through ACP `configOptions`. Check the possible values and the current value with `action: list`, then, while the session is not working, pass `action: set`, `configId`, and `value`. On ACP wire v1, selectable string settings and boolean settings are supported, and categories such as `model`, `mode`, `model_config`, and `thought_level` are preserved as they are.

The Gateway does not invent and pass values such as `temperature` or `max_tokens` that the Worker does not expose. The supported range therefore depends on the options that each ACP adapter, such as Claude, Codex or Grok, actually advertises. A settings change is recorded as a `config_changed` session event, so a future DAG orchestrator can choose parameters according to each node's task type, cost, and quality policy and track them together with the results. For a Worker that pins the model per process, do not change the model in an existing session; open a new session instead.

## Result retrieval and artifacts

Since v1.3.0, the poll default is lean. While a turn is in progress, `result` is omitted automatically (it is included only when you explicitly set `includeResult: true`), and after completion, `result.text` in a poll holds only the **final answer segment** (the message text after the last work boundary), not the accumulated transcript. Retrieve progress narration with `includeInspection: true`. `includeTranscript: true` on `get` of `agent_acp_session` returns the bounded transcript that remains in memory, and the full transcript that overflowed is retrieved by following `resultArtifact`. You can also query the retained event history by range with `cursor`/`toCursor`/`eventTypes`. For the detailed retrieval path, follow the "Retrieve the correct result" table in the `agent-delegator` skill.

All data beyond the inline limit is spilled to a file in `~/.acp-gateway/artifacts`, and the response carries a truncated preview and a pointer (path, byte count, and whether it is complete) — a tool event payload over 4KB (UTF-8) becomes `dataArtifact`, a final answer over 64KB becomes `textArtifact`, and a transcript over the memory limit (1MB) becomes `resultArtifact`. Only content within the limit is kept inline, so RAM and the orchestrator context do not grow with the size of the result. Artifacts are limited to 100MB per file and 512MB in total, and files referenced by a live session are retained through the 24-hour cleanup. Concurrent unanswered permission and question requests follow a safety limit of 64 per session, and a large description chunk is handled as is within the 32MB protocol frame limit. Transport, session, and Main budgets are also reported together in `setup().resourceLimits` — a write queue of 4MB per control connection and a 10-second no-progress limit (the queue on the worker stdin side is derived from the concurrent request limit), a 1MB prompt, a 500KB file read (in bytes; the excess is reported as truncated through `_meta["acp-gateway/read"]`), 10MB of terminal output, and 64 sessions per Main and 1000 processed inbox history entries.

## Sessions and data

- State files (schema v5): `~/.acp-gateway/state.snapshot.json` (full state) + `~/.acp-gateway/state.wal.ndjson` (control transition log)
- `~/.acp-gateway/state.json` continues to be written in the v4 format. It is still written in the current version so that you can explicitly roll back to a 1.4 Gateway.
- Idle resumable sessions are unloaded after 30 minutes by default
- Results and events are retained for 24 hours by default
- Session resume checkpoints are retained for 7 days by default, and the bytes of a Task handle are retained for 24 hours by default (`ACP_GATEWAY_TASK_RETENTION_MS`)
- Use `pin` for sessions that need to be kept for a long time
- Response bodies, thoughts, and the full event history are not persisted in the state file
- Results and terminal output beyond the inline limit are stored temporarily in `~/.acp-gateway/artifacts` and cleaned up according to the result retention period

### Status, interruptions and attention

Since v1.7.0 the Gateway reports where delegated work stands instead of leaving the orchestrator to guess. None of it cancels or re-runs anything for you.

- **Status reason and stall hint** — Session `get`/`list` carry `statusReason`, `statusChangedAt` and `lastWorkerActivityAt`, and `stallSuspected` when a running turn has sent nothing for `stallHintMs`. `setup` raises `sessions_stall_suspected`.
- **Interruptions** — A task the Gateway cut short carries `interruption: {reason, executionOutcome, at}`, where `executionOutcome` is `not_started` or `unknown`, and its result lists `next` steps. From v1.7.2, only a task created by v1.7.2 or later can be judged `not_started`; an older task interrupted from then on is `unknown`, and a `not_started` that v1.7.0 or v1.7.1 already recorded on an older task reads as `unknown`, with its `next` rebuilt. `agent_acp_session {action: "check"}` reports whether a session is `restorable`, `restorable_with_caveats`, `not_restorable` or `unknown` without starting a provider.
- **Attention** — `agent_acp_inbox {action: "attention"}` returns `needsMain` (pending requests, `stale` after `attentionStaleMs`) and `updates` (finished tasks whose result has not reached the Main that started them). `{action: "ack", taskIds}` marks the listed tasks as seen.
- **Scope** — `scope: "mine"` on `agent_acp_session {action: "list"}` and on `task_list` keeps only the calling Main's records. A front door that sends no caller identity (pre-1.6) gets `INVALID_ARGUMENT`.
- **Quarantine** — After `maxConsecutiveRestoreFailures` failed restores in a row, `prompt`, `task_prompt`, `run` and `config` fail with `SESSION_QUARANTINED` without contacting the provider. `check`, `agent_acp_session_restore` (which restores the Main's own record in place, also while its provider is off, and lifts the quarantine on success) and `agent_acp_session_open` remain available.

### Durability and recovery

Task creation and result finalization are appended to the WAL and fsynced before the response is returned. That is, a Task handle that Main has received survives a daemon crash, and after a restart an incomplete Task is finalized as `failed` (with a restart message). Since v1.7.0 it also carries `interruption` (see below). The remaining transitions (permission and question records, session registration/termination, state changes) use a 5ms group commit. Since v1.7.2, a failed session restore (the failure count, a quarantine and `lastRestore`) and a successful restore that ends a failure streak are also fsynced before the response is returned, so a crash neither undoes a quarantine nor brings back one that a success lifted. If that synced write fails, the restore's outcome stands but is reported: persistence becomes unhealthy, `setup` raises a `STATE_RESTORE_NOT_DURABLE` warning, which the next successful write does not clear, and the restore's answer carries `durability: { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" }` (in `details.durability` of the error when the restore failed). On macOS, Node does not expose `F_FULLFSYNC`, so only `fsync(2)` is used — an abnormal process exit is fully protected, and a power loss exposes only the group commit window (5ms by default).

If the state file is corrupted, the daemon **does not silently start with an empty state** and aborts instead. At that point it records the reason in `~/.acp-gateway/state.recovery-required` and exits with exit 78, and its contents are surfaced in the Control MCP connection failure message. Recovery is chosen explicitly.

| Environment variable | Default | Description |
| --- | --- | --- |
| `ACP_GATEWAY_WAL` | `on` | If `off`, the snapshot is written synchronously on every critical mutation without a WAL (the same durability promise, at a higher write cost) |
| `ACP_GATEWAY_WAL_GROUP_COMMIT_MS` | `5` | Group commit interval for non-critical transitions |
| `ACP_GATEWAY_WAL_ROTATE_BYTES` / `_RECORDS` / `_INTERVAL_MS` | `4MiB` / `10000` / `15m` | WAL rotation conditions |
| `ACP_GATEWAY_WAL_INLINE_RESULT_BYTES` | `4096` | A Task result larger than this size is split out into an artifact, and the WAL records only the reference + preview |
| `ACP_GATEWAY_FSYNC` | `normal` | `off` is for tests and temporary volumes only |
| `ACP_GATEWAY_STATE_RECOVERY` | (none) | `truncate`: replay the WAL up to just before the corruption, then start / `snapshot-drop`: discard the snapshot and recover from `state.json` / `cold`: start with an empty state |
| `ACP_GATEWAY_TASK_RETENTION_MS` | `24h` | Disk lifetime of Task records and result artifacts (independent of session retention) |
| `ACP_GATEWAY_MAX_QUEUE_BYTES` | `4000000` | Combined OS+channel write budget per control connection. HIGH may use all of it, NORMAL up to 7/8, and LOW up to 1/2 |
| `ACP_GATEWAY_WRITE_TIMEOUT_MS` | `10000` | If the OS accepts not a single byte for this long, the connection or provider is terminated |
| `ACP_GATEWAY_MAX_PROMPT_BYTES` | `1000000` | A prompt over the limit is rejected with `PROMPT_TOO_LARGE` before a turn is created |
| `ACP_GATEWAY_MAX_FILE_READ_BYTES` | `500000` | Byte limit for the worker's `fs/read_text_file` response (truncated instead of rejected) |
| `ACP_GATEWAY_MAX_TERMINAL_OUTPUT_BYTES` | `10000000` | Limit for the terminal output buffer (same as the previously hardcoded value) |
| `ACP_GATEWAY_MAX_SESSIONS_PER_ROOT` | `64` | Concurrent session limit per Main. Exceeding it returns `SESSION_LIMIT_EXCEEDED` |
| `ACP_GATEWAY_MAX_INBOX_ITEM_BYTES` | `65536` | Byte limit for retaining a single worker permission/elicitation |
| `ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_SESSION` | `524288` | Combined byte limit of pending inbox per session |
| `ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_ROOT` | `4194304` | Combined byte limit of pending inbox per Main |
| `ACP_GATEWAY_MAX_INBOX_HISTORY_PER_ROOT` | `1000` | Number of processed inbox entries retained per Main (pending entries are not subject to removal) |
| `ACP_GATEWAY_STALL_HINT_MS` | `300000` | Setting `stallHintMs` (minimum `10000`). How long a running Worker may send nothing before session reads report `stallSuspected`. A hint only |
| `ACP_GATEWAY_ATTENTION_STALE_MS` | `600000` | Setting `attentionStaleMs` (minimum `10000`). How long a Worker request may wait before the attention view and `setup` call it stale. A label only |
| `ACP_GATEWAY_MAX_CONSECUTIVE_RESTORE_FAILURES` | `3` | Setting `maxConsecutiveRestoreFailures` (minimum `1`). Consecutive failed restores before a session is quarantined (`SESSION_QUARANTINED`); the same count of provider start failures raises the `provider_degraded` alert |

When persistence becomes unhealthy, **only new Task creation** is rejected with `PERSISTENCE_UNHEALTHY` (handle = durability promise). `session_open` and direct `prompt` continue to work, and the healthy state is restored on the next successful write that started after the failure. `setup().persistence` reports `mode`, `walSeq`, `walBytes`, `snapshotEpoch`, `fsyncCount`, and `lastRecovery` together.
