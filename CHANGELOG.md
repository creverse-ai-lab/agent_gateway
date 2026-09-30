# Changelog

[한국어](CHANGELOG.ko.md) | **English**

## v1.7.2

This patch release makes the recovery facts that 1.7.0 introduced hold across upgrades and crashes, stops the installer from repointing MCP entries it cannot prove it wrote, makes npm 12 install the tested dependency tree without the Claude Code binary, publishes to npm with trusted publishing, and corrects what the READMEs said about Workers and Gateway control. API major **1** and state schema **5** are unchanged, and there are no new settings or error codes. The only public additions are a `durability` field, which a restore's answer carries only when its outcome could not be written durably, and the `STATE_RESTORE_NOT_DURABLE` setup alert.

- **Interruption outcome (a 1.7.0 bug):**
  - 1.7.0 and 1.7.1 reported `executionOutcome: "not_started"` for any interrupted task without a dispatch stamp. v1.6.0 never wrote that stamp, so a v1.6.0 task cut short by the upgrade restart was reported `not_started`, suggesting a safe re-run of a prompt the Worker may already have acted on.
  - Tasks now carry an internal dispatch-tracking marker, never returned by the API. An interruption is judged `not_started` only for a task that has the marker and no stamp. Any other task, including every task created before 1.7.2, is judged `unknown`, and for a snapshot session its `next` includes `workspace_diff`.
  - Recovery also corrects the `not_started` verdicts that 1.7.0 and 1.7.1 already wrote. On a task without the marker (every 1.6.0 task and every task 1.7.0 or 1.7.1 created), a persisted `executionOutcome: "not_started"` now reads as `unknown` in `task_get`, `task_list` and the result envelope, whose `next` is rebuilt: a snapshot session gets `workspace_diff`, and `decide_rerun` warns that re-running may repeat side effects.
  - When replay can bring back only the preview of an interrupted task's result (its artifact is gone), the result again carries `interruption` and `next`. Results that 1.7.0 or 1.7.1 already saved without them are repaired when 1.7.2 loads them.
- **Restore failures and quarantine survive a crash:**
  - A failed restore writes the session's failure count, quarantine and `lastRestore` to the WAL and fsyncs before the error is returned, and so does a successful restore that ends a failure streak or lifts a quarantine. Before, these reached disk only with a later state snapshot, so a crash right after the failure that quarantined a session could undo the quarantine, or bring back one that a success had lifted.
  - If the synced write that records a restore outcome (a failed restore, or a success that ends a failure streak or lifts a quarantine) fails, the outcome stands but is no longer silent: persistence health reports it, `agent_acp_setup` shows a `STATE_RESTORE_NOT_DURABLE` warning, a successful restore's response gains `durability: { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" }`, and a failed restore's error carries the same in `details.durability`. A background state write already in progress no longer clears a failure recorded meanwhile.
  - A restore method the caller names (`resume` or `load`) that the provider does not advertise is refused before anything happens: no restore events, no status change and no failure counted. Before, it put the session through `restoring` and counted as a failed restore. An automatic restore on a provider that advertises neither `session/resume` nor `session/load` still counts as a failed restore toward quarantine, with `lastRestore` recording `method: null` and `errorCode: INVALID_ARGUMENT`.
  - An explicit `agent_acp_session_restore` is the session's only restore in flight. A transparent restore started meanwhile (by a prompt, for example) joins it, and an explicit restore that arrives during a transparent one waits for it and then decides again, so the Worker never receives two restore requests.
  - Turning a provider off (`set_enabled` with `enabled: false`) blocks only new registrations, as the Management API contract says. `agent_acp_session_restore` of this Main's own registered record works under Off, which for a quarantined session is the only way back. A session that is not registered yet still cannot be restored while its provider is off.
- **Installer and MCP entries:**
  - `--update` and `--install-all` repoint a managed `agent-acp` or `agent-acp-guide` entry only when it is provably the one this installer registered. Each registration now records its launch in the install state (command and args, plus the names of its environment variables, never their values), and the entry must still launch exactly that. An entry registered before 1.7.2 has no recorded launch, so it moves only while it has the shape the installer writes (an absolute node executable running one normalized absolute path to a Gateway's `src/index.js` for Control or `src/guide.js` for Guide) and that script exists inside an actual Gateway package (`acp-gateway` or `acp-gateway-daemon`); if its script is missing, nothing shows the entry is the installer's own, so it is kept with a warning. Any entry that fails these checks is kept with a warning, and `--force` replaces it. Before, a managed entry whose script was missing was always re-registered, even one the user or another app had replaced with the same shape.
  - An entry whose path goes through a symlink is kept with a warning when the link is broken or leads somewhere without the script, for the app that manages the link to fix. A path that cannot be checked (for example `EACCES`) is reported as unknown and kept, instead of being treated as missing.
  - The agent CLIs have no atomic replace, so the installer reads the entry's command, args and env from the agent CLI before removing it. When the add then fails, it puts the previous entry back exactly, with its own command, args and env, and says so in the error; the Control token and Main ID are added only to a launch this installer wrote (this install's own node and script, or the launch the install state records). An update does not remove an entry it could not put back exactly, for example when the CLI does not report the entry's env, or the entry sets a `cwd` or `env_vars` that the CLI's `mcp add` cannot set; it keeps the entry with a warning. With `--force` or `--rotate-token` such an entry is replaced, and a failed replace says it could not be restored exactly. Before, a restored entry that did not launch this install came back without its environment variables.
  - The MCP registrations the installer reports, dry runs included, show the Main ID as `<redacted>` as well as the Control token. Its errors hide both, along with the env values of an entry it restores, including where an agent CLI echoed them. Before, the Main ID appeared there in plain text.
- **npm 12 installs (a 1.7.0 bug):** npm 12 no longer reads `npm-shrinkwrap.json`, including one inside a published package. Under npm 12, 1.7.0 and 1.7.1 installed freshly resolved dependencies instead of the tested tree, plus this platform's Claude Code binary: about 310 MB instead of about 48 MB.
  - Fix: 1.7.2 carries its dependency tree inside the package (`bundleDependencies`). npm 10, 11 and 12 install exactly the tested versions, fetch nothing else from the registry, and install no Claude Code binary. The download is about 6.1 MB (was 0.3 MB), and the install is about 48 MB, as 1.7.1 was with npm 10 and 11. `@anthropic-ai/sdk` is now a direct dependency, at the version already in use: the Claude Agent SDK requires it as a peer, and npm does not bundle peer-only packages.
  - Maintainers: The lockfile is `package-lock.json` again, and `node scripts/omit-claude-binary.js` now removes the Claude platform binaries from it. Pack only with `npm ci --omit=optional`, then `node scripts/pack-release.js --pack-destination <dir>`. The script, which is also the `prepack` script, refuses a `node_modules` that is not exactly the locked production tree or that holds a Claude platform package. `npm run smoke:npm` installs the tarball with npm 10, 11 and 12, and fails if an install requests anything from the registry besides the package itself.
- **npm publishing with trusted publishing:**
  - The `Publish npm` workflow publishes with npm trusted publishing (OIDC). No npm token is stored in the repository or used by the workflow, and there is no token fallback; 1.7.0 used the `NPM_TOKEN` secret.
  - It must be dispatched on the release tag `refs/tags/v<version>`, and the checked-out commit must be the tag's commit and the commit the run was dispatched for, so a tag moved after the dispatch is refused (`scripts/check-npm-release.js`).
  - One job, without the right to publish, runs `npm ci --omit=optional`, `npm run ci` and `npm run smoke:npm`, and packs the tarball through `scripts/pack-release.js`, checking that its sha256 equals that of the tarball the smoke test installed. A second job, the only one that can request a GitHub OIDC token, runs no repository code, checks the tarball's checksum, name and version, and publishes exactly that tarball with npm 11 and provenance. The npm-side settings are in the [Operations guide](docs/operations.md#publishing-to-npm-maintainers).
- **Control MCP `agent_acp_run` attach:** An attach (`{taskId}`) through the Control MCP now forwards the caller's arguments to the Gateway, so an attach that also names `prompt`, `sessionId`, `parentTaskId` or `inputTaskIds` fails with `INVALID_ARGUMENT`, as it already did over the socket. Before, the front door dropped those arguments and attached as if they had not been sent.
- **Documentation correction (security):** The READMEs said that Gateway control is never passed to Workers. The Gateway strips its token, socket and Main identity from Worker environments, but a Worker whose own tools read files without going through the Gateway (measured with Codex, even under `read_only`) can read the Control token stored in the front door's MCP configuration and act as a Main. The READMEs and the Operations guide now say so and advise against giving such a Worker untrusted content. 1.7.2 does not change this behavior; stronger isolation is planned.
- **Tests:** New tests pin that failures while the Gateway is draining do not count as restore failures, that an explicit restore can name a snapshot session by the directory it was copied from, and that cancelling a task does not mark it seen.
- **Compatibility:** No API, state schema or setting changes. Default and compact poll responses, and the task reads and result envelopes of ordinary tasks and runs, are byte-identical. What changes: a task created before 1.7.2 that is interrupted from now on is judged `unknown` where 1.7.0 or 1.7.1 could have said `not_started`, and a `not_started` they already recorded on such a task now reads as `unknown`; an attach with start-only arguments now fails instead of being quietly trimmed; a restore method the caller names that the provider does not advertise no longer counts as a failure; a Main can restore its own record while the provider is off; a restore whose outcome could not be written durably says so in `durability`, a field added only then; and the installer keeps MCP entries it cannot prove it wrote. State written by 1.7.2 stays readable by 1.7.0 and 1.7.1: restore outcomes are journaled as the existing `session.registered` record, there is no new WAL record type, an older daemon ignores the new task marker, and a corrected verdict is `unknown`, a value they already use. The install state (`install.json`) gains an additive `launch` record in each managed MCP entry and keeps its format version, so 1.7.0 and 1.7.1 still read it; if an older installer re-registers an entry, the entry loses its `launch`, and 1.7.2 then treats it as one registered before 1.7.2.
- **Upgrade:** For an npm install, run `npm install -g acp-gateway-daemon@latest`, then `acp-gateway-bootstrap --update`, which also restarts the daemon. If you installed 1.7.0 or 1.7.1 with npm 12, `npm install -g acp-gateway-daemon@latest` replaces that tree, including the Claude Code binary. A source checkout updates with `acp-gateway-bootstrap --update`, and an app-managed runtime through its app. Then reconnect host sessions so the host starts the new Control MCP front door, which carries the attach fix. If `--update` now warns that it kept an MCP entry, check what that entry launches; `--force` re-registers it.

## v1.7.1

This patch release fixes the size of the npm install. Installing `acp-gateway-daemon@1.7.0` from npm downloads the Claude Code binary for every platform, more than 2 GB, and `--omit=optional` does not prevent it; 1.7.1 installs about 49 MB. The Claude Worker now also finds a Claude CLI on PATH. API major **1** and state schema **5** are unchanged, and there are no new fields, settings or error codes.

- **npm install size (a 1.7.0 bug):** The Claude Agent SDK, which the Claude adapter depends on, ships the Claude Code CLI as one optional native package per platform (`@anthropic-ai/claude-agent-sdk-<platform>`, about 245 MB each). The 1.7.0 `npm-shrinkwrap.json` listed all eight, and npm installs a published package's shrinkwrap as written, regardless of the operating system, the CPU or `--omit=optional`. So every npm install of 1.7.0 downloaded all eight, and the `npm install -g acp-gateway-daemon --omit=optional` advice in the 1.7.0 README had no effect. The Gateway never runs these binaries.
  - Fix: The shrinkwrap no longer lists them, nor names them among the SDK's optional dependencies. `npm install -g acp-gateway-daemon` installs about 49 MB, with no flag.
  - Maintainers: After anything that rewrites the shrinkwrap (such as `npm install`), `node scripts/omit-claude-binary.js` removes them again; `npm run monitor:sync-dependencies` runs it itself.
- **Smaller runtime release:** The GitHub runtime release installs its dependencies with `--omit=optional`, so the archive no longer carries the Claude Code binary: about 6.6 MB instead of about 80 MB. Its package name (`acp-gateway`), `package-lock.json` and public client are unchanged.
- **Claude CLI resolution:** The Claude Worker runs the Claude CLI found in this order: `CLAUDE_CODE_EXECUTABLE` if it is not blank; otherwise the first executable `claude` in an absolute directory on the daemon's PATH, skipping the Gateway's own dependencies and any binary bundled with the Claude Agent SDK; otherwise `~/.local/bin/claude`. Provider detection and the Worker use the same answer.
  - Before 1.7.1 the built-in Claude provider used `CLAUDE_CODE_EXECUTABLE` or else always `~/.local/bin/claude`, so it did not use a CLI installed elsewhere, such as one installed by a package manager.
  - If you have both `~/.local/bin/claude` and another `claude` earlier on PATH, the Worker now runs the PATH one. `CLAUDE_CODE_EXECUTABLE` still wins; set it to keep a specific CLI.
  - When none is found, Claude is reported as not installed, and the Worker never falls back to a binary bundled with the SDK.
- **CI guards:** `scripts/ci-check.js` (part of `npm run ci`) fails when `npm-shrinkwrap.json` lists or names a Claude platform binary. `npm run smoke:npm` asserts that the installed package contains none and that its Claude adapter still loads while pointing at a CLI outside the install. `release:verify` rejects a runtime archive that contains one.
- **Compatibility:** No API, state, setting or response shape changes. The only behavior change is which Claude CLI runs when `CLAUDE_CODE_EXECUTABLE` is not set (above).
- **Upgrade:** For an npm install, run `npm install -g acp-gateway-daemon@latest`, then `acp-gateway-bootstrap --update`, which also restarts the daemon. `acp-gateway-daemon@1.7.0` is deprecated on npm; do not install it. A source checkout updates with `acp-gateway-bootstrap --update`, and an app-managed runtime through its app.

## v1.7.0

This release lets Main tell from Gateway responses alone whose work a session or task is, why it is in its current state, and what a restart or crash left unknown. In v1.6.0 every thread of one Codex process still looked like a single Main, a Worker inherited the identity of the Main that had started the daemon, and after an interruption Main could not tell whether the Worker had already acted on the prompt. API major **1** and state schema **5** are unchanged, and all new fields, actions, settings and error codes are additive. It is also the first release published to npm, as `acp-gateway-daemon`.

- **Per-thread attribution:** A call is attributed to the thread that made it, not just to the front-door process.
  - Codex: The Control MCP server reads the thread id (and turn id) from each tool call's `_meta` (`threadId`, `x-codex-turn-metadata`), so sessions and turns started from different threads of one Codex process are told apart. The process-level `caller` is never modified.
  - Worker environment: `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_THREAD_ID` and `GROK_SESSION_ID` are removed from the environment of Workers, Worker terminals and the autostarted daemon. Previously any Worker could report itself as the Main that had started the daemon.
  - Agent name: The provider is taken from whole tokens of the parent process name. A name that matches more than one provider is recorded as `null`.
  - `viaSession`: When the caller is one of this Main's own Workers acting as a Main, `openedBy` and `promptedBy` carry `viaSession`, that Worker's Gateway session id.
  - Acknowledgements of `prompt`, `run` and `task_prompt` echo `promptedBy`. A session with no recorded opener reports `attribution: "none"` on session reads (never in poll).
  - `setup` reports `legacyControlRequests`, the number of session opens, restores, prompts and runs that arrived without a caller since the daemon started, and raises a `front_door_without_caller` alert when it is not zero.
- **Which side is stale (`staleFrontDoor`):**
  - `reason` says which side is older: `front_door_older` or `gateway_older`. For an older front door the `action` is still to reconnect. For an older daemon, reconnecting would only reattach to the same daemon, so the `action` says to restart it when idle (`acp-gateway-admin shutdown_if_idle`, or a guarded last-resort `kill` for a daemon older than 1.5.0); the next `agent-acp` call then starts the front door's version. When the two versions cannot be ordered there is no `reason`, and the action is to reconnect.
  - Installer: A managed `agent-acp` entry is repointed to the current install when its script is gone or when it is a fixed path to an older Gateway. An entry that points through a symlink (a pointer another app moves forward) is kept, with a warning when it resolves to an older Gateway. An entry is never moved to an older version.
  - `--dry-run` reports each MCP entry as `would-update`, `would-install`, `would-replace` or `unknown`, using read-only inspection only. Claude's entry is read from its config file, so a dry run never launches the front door.
- **Why a session is in its status:**
  - Every status change records `statusReason` (from a fixed list) and `statusChangedAt`, and both survive restarts. An idle unload (`session_unloaded`) and a crash (`provider_disconnected`) stay distinguishable across a restart.
  - `lastWorkerActivityAt` moves only on updates the Worker itself sends, not on polls, config changes, or usage and session info.
  - `stallSuspected` is computed at read time when a running turn has sent nothing for `stallHintMs` (new setting, default 300000 ms). It is a hint only: it never changes the status or cancels anything. `setup` raises `sessions_stall_suspected` for the calling Main's own sessions.
  - An idle unload emits a non-durable `session_unloaded` event without moving `updatedAt`, so retention clocks are unaffected.
  - The new fields appear on session `get`/`list` and in the `diagnostic` poll profile, which also adds `silentForMs`.
- **What an interruption left unknown:**
  - A task the Gateway cut short carries `interruption: {reason, executionOutcome, at}`. `reason` is `gateway_restarted`, `provider_disconnected` or `orphan_cancelled`. `executionOutcome` is `not_started` when the prompt provably never reached the Worker and `unknown` otherwise, decided by a durable stamp written just before the prompt is sent. The existing status and error wording are unchanged.
  - The terminal envelope of such a task adds `next`: `session_check`, `workspace_diff` (snapshot sessions whose outcome is unknown) and `decide_rerun`. Nothing is re-run automatically.
  - `agent_acp_session {action: "check"}` is read-only and never starts a provider. It reports `restorable`, `restorable_with_caveats`, `not_restorable` or `unknown`, with the method (`live`, `resume`, `load`) and caveat codes.
  - Sessions record `lastRestore: {at, method, outcome, errorCode}` and a `generation` counter, and restore events carry the method and outcome. A failed resume still never opens a fresh session.
  - A turn that fails because its Worker is gone ends as `disconnected` / `provider_disconnected` regardless of the order in which callbacks arrive.
- **Attention inbox:**
  - Tasks record the `caller` that created them; task reads show it only when present.
  - A terminal result is marked seen when it reaches the Main that created the task: through `run`, `task_result` / `tasks/result`, or a poll that returns that turn's result. Observers, `task_get`, `task_list` and inbox `list` never mark anything, so one Main can no longer clear another Main's updates on the shared root. Seen marks survive restarts.
  - `agent_acp_inbox {action: "attention"}` (read-only) returns `needsMain` (pending requests with `ageMs` and `stale`) and `updates` (unseen finished tasks, interruptions included, without result bodies), oldest first, paged with one opaque cursor and with counts for the full set. A request is `stale` after `attentionStaleMs` (new setting, default 600000 ms).
  - `ack {taskIds}` marks the requester's own (or unattributed) tasks seen and lists the skipped ids with a reason.
  - `setup` raises `attention_stale_requests` and `attention_unseen_updates`. The `agent-delegator` skill tells Main to check attention after a reconnect or restart.
  - Inbox `list`/`get` responses are unchanged. Task reads and acknowledgements add `caller`, `parentTaskId`, `inputTaskIds` or `promptedBy` only when present; a delivered `run` result is unchanged.
- **Declared task links and `scope: "mine"`:**
  - `agent_acp_run`, `task_prompt` and `task_run` accept `parentTaskId` (the task this one follows up) and `inputTaskIds` (1 to 16 tasks whose results went into the prompt). Every id must be a task visible on the caller's root; otherwise the call fails with `INVALID_ARGUMENT` and `details.unknownTaskIds`, and nothing starts. The Gateway records links as declared and never infers them. They appear on task reads only when declared, and survive restarts.
  - Links are part of the `idempotencyKey` match (order-insensitive); runs without links hash exactly as before. A plain `prompt` and a `run` attach refuse links.
  - `task_list` filters by `parentTaskId`, `callerSessionId`, `callerInstanceId` and `scope: "mine"`, and session `list` takes `scope: "mine"`. A requester with no caller identity (a pre-1.6 front door or an observer) gets `INVALID_ARGUMENT` rather than an empty list. Without these arguments the lists are unchanged.
- **Quarantine after repeated restore failures:**
  - `restoreFailures` counts a session's failed transparent and explicit restores and resets on success. Unload, close, restart marking, cancel and a draining Gateway never count.
  - At `maxConsecutiveRestoreFailures` (new setting, default 3) the session is quarantined: `prompt`, `task_prompt`, `run` and `config` fail fast with the new error code `SESSION_QUARANTINED`, without starting or contacting a provider. `details.next` lists Main's options: `session_check`, a ready-to-call `session_restore`, and `session_open`. Cancel, close, get/list, poll, pin, `workspace_diff` and `check` keep working.
  - `agent_acp_session_restore` now restores this Main's own non-live record in place (it used to refuse every registered session), and a success lifts the quarantine. A live record is still refused, now before any provider call.
  - `check` reports the caveat `session_quarantined`. `setup` raises `provider_degraded` after as many consecutive provider start failures; it is an alert only and blocks nothing.
  - `restoreFailures` and `quarantined` appear only when set, and never in the default or compact poll.
- **npm distribution:**
  - Package name: The Gateway is published to npm as `acp-gateway-daemon`, because the name `acp-gateway` is already taken there. The command names (`acp-gateway-bootstrap`, `acp-gateway-admin`, …) are unchanged, and the public client is imported as `acp-gateway-daemon/client`. The package ships the four READMEs, both changelogs, `docs/` and `LICENSE`.
  - Lockfile: `npm-shrinkwrap.json` replaces `package-lock.json`. The shrinkwrap ships inside the package, so `npm install -g acp-gateway-daemon` installs exactly the dependency tree CI tested. A source checkout still installs with `npm ci`.
  - Install mode: The Gateway tells from where its package sits how it was installed: `source` (a Git checkout), `npm` (inside `node_modules`, without `.git`), `runtime` (an app-managed release under `~/.acp-gateway/runtime/versions/`, or a tree carrying the `runtime-manifest.json` that only the runtime build writes; this wins even inside `node_modules`) or `unknown`. The health field `gatewayUpdate` carries `installMode`.
  - Updates by mode: A source checkout is still pulled, verified and re-run by `acp-gateway-bootstrap --update`. An npm install checks the npm registry's `latest` instead of Git; when it is newer, the `gateway_source_update_available` alert and `--update` name `npm install -g acp-gateway-daemon@latest`, followed by `acp-gateway-bootstrap --update`. An app-managed runtime reports `managed` and is updated by its app. For npm and runtime installs, `--update` never runs Git or npm; it refreshes the registry, the adapters and the MCP registrations and restarts the daemon.
  - Runtime release: Its identity is unchanged. The GitHub runtime release still carries the package name `acp-gateway` and a `package-lock.json` (built from the shrinkwrap), and `release:verify` asserts both. An app that mounts it keeps importing `acp-gateway/client`.
  - CI: `npm run smoke:npm`, run on both CI operating systems, packs the package, installs the tarball from a loopback registry that honours the shrinkwrap (temporary HOME, cache and npmrc, `--ignore-scripts`), and drives the installed commands and daemon in an isolated environment.
  - Publishing: The manual `Publish npm` workflow checks the requested version against `package.json` and `GATEWAY_VERSION`, refuses a version that is already on npm, runs `npm run ci` and `npm run smoke:npm`, and publishes with provenance (secret `NPM_TOKEN`). See the [Operations guide](docs/operations.md#publishing-to-npm-maintainers).
- **Compatibility:** Everything is additive. Default and compact poll responses and the result envelopes of ordinary tasks and runs are byte-identical; `interruption` and `next` appear only on tasks the Gateway cut short. Session `list`/`get` keep their shape apart from the new read-model fields above, `setup` gains `legacyControlRequests`, and acknowledgements echo `promptedBy` only when the front door identifies itself. Consumers such as monitors that read session lists can ignore the new fields.
- **Upgrade:** Restart the daemon when it is idle so the new version runs (`acp-gateway-admin shutdown_if_idle`; the next `agent-acp` call starts 1.7.0). `acp-gateway-bootstrap --update` restarts it for you, and re-running it repoints front doors that are pinned to an older install. From 1.7.0 on, an npm install upgrades with `npm install -g acp-gateway-daemon@latest --omit=optional` followed by the same `acp-gateway-bootstrap --update`. Then reconnect host sessions so the new arguments become visible, and run `acp-gateway-bootstrap --update-skill` to pick up the updated `agent-delegator` guidance.

## v1.6.0

This release makes the Gateway record directly which Main opened a session and started a turn. Until now, every Main on a PC used the same `rootId`, so Main could not be distinguished from Gateway responses alone. As a result, consumers such as monitors read each Main's transcript to guess the connection. API major **1** and state schema **5** are unchanged, and all new fields are additive.

- **Caller identification (`caller`):** The Control MCP server reports the agent CLI that launched it as the caller. It sends `caller: {provider, sessionId, pid, instanceId}` with every request.
  - `provider`: Determined from the parent process name (`claude` / `codex` / `grok`).
  - `sessionId`: The session id emitted by the CLI (`CLAUDE_CODE_SESSION_ID`, `GROK_SESSION_ID`, `CODEX_THREAD_ID`). It is `null` for Codex because Codex does not pass the thread id to MCP servers.
  - `pid`: The pid of the parent CLI.
  - `instanceId`: A value newly generated for each Control MCP server process. Even when there is no session id, as with Codex, requests from the same thread are grouped together.
- **`openedBy`:** The Main that opened (or first recovered) the session. Once set, it never changes. It is retained in `session_open` and `session_restore` responses, in `session list`, and in state after a restart.
- **`promptedBy`:** The Main that started the turn. It is included in the `turn_start` event and in the session's latest value. It is the side that will receive the response for that turn. It is recorded for `prompt`, `run` and `task_prompt` alike.
- **Compatibility:** Control servers before 1.6.0 do not send `caller`, so all three fields are absent. The existing response shape is unchanged. A `caller` sent by an observer connection is not recorded. A malformed `caller` does not block the call; it is simply not recorded.
- **Privacy:** The only values recorded are the provider, session id, pid and a random instance id. The command line and environment variables are not stored.

## v1.5.2

This hardening release consolidates, in one pass, the defects found since v1.5.1 through Codex and Grok advisory reviews and the live matrix. API major **1** and state schema **5** are unchanged, and all new fields and error codes are additive.

**Security and permissions**
- **Path-based auto-approval:** Auto-approval compares the paths in `toolCall.locations` and `rawInput` against the session root (including symlink resolution). Requests outside the root are rejected under `read_only` and are passed to Main under `auto_approve`.
- **Gateway-protected paths:** `~/.acp-gateway`, the state and settings directories, and the control socket are rejected regardless of policy. A Worker cannot read the Control token in `install.json`. Even in `ask` sessions, the request is rejected immediately without asking the human.
  - Shell command strings are also inspected. `~`, `$HOME`, quoted forms, and paths that go through symlinks such as `link/..` are covered, and `terminal/create` arguments are included.
- **Grok sandbox:** Grok applies an OS sandbox (Seatbelt/Landlock) to the entire process using a profile created by the Gateway (`.grok/sandbox.toml`, `ACP_GATEWAY_GROK_SANDBOX_DIR`), denying protected paths. Even tools that do not go through ACP, such as the built-in `grep`, cannot read the token file.
- **Claude session rules:** `_meta.claudeCode.options.disallowedTools` is passed to Claude sessions. `read_only` blocks Bash, Edit and Write, and all policies block reads of protected paths. Shell commands and reads outside the root that Claude ran without a permission request up to v1.5.1 are now blocked.
- **Reject option selection:** Automatic rejection prefers an option meaning "continue" (Codex's `decline`) over an option meaning "abort the turn" (`cancel`). Previously, when a single shell command was rejected, the entire Codex turn ended.

**Work safety**
- **`workspace: "snapshot"`:** When specified in `session_open`, the Worker works on a copy of the cwd and the original is left untouched. Changes are retrieved as a patch with `agent_acp_session {action: "workspace_diff"}`, and Main applies them itself. Use it to delegate work in which edits must never happen to a provider such as Codex, for which edits inside the root cannot be blocked.
  - **Comparison basis:** The diff is against the baseline taken at snapshot time, so user edits made to the original afterward are not mixed in as a reverse patch.
  - **symlink:** Links pointing inside the tree are re-linked inside the copy, and links pointing outside are not copied (`droppedLinks`).
  - **Exclusions:** Protected directories are not copied.
  - **diff size:** Limited to 64MB.
  - **Location and lifetime:** The copy is deleted on close and is created under `ACP_GATEWAY_WORKSPACES` (default `~/.cache/acp-gateway/workspaces`). On filesystems that support APFS or reflink, it is copied as a clone.
- **idempotencyKey conflict:** Sending a different prompt or model with the same key returns `IDEMPOTENCY_CONFLICT` (with the existing `taskId` in details). Previously, the earlier result was silently returned. A retry that changes only the wait or result budget options is still attached as before. The digest is stored in the WAL and persists across restarts.

**Reliability and operations**
- **ACP error codes:** A Worker's JSON-RPC error is passed through as `ACP_ERROR`, and it is `UNKNOWN_SESSION` when the restore target does not exist. The original error is carried in `details.acpCode` and `acpMessage`.
- **Adapter generation management:** When the adapter definition (version pin) changes, the existing process only finishes the sessions it holds, and new sessions are opened in a new process. Old processes with nothing left to do are cleaned up by the GC. `started` in `setup` now shows whether the process is actually alive (it was always false before), and `runningVersion` and `retiredProcesses` were added to provider details.
- **Provider files in isolated state:** When `ACP_GATEWAY_STATE` is set outside the default location, `providers.json` and the registry cache also use that directory. When the files are absent, the global definitions are read, and the global contents are copied on the first write. Auto-update of an isolated daemon no longer modifies the global files.
- **Atomic `--update`:** A new upstream commit is first verified in a temporary `git worktree` with `npm ci` and `npm run ci`, and only then is the live checkout fast-forwarded.
  - **Serialization:** Concurrent updates are blocked by a lock.
  - **HEAD recheck:** HEAD and the clean state are checked again immediately before the merge.
  - **Rollback:** If the subsequent dependency installation fails, it reverts to the previous commit. The revert is performed only when HEAD is the result of this update and the tree is clean, and a rollback failure is reported as a failure.
- **Shutdown calls do not start a daemon:** `daemon_shutdown` and `shutdown_if_idle` do not start a new daemon when none exists, and return `{ok:true, alreadyStopped:true}`.

**Tests**
- **Mock regression tests:** Added 23 per-feature regression tests to `test/hardening.test.js`, and rewrote `test/source-update.test.js` with 11 tests for staging, lock, CAS and rollback (397 in total).
- **Live scenarios:** `npm run usecases:live` runs 22 scenarios (setup, sessions, run, 8 permission scenarios, snapshot, errors, `kill -9` recovery) with an isolated daemon and real Claude, Codex and Grok, and produces a per-provider pass / known-limit / fail table. Because it uses subscription quota, it is run as a manual gate before release. Results are accumulated in [Live use cases](docs/live-usecases.md).

**Known limitations:** The `scope` of a session's `permission_policy_partial` warning lists exactly the items that cannot be blocked. The live matrix accepts only leaks within this scope as known-limit.
- **Codex** (`edit_inside_roots`, `shell_write_inside_roots`, `read_outside_roots`, `read_protected`): codex-acp handles files with its own tools and has no true read-only sandbox. To block edits, use `workspace: "snapshot"`, and do not hand untrusted input to Codex on a machine that holds a Control token.
- **Grok** (`read_outside_roots`): The built-in `grep` can read regular files outside the root. Protected paths are denied by the sandbox.
- **Claude:** No warnings. It passes every permission scenario in the live matrix.
- **`auto_approve`:** A policy that trusts within the root. Shell commands whose paths cannot be verified are auto-approved, and only commands that point to protected paths are rejected.

## v1.5.1

This patch release fixes defects found by running orchestration use cases against real Claude, Codex and Grok Workers. The use cases and reproduction steps are recorded in [Live use cases](docs/live-usecases.md). API major **1** and state schema **5** are unchanged.

- **Fix for Claude and Codex session recovery failure after restart:** Fixed an issue where, after a daemon restart, provider exit, or idle unload (default 30 minutes), reusing a Claude or Codex session produced `required model=…, actual=<missing>` and turned the session `unavailable`. The cause was that registry providers that select the model per session were also checked for the model at process start time. Because this check was skipped when the provider process was already running, success or failure depended on execution order. Now the model of a per-session provider is verified only through `configOptions` after the session is opened. Specifying `model` explicitly in a cold `session_open` is no longer rejected.
- **Mitigating and documenting the Codex permission policy:** The Codex adapter edits files with its own tools, and its default `agent` preset handles approvals with its own `auto_review`. As a result, edits happened without a permission request even in `read_only` and `ask` sessions. Now the Gateway selects `read-only` from the `mode` options advertised by the Worker every time it opens and recovers a `read_only` or `ask` session. With this setting, writes outside the session root, network access and privilege escalation are either blocked or escalated to the Gateway. Because codex-acp has no true read-only sandbox preset, edits **inside** the root cannot be blocked. A `permission_policy_partial` warning is placed at the very front of `relevantAlerts` in `session_open` for such sessions. For work in which edits must never happen, point `cwd` at a disposable copy of the working tree.
- **Skill documentation correction:** A prompt-level `model` and a model change through `agent_acp_config` apply to all subsequent turns, not just one turn. The notice "re-specifying the default model may be rejected," which had been added to avoid the bug above, was also removed. Update the installed skill with `acp-gateway-bootstrap --update-skill`.

## v1.5.0

**The Gateway owns the engine and execution policy, while apps such as AgenLynk and the CLI consume the public API.** A management contract was added so consumers do not have to write configuration files directly or implement provider execution blocking, retention and safe-shutdown policy on their own.

- **Observer role:** With `GatewayRpcClient({access: "observer"})`, the server enforces read-only methods. A monitor connection does not maintain Main's owner presence and does not recover Workers because of configuration reads. This is a role restriction on the same Control token and does not provide an independent observer credential.
- **Provider policy:** Provides `list`, `set_enabled` and `install` for `provider`. When a provider is Off, the Gateway rejects new sessions and new restore registrations (`PROVIDER_DISABLED`). Sessions already registered can continue to run and be recovered. Installation uses the existing Gateway installer and is dry-run by default.
- **Engine configuration:** `gateway_config` reads and updates the supported options, active values, stored values, revision and whether a restart is required. If `expectedRevision` is stale, it is rejected with `CONFIG_CONFLICT`. `~/.acp-gateway/settings.json` is the source of truth for engine configuration; if the file does not exist, the supported settings of the existing `install.json` are read and migrated on the first change. Environment variables take highest precedence.
- **Safe shutdown:** `shutdown_if_idle` and the default `daemon_shutdown` return `SHUTDOWN_BLOCKED` with blockers if tasks, Inbox items, session creation/recovery, management requests or background updates remain. If they pass, new mutations are blocked and the daemon shuts down. Forced shutdown is an explicit `daemon_shutdown {force:true}` or an OS signal.
- **Honest replay:** Loss of live-only messages/thoughts and history gaps after a daemon restart are reported through the subscription's `cursorTruncated` and the new `replay` metadata. Restoring a live connection does not mean recovering past messages. The result of a completed Task is retrieved separately with `task_result`.
- **Retention preview:** `retention_preview` returns the expected cleanup counts for sessions, Tasks, Inbox and results, using the same decision logic shared with the actual GC. In-progress Tasks are not deleted on retention period alone. The preview is advisory as of the time of the query and does not estimate the exact deletion count of artifacts to which reference protection applies.
- **Error paths:** The waiter of a cancelled `run` wait is reclaimed immediately, and subscribes with an invalid cursor are rejected before registration. Subscriptions per root are limited to 64. The session creation budget is reserved before the Worker call.
- **Runtime identification:** Full setup provides `gatewayBuildId` (SHA-256 of the src files at execution time), `runtimeRoot`, `instanceId`, `sourceCommit` (when a release manifest exists), the applied `configRevision`, and management `capabilities`.
- **Dependencies:** Security-fix versions of fast-uri, ip-address, hono and qs were reflected in the lockfile.

The existing API major **1**, state schema **5** and the 4 public client exports are retained. State v4 parallel writing also continues in 1.5.x to support explicit rollback. The stricter default rejection conditions of `daemon_shutdown` and the strengthened subscription truncation semantics are behavior changes that consumers must check. Existing AgenLynk must be updated separately to call the new management API and consume the capabilities. Upgrading the engine alone does not change the app's own settings writes or 501 endpoints.

`artifactSessionLimit`, `workerThoughtStream` and `workerSubagentTranscript` are not settings supported by the 1.5.0 engine. Legacy values are reported as `unsupportedLegacySettings` and are not shown as if applied. Monitor/Pet/display settings are the consumer's responsibility.

### Public management API and CLI

For the exact requests and responses, ownership and the migration procedure, see the [Management API contract](docs/management-api.md). The management CLI also uses the same `acp-gateway/client` RPC and connects to an already running daemon.

```bash
acp-gateway-admin setup
acp-gateway-admin gateway_config
acp-gateway-admin gateway_config '{"action":"set","expectedRevision":0,"values":{"idleUnloadMs":1800000}}'
acp-gateway-admin provider '{"action":"set_enabled","provider":"claude","enabled":false}'
acp-gateway-admin provider '{"action":"install","registryId":"claude-acp","dryRun":true}'
acp-gateway-admin retention_preview '{"values":{"sessionRetentionMs":86400000}}'
acp-gateway-admin shutdown_if_idle
```

Do not copy the 0 in the example for `expectedRevision`; use the value from the immediately preceding read. Settings are applied when a new daemon starts after a safe shutdown. A consumer that performs a restart or runtime replacement must first close its auto-reconnecting client, start a new daemon with the chosen runtime, and then check the runtime identification and applied values in setup.

### 1.5.x, 1.6.0, 1.7.0, 1.7.1 and 1.7.2 runtime builds

The builders for 1.5.x (`v1.5.0` through `v1.5.2`), `v1.6.0`, `v1.7.0`, `v1.7.1` and `v1.7.2` require the full source SHA that was reviewed separately from the tag. If the tag differs from that SHA, the build and verification are rejected, and the engine and public client of the new runtime are both extracted from the same source commit. The fixed-SHA verification for the existing 1.4.0 tag is retained.

```bash
npm run release:runtime -- --source-tag v1.7.2 --source-commit FULL_REVIEWED_SOURCE_SHA --output-dir dist
npm run release:verify -- --source-commit FULL_REVIEWED_SOURCE_SHA \
  --archive dist/acp-gateway-runtime-darwin-arm64.tar.gz \
  --sha256 dist/acp-gateway-runtime-darwin-arm64.tar.gz.sha256 \
  --build-record dist/acp-gateway-runtime-darwin-arm64.tar.gz.build-record.json
```

The commands above generate and verify local artifacts. GitHub Release upload and attestation are performed by the separate `Release runtime` workflow, and existing assets are not overwritten. Consumers must update their own lock with the checksum and source SHA of the newly published assets.

## v1.4.0

**Durable · Bounded · Quiet** — a stabilization release that is accurate even after a restart, keeps its main resources within stated limits, and does not wake Main unnecessarily.

### Version information

| Item | Version / requirement | Meaning |
|---|---|---|
| ACP Gateway | `1.4.0` | Release version of the daemon, Control MCP and installer |
| Gateway Control API | `1` | Public control method and response contract. Not raised for additive changes |
| State schema | `5` | `state.snapshot.json` + checksummed `state.wal.ndjson` |
| Legacy state schema | `4` | Written in parallel for rollback, and retained in 1.5.x as well for rollback compatibility |
| Runtime | Node.js `>=22` | macOS and Linux supported |
| Compatibility baseline | `1.3.2` | Response shape of core calls without arguments and existing methods retained |

`package.json`, the daemon and the Control MCP must all report `1.4.0` for a healthy state. In `agent_acp_setup`, you can check them with `gatewayVersion`, `gatewayApiVersion` and `stateSchemaVersion`, respectively. If the MCP host has cached an old tool schema, `staleFrontDoor` is shown, so follow the [host reconnection procedure](docs/operations.md#host-reconnection-procedure).

### 1.4.0 immutable runtime release record

The 1.4.0 downstream apps consume only `acp-gateway-runtime-darwin-arm64.tar.gz` of the `v1.4.0` Release and `acp-gateway/client`, rather than a moving branch or the `src/` private subpath. The public client contract consists of four items, `GatewayRpcClient`, `GatewayError`, `ERROR_CODES` and `GATEWAY_API_VERSION`, and other package subpaths are blocked at the `exports` boundary.

The release builder combines the public client and production dependencies with the pinned `v1.4.0` source commit `a1fdb353777337ca6ec481f8563d77efaea55e95`, and generates `runtime-manifest.json` containing an allowlist and per-file digests. Next to the local artifacts, a SHA-256 and an unsigned build record (`*.build-record.json`) are generated. This file is not an attestation, and outside GitHub Actions it is marked `origin: local`. The official signature is `actions/attest-build-provenance` in GitHub Actions, and the workflow verifies the archive with `gh attestation verify` before publishing. The three assets that have already been uploaded are not overwritten.

```bash
npm run release:runtime -- --source-tag v1.4.0 --output-dir dist
npm run release:verify -- \
  --archive dist/acp-gateway-runtime-darwin-arm64.tar.gz \
  --sha256 dist/acp-gateway-runtime-darwin-arm64.tar.gz.sha256 \
  --build-record dist/acp-gateway-runtime-darwin-arm64.tar.gz.build-record.json
```

The builder checkout must be clean. If the `v1.4.0` tag moves away from the pinned commit, both the builder and the verifier reject it. The manifest records the source tag/commit and the builder commit, and the tar entry order, normalized mode, mtime and ownership, and the gzip OS header are fixed, so identical bytes are generated from the same two commits.

### Release change history

1. **Establishing the error contract and characterization baseline** — Added stable Gateway error codes and the `{code,message,details}` wire envelope, and pinned the 1.3.2 default behavior of prompt, poll, Task and Inbox with characterization tests.
2. **Introducing SessionActor-lite** — Serialized prompt, cancel, close, restore and provider-exit with a per-session mailbox and explicit FSM guards. Also made late callbacks and duplicate terminal handling idempotent.
3. **Moving to TaskStore v2** — Unified Task TTL on a `createdAt` basis, and implemented terminal-first-wins, a blocking result waiter, cancellation semantics, root isolation, waiter and Task limits, and keyset pagination.
4. **State schema v5 and crash-safe recovery** — Added snapshot and checksummed WAL, fsync barriers, replay idempotency, a state-directory lock, and v4 migration and downgrade detection. On a corrupted internal WAL or snapshot, it stops safely instead of starting with an empty state.
5. **Bounded transport and resource budgets** — Applied frame, queue, lane and write-timeout limits to every NDJSON transport segment, and added explicit budgets for prompts, file reads, terminal output, sessions, Inbox and artifacts. Large files are handled with a bounded streaming read instead of a full `readFile`.
6. **Control/telemetry separation** — Protects control events such as permission, question and Task status from telemetry floods. Raw message/thought chunks are delivered only through live subscription, and usage is aggregated into turn/session totals without ring storage or poll wake-ups.
7. **Compact API and execution path simplification** — Added `agent_acp_run`, the `current|compact|diagnostic` response profiles, the setup summary, a result byte budget, Inbox filtering and paging, and idempotency keys.

The final stabilization fixed an issue where shutdown could hang because the close flush timer lost its reference, an issue where transport termination was not normalized to worker-death, bypasses of the aggregate transport and Inbox budgets, missing structured errors, and the possibility of duplicate execution during recovery in compact run. CI includes verification of session races, resource budgets, transport backpressure, Task conformance, state corruption and 18 crash cut-points.

### Main API additions

- **`agent_acp_run` introduced** — A single tool that sends a prompt and waits for the result. The direct return value and the MCP Task result are the **same object**, so there is only one shape to handle. When the wait time ends, it returns `{status:"working", taskId}` instead of an error, so on failure do not resend the prompt and retry with only `{taskId}` (duplicate execution is structurally impossible). If a permission is needed, it immediately hands control back with `{status:"input_required", pending}`. `idempotencyKey` provides one more layer of retry safety.
- **Response profiles** — Passing `responseProfile: "compact"` to `agent_acp_poll` removes the session envelope and leaves only `events` and the final `result`, reducing the size to **about one third** (empty poll 483 → 152 bytes, permission poll 814 → 483 bytes). `"diagnostic"` adds diagnostic information such as queue depth and pending request count. If the argument is omitted, the response is the same as before.
- **`setup mode:"summary"`** — A summary containing only the version, profiles, persistence, alerts and provider list (363 bytes, about 19% of the full). Because the `agent_acp_session_open` response carries the values needed for each session directly (`responseProfiles`, `limits`, `relevantAlerts`), there is no need to call setup again for each delegation.
- **Result budget** — `resultBudgetBytes` (0–65,536) and `resultDelivery` let you limit the size of the result returned on each call. The excess is delivered as a truncated body together with `totalBytes` and `omittedBytes` (measured against the full answer) and a pointer to the complete `textArtifact`, and a spill for the same answer happens only once.
- **Inbox filtering and paging** — Supports `sessionId`, `type`, `limit`, `cursor` and `detail:"summary"`. A call without arguments returns exactly the same full list as before.
- **Durability, bounds and quiet (PRs 1–6)** — Includes state v5 snapshot + WAL and crash-safe recovery, MCP Task semantics (TTL measured from creation time), a per-session mailbox and explicit state transitions, frame, queue and timeout budgets on every transport segment, control/telemetry lane separation and usage aggregation.
- **Host reconnection detection** — If the front door and daemon versions diverge, it is reported as `staleFrontDoor`. Follow the [host reconnection procedure](docs/operations.md#host-reconnection-procedure).

### Compatibility notes

- The response shapes of `task_list` and Inbox list without arguments, and of the default `current` poll, retain the 1.3.2 public contract. The compact and diagnostic profiles, pagination and summary are opt-in.
- Raw message/thought chunks are live-subscription only, not a retained poll history. A consumer that needs to replay past chunks after reconnecting needs its own storage layer.
- Large Inbox payloads return a preview and an artifact pointer instead of keeping duplicate full copies in memory.
- Requests that exceed the new resource budgets are rejected with a stable error code instead of being accepted without limit. Workloads that previously exceeded the limits should check `limits` in setup and adjust their settings.
- After using State v5, rolling back to 1.3.2 reads the legacy v4 state that was written in parallel. Check the downgrade-detection alert, then return to 1.4.0 again.

## v1.3.2

- **Final-result-centered poll** — poll neither retains nor delivers raw message/thought chunks; on completion it responds centered on the final `result` and the permissions and questions that Main must handle. Raw chunks are delivered only to live observers that subscribed explicitly; request stored intermediate evidence with `eventTypes`, `includeToolEvents` and `includeInspection`, and result thoughts with `includeThoughts`.
- **Usage event aggregation** — Repeated raw ACP `usage_update` events are not stored in the event ring or used to wake poll, and are summed into turn/session totals instead. A small summary is exposed only through the poll's `includeUsage`, session detail queries, and explicitly requested Task results.
- **Concise Worker return by default** — `agent-delegator` instructs the Worker to return only the conclusion, essential evidence, changed paths and test status concisely for requests that do not need a detailed report.

## v1.3.1

- **Completed ACP/MCP execution guide** — `agent-delegator` explains the entire process of turning a routing result into actual Control MCP calls. It covers provider and exact-model verification, session boundaries and `mcpServers`, direct prompt vs. MCP Task, cursor polling, permission and structured input, recovery and cleanup, and the bounded result and artifact retrieval contract.
- **Skill-only safe update** — `--update-skill` updates only the installer-managed copy without touching the Gateway runtime. It checks for user modification with the SHA-256 tree digest recorded at install time, retains customized and legacy installs by default, and overwrites them only with `--force`.
- **Separating initial install from update** — `--install-skill` is fixed as the first-install path and does not implicitly replace an existing managed copy. `--dry-run`, target validation, deduplication of the shared skill root, and state recording are also maintained in both paths.

## v1.3.0

Compared with v1.2.x, token usage flowing into the orchestrator per single Worker delegation turn shows a measured **up to 87% reduction** (same-scenario replay benchmark, about 84–87% across the full turn). This results from removing the retransmission of accumulated results and the double delivery of tool payloads from the default path, and the savings can be checked directly through `metrics` in `agent_acp_setup`.

- **Poll defaults switched to lean** — While a turn is in progress, the accumulated `result` is not sent repeatedly and is included only after completion, and `tool_call*` events are delivered, for both poll and subscribe, only when requested with `includeToolEvents: true`.
- **Result model separation** — The final answer is separated from the accumulated transcript of a Worker turn. `result.text` contains only the message text after the last work boundary (`tool_call` start, permission, elicitation), and progress narration is queried with `includeInspection: true` (4KB preview per segment + artifact pointer, `inspectionDropped` count). `includeTranscript: true` returns a bounded inline transcript, and the full overflow copy is retrieved through `resultArtifact`. Progress updates (`tool_call_update`), thoughts, usage and the like create no boundary, so they cannot cut off or erase the answer, and if the final segment is empty it safely falls back to the retained transcript.
- **Cap-and-point delivery** — Every payload that hits a limit gets a disk pointer with no loss of information. Tool-event `data`, permission `toolCall`, elicitation schema and message-chunk copies larger than 4KB (measured in UTF-8 bytes) are spilled to `dataArtifact` together with a truncated preview, and final answers larger than 64KB (`maxInlineResultBytes`) are spilled to `textArtifact`. Inbox records used for responses retain the full content.
- **Expanded poll query surface** — `toCursor` and `eventTypes` (exact match; only a trailing `*` is a prefix) allow range queries over the retained event history without waiting, and `filteredCount` shows how many events the cursor skipped. A wait wakes only when there are events or state changes the caller will actually receive, and numeric arguments explicitly reject negatives, NaN and fractions.
- **Lifecycle stabilization** — The retention timer is reset when a new turn starts, and in-progress turns are excluded from transient cleanup. Orphan cancellation is also emitted through the result model, and artifacts referenced by live sessions are retained in the 24-hour prune.
- **Transport metering** — The Gateway accumulates the number of poll responses, bytes and per-event-type delivery and exposes them through `metrics` in `agent_acp_setup`. Token savings can be checked as an operational metric rather than an estimate.
- **Skill guide update** — Added to `agent-delegator` a result retrieval path table (final/narration/transcript/tool evidence/oversized payload) and guidance for pointer-based Worker handoff (pass only the path; a cold start in which the downstream Worker reads it directly).

## v1.2.1

- **Claude front door installation fix** — The MCP name is passed before the environment variables to match the variadic `-e` parsing rules of Claude Code 2.1.220. Fixed an issue where `--install-all --front-door claude` aborted with `Invalid environment variable format: agent-acp`.
- **Claude MCP regression test** — Verifies that the `agent-acp` name comes before the environment variables in the Control MCP registration command.

## v1.2.0

- **Worker parameter control** — `agent_acp_config` lets you query the list of settings exposed by an ACP Worker and their current values, and change supported select and boolean values per session.
- **Foundation for autonomous orchestration** — Exposes the model, mode, reasoning level and model-setting category in a common format and records change history as `config_changed` events, so it can be used for future per-DAG-node parameter policies.
- **Safe dynamic validation** — Blocks options the Worker has not advertised, select values outside the allowlist, invalid boolean types and changes to a running session. Process-level model changes require a new session.
- **Complete manual update** — `--update` performs the upstream check and the full test suite before replacing the daemon, and `npm run update:upstream` was added to refresh the snapshot and adapter pins without GitHub Actions.

## v1.1.0

- **Front door selection at install** — When `--install-all` is run, the user chooses one orchestrator to converse with among Codex, Claude and Grok. The Control MCP is installed for the chosen AI, and the Guide MCP and the `agent-delegator` skill are installed for all discovered AIs. In automated environments it can be specified explicitly with `--front-door codex|claude|grok`.
- **ACP adapter auto-update** — The Gateway daemon checks the ACP agent registry when it starts and every 24 hours afterward. Newer `npx` and `uvx` adapters are updated automatically, and already running work is not terminated; the new version applies from the next Worker launch.
- **Update status alerts** — The health check reports adapter update applied or failed, manual update required, stale registry and downgrade risk. `agent-delegator` relays these alerts to the user.
- **New Gateway version alert** — If GitHub `main` has a higher version than the local one, the health check reports it. Gateway source is never changed arbitrarily, and is updated only when the user runs `acp-gateway-bootstrap --update`.
- **Automatic upstream change monitoring** — GitHub Actions checks the ACP protocol release and the agent versions in the official registry daily, and when a change is found, creates or updates an update PR targeting the `dev` branch.
- **Install and update stabilization** — Addressed an issue where a leftover previous-version daemon made the health check fail, by replacing the daemon on a version mismatch. Added `--version`, and `--update` does not overwrite a user-modified `agent-delegator` skill.
- **Dependency baseline update** — Registry snapshot and runtime dependencies were updated to Claude ACP `0.64.1`, Codex ACP `1.1.9` and MCP SDK `1.30.0`.
