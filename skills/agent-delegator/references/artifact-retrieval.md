# Retrieving results and artifacts

## The full table

| Need | Retrieval contract |
|---|---|
| Terminal answer | run return, Task result, or poll `result.text`; normally the final message segment, falling back to the retained transcript when the turn ends with no non-empty final segment |
| Oversized terminal answer | `result.textArtifact`; require a complete, present, non-truncated artifact |
| Active partial text | poll with `includeResult: true`; `result.text` is cumulative transcript, not a terminal answer |
| Retained inline transcript | `agent_acp_session {action: "get", includeTranscript: true}`; `resultText` and `transcriptBytes` describe only the bounded in-memory text |
| Complete overflowed transcript | `result.artifact`, or session list/get `resultArtifact`; when present it holds the complete spill after finalization, while inline `resultText` is only the retained tail |
| Intermediate narration | poll with `includeInspection: true`; each closed segment has a 4KB preview plus an artifact pointer when larger, and `inspectionDropped` counts evicted segments |
| Tool evidence | poll with `includeToolEvents: true`, a retrospective poll with `cursor`/`toCursor`/`eventTypes`, or session `get` with capped `includeEvents` |
| Oversized event payload | event `dataArtifact`, or the full durable inbox item for permission and elicitation requests |
| Token and cost totals | `includeUsage: true` adds `result.usageSummary` with `{turn, session}`; session `get` returns the same under `usage` |

## Size budgets

Three separate limits, and confusing them is the usual mistake:

- `limits.maxInlineResultBytes` (from `session_open`) — how much final text the Gateway keeps in memory. Beyond it the answer is spilled and `textArtifact` appears on its own.
- `resultBudgetBytes` (per call on poll, or stated when the work is submitted on run and task-mode prompt) — how much of it is delivered to you.
- Durability has its own internal limit; when a durable result reference is lost you receive a short preview with `resultDegraded: true`, which is why a large budget can still return a small text.

The decision tree for one result:

- `resultDelivery: "artifact"` — `text` is empty, `omittedBytes` equals `totalBytes`, and `textArtifact` points at everything.
- bytes within budget — exactly the default shape, no extra keys.
- bytes over budget — a bounded head in `text` plus `totalBytes`, `omittedBytes`, and a guaranteed `textArtifact`.

`totalBytes` is the size of this answer. `transcriptBytes` is the size of the whole narration. They are different numbers and are rarely equal. The head is cut on a UTF-8 character boundary, so it can land just under the budget.

The spill happens once per answer: polling the same finished turn again returns the same `textArtifact` rather than writing a new file.

## Producing a large deliverable

When writes are allowed and the output may be large, have the Worker write the deliverable inside `cwd` and return a concise answer plus an absolute path. Under `read_only` do not ask for file output at all — require a compact inline Result Packet instead.

## Accepting an artifact

Accept only when `complete` is true, `path` is present, and `truncated` is false. A frame rejected by the protocol hard limit is not a valid artifact. Artifacts are recovery pointers for Main, not handoff files between Workers — for a Worker-to-Worker handoff, have the upstream Worker write into a directory the downstream one can read and pass the absolute path.

Retention removes artifacts on the schedule in `limits`; read what you need before it elapses rather than assuming a path stays valid.
