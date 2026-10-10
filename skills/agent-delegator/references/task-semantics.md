# Task semantics

## Why agent_acp_run and tasks/result are the same object

`agent_acp_run` always creates a Task handle, even when it returns the answer directly. Both the direct return and the host's Task result operation read the same stored envelope, so they are identical byte for byte on the same `taskId`. There is one shape to parse and one set of fields to branch on:

```json
{"ok": true, "sessionId": "...", "turnId": "...", "taskId": "...", "status": "idle",
 "usage": {...}, "result": {"text": "...", "transcriptBytes": 0, "artifact": null, "stopReason": "end_turn"}}
```

`ok: false` carries `error` and is the same object a failed Task result returns. `status` here is the session's state (`idle`, `cancelled`, `error`); the Task's own state (`completed`, `failed`, `cancelled`) is what `tasks/get` reports.

Non-terminal returns are **not** errors and have no `result`:

- `{"ok": true, "status": "working", "incomplete": "wait_budget_exceeded", "taskId": "...", "next": {...}}` — the wait ran out; the worker is still going.
- `{"ok": true, "status": "input_required", "taskId": "...", "pending": {...}, "next": {...}}` — answer `pending`, then attach.

Treating either as a failure and re-sending the prompt is how one unit of work becomes two.

## Sleeping in agent_acp_wait

`agent_acp_wait` is the waiting half of `agent_acp_run {waitMs: 0}`: one call that blocks until the tasks you started need you, for all of them at once.

```json
{"ok": true, "reason": "task_finished",
 "tasks": [{"taskId": "...", "sessionId": "...", "provider": "codex", "status": "completed", "statusMessage": "end_turn", "outcome": {...}},
           {"taskId": "...", "sessionId": "...", "provider": "claude", "status": "working", "statusMessage": "Prompt running"}],
 "counts": {"finished": 1, "needsInput": 0, "working": 1},
 "next": {"wait": {"tool": "agent_acp_wait", "arguments": {}}}}
```

- `reason` is the first that holds: `needs_input`, `task_finished`, `nothing_pending`; `heartbeat` when the sleep ran out first.
- `outcome` is the run envelope above, and taking it marks the result seen, as `agent_acp_run {taskId}` does. One answer carries about 64 KB of outcomes; a finished task that did not fit has no `outcome` and is in `next.collect`. The next wait delivers it too.
- A task waiting on you carries `pending`, and `next.answer` names the tool and its `sessionId` and `requestId`.
- `taskIds` narrows the wait to those tasks; another Main's tasks are never watched. `gone` lists watched tasks whose TTL ran out.
- The sleep is as long as your host allows one tool call (`timeoutMs` only shortens it). Leave it out.

## Handles

- Every handle reports `origin`: `run` or `prompt`. `tasks/list` shows both.
- `ttl` is measured from creation, not from the last update. A chatty task cannot extend its own lifetime. After the TTL the handle and its payload are gone and the id reads as unknown.
- `pollInterval` is the millisecond floor the Gateway asks you to respect between status checks.
- A handle outlives its session: task retention and session retention are separate.
- A task still running when the Gateway restarts comes back `failed` with a restart message. The handle survives — attaching returns that failure, never "unknown task". The old ACP request cannot be resumed; open or restore a session and start again.

## Task mode through the host

If the host opts in through the MCP `tools/call` request's `task` or `_meta.task` object (with optional millisecond `ttl` and `pollInterval`), the tool returns a handle instead of waiting. Do not put those fields inside the tool arguments.

- Use the host's standard `tasks/list` and `tasks/get` for status, and its result operation only after `completed`, `failed`, or `cancelled`.
- On `input_required` the Task status does not say what kind of request is waiting: inspect `agent_acp_inbox`. `type: permission_request` is answered with `agent_acp_permission`, `type: worker_question` with `agent_acp_answer`. The Task handle itself cannot answer a Worker.
- Use the host's Task cancel operation for Task-mode cancellation, then keep checking status until terminal.

`agent_acp_prompt`'s Task support is deprecated in 1.4.0 and removed in 1.5.0, because a direct prompt returns an acknowledgement while its Task result returns a terminal envelope — two different shapes from one tool. `agent_acp_run` does not have that split.

## Cancelling versus giving up on a wait

These are different instructions:

- `agent_acp_cancel`, or the host's Task cancel, tells the Worker to stop. The turn ends `cancelled`.
- A `waitMs` that runs out, or a client that stops listening, only ends the waiting. The Worker keeps going and the handle stays collectable; attach again to get the outcome.
- The same holds for `agent_acp_wait`: a heartbeat, a cancelled call or a host timeout ends the sleep, never a task. Call it again.
