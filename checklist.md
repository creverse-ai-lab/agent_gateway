# ACP Gateway 1.4.0 Checklist — Durable · Bounded · Quiet

> 재시작 후에도 정확하고(Durable), 모든 자원이 제한되며(Bounded), Main을 불필요하게 깨우지 않는(Quiet) Gateway.
>
> 작성 경위: Claude(Main) 초안 → **gpt-5.6-sol red-team**(코드 대조 검증, 2026-08-12, 기준 커밋 `a0b7613`/1.3.2) → 반영. 판정: **GO-WITH-CHANGES**.

---

## 0. 전제·확정 사항

- **Base branch: `dev`** — `main`에서 신설(2026-08-12 사용자 확정). 모든 PR은 `dev` 대상, 릴리스 시 `dev`→`main` merge PR.
- **기본값 동결 원칙.** 현재 기본 poll은 이미 permission/elicitation만 전달하고 active result도 생략한다(`src/gateway-service.js:21,677-745`). 이 동작을 golden으로 동결하고, `compact`·`diagnostic` **둘 다 opt-in**으로 추가한다. "기본 diagnostic 유지"는 현재 동작과 반대이므로 폐기.
- **각 PR은 독립적으로 `npm run ci` green.** 행동 변화는 PR 1의 characterization golden diff로만 드러나야 한다.
- **Runtime source of truth:** 이 repo(`agent_gateway`)가 canonical runtime과 공개 API 계약을 소유한다. downstream consumer는 versioned runtime artifact와 공개 계약만 소비하며, consumer별 배포·통합 검증은 각 consumer 경계에서 담당한다.
- **공개 API 호환성 가드레일:**
  - `session`, 무페이지 `task_list`, full `inbox` 응답은 기존 공개 계약 — summary/pagination 기본화는 breaking change이므로 opt-in으로만 제공한다.
  - `content`+`structuredContent` 중복은 기존 MCP 응답 계약이므로 유지한다.
  - `skills/agent-delegator/SKILL.md:94-112`가 cursor/terminal result/full inbox 전제 — 새 skill은 capability 확인 후 compact 요청, 구 Gateway에서 standard fallback.
  - MCP host의 tool schema cache — 새 tool/profile 배포 후 재연결 절차 필요.

---

## 1. Red-team 사실 검증 결과

| # | 주장 | 판정 | 근거 |
|---|---|---|---|
| C1 | poll `waitMs` 기본 0, 즉시 반환 | CONFIRMED | `src/gateway-service.js:677-700` |
| C2 | Task 기본 `pollInterval` 1초 | CONFIRMED | `src/gateway-service.js:593-606` |
| C3 | terminal task 미저장·TTL이 lastUpdatedAt 기준·실행중 result 즉시 오류·list 전량 반환 | CONFIRMED | `src/gateway-service.js:631-642,1169-1178,1368-1377` |
| C4 | inbox list가 get과 동일 full payload 반환 | CONFIRMED | `src/gateway-service.js:654-673,1502-1519`, `test/gateway.test.js:441-477` |
| C5 | 최종 result inline cap 64KB, 설정 미노출 | CONFIRMED | `src/gateway-service.js:33-40`, `src/sessions.js:193-205`, `src/config.js:27-42` |
| C6 | 단일 ring에 control/telemetry 혼재·FIFO 제거 | PARTIAL — **session별** 단일 ring. control도 유실 가능 | `src/sessions.js:56-69,256-261`, `src/config.js:35` |
| C7 | usage_update 완전 폐기 | CONFIRMED | `src/gateway-service.js:884-890` |
| C8 | read_text_file 전체 readFile 후 절단 | CONFIRMED | `src/acp-client.js:392-401` |
| C9 | stdin/socket backpressure 미처리, slow subscription 제거 후 복구 없음 | CONFIRMED(일부 완충 존재) | `src/acp-client.js:105-134,601-607`, `src/socket-rpc.js:120-139,195-201`, `src/socket-flow.js:10-32` |
| C10 | --update가 검증 전 live checkout 변경, MCP remove-then-add, blocker 검사 없음 | CONFIRMED | `src/source-update.js:3-21`, `src/installer.js:497-518,400-438,812-845` |
| C11 | state.json atomic rename이나 version 검증/migration/checksum/fsync 부재 | CONFIRMED | `src/gateway-service.js:1368-1382,113-160` |
| C12 | gatewayApiVersion 이미 존재(1) | **REFUTED** — 이 repo에는 없음. 1은 ACP wire version(`src/acp-version.js:1`)이고 state version은 4(`src/gateway-service.js:1373-1377`)이므로 별도 공개 API 버전이 필요함 | repository source audit |

---

## 2. PR 로드맵 (red-team 반영 확정판)

원래 초안에서 조정된 것: **SessionActor-lite를 PR 2로 전진**(FSM을 PR7에 두면 PR2~5가 race 위에서 구현됨), **TaskStore(의미론)와 State v5(내구성) 분리**, **transactional updater·monolith 재배치는 1.4.0에서 제외**.

### PR 1 — Characterization·버전·구조적 에러 (행동 변화 0)

- [ ] `gatewayApiVersion` **신설** — ACP wire version(1), state schema version과 명확히 구분되는 단일 공개 API 버전 모듈
- [ ] `stateSchemaVersion`(현재 4) 상수화 + setup 응답 노출(additive)
- [ ] `src/errors.js` 안정 error code 레지스트리 + **wire envelope 전파** `{code,message,details}` — 현재 daemon/client가 message만 전달(`src/gateway-daemon.js:78-81`, `src/socket-rpc.js:203-207`)해 code가 소실됨
- [ ] characterization golden: 현재 **실제** 기본값 기준 — 기본 poll 이벤트 필터, setup 필드셋, prompt ack shape, inbox list 전문 반환, task 지속성(terminal 미저장)/TTL(lastUpdatedAt)/list 전량/실행중 result 오류
- [ ] `scripts/bench-payload.js`: 대표 flow(empty poll/active poll/setup/inbox list/terminal result) serialized bytes 측정 + baseline fixture + CI soft 리포트
- [ ] chaos 헬퍼 기초: daemon spawn / kill -9 / restart 테스트 유틸
- 테스트: 기존 suite green + golden green. golden은 필드 존재/부재 단위로 비교(과도한 엄격성 금지)
- 완료 기준: 행동 변화 0. 이후 모든 PR의 행동 diff가 golden 변경으로 명시됨

### PR 2 — SessionActor-lite (동시성 기반 선행)

- [ ] session별 mailbox로 mutating command 직렬화: prompt/cancel/close/config/restore + prompt completion·provider-exit callback (`src/gateway-service.js:529-590,792-864,997-1017`의 독립 변경 경로 정리)
- [ ] 명시적 전이 guard (문자열 대입 산재 제거)
- [ ] terminal callback idempotency — 중복 terminal callback 무해화
- [ ] **대규모 파일 재배치 없음** — 기존 구조 내 최소 침습
- 테스트: prompt/cancel/close 동시 race, provider-exit vs 진행중 turn, answer/cancel 동시, 중복 terminal callback
- 완료 기준: race 테스트 green, 기존 golden 무변화

### PR 3 — TaskStore v2: MCP Task 의미론

- [ ] TaskStore 모듈 추출: create/transition/waitForTerminal/result/listPage/cancel/expire/recover
- [ ] TTL을 `createdAt+ttl` 기준으로 변경(MCP 계약·SDK types 일치, `node_modules/@modelcontextprotocol/sdk/.../spec.types.d.ts:1234-1289`) + **TTL 경과한 active task 처리 정의**(SDK 참조 구현이 모순되므로 conformance test가 기준)
- [ ] `tasks/result` blocking waiter + abort/disconnect 처리 + **task별·root별 waiter cap 동시 도입**(DoS 창 방지 — PR5로 미루지 않음)
- [ ] `tasks/list` cursor pagination — 단 기존 무인자 호출은 공개 API 하위 호환성을 위해 기존 의미 유지
- [ ] `io.modelcontextprotocol/related-task` metadata
- [ ] terminal task in-memory retention(TTL까지) — 디스크 내구성은 PR 4
- [ ] budgets: `maxTaskTtlMs`, `maxTasksPerRoot`, `maxConcurrentTasksPerRoot`
- 테스트: TTL 경계(0/null/max/경과 중 active), pagination 중 insert/delete, root 격리, waiter cap, direct 결과와 `tasks/result`의 `content/structuredContent/isError` 동형성
- 완료 기준: MCP Task conformance(재시작 내구성 항목 제외) 통과

### PR 4 — State v5: snapshot + critical WAL (Durable)

- [ ] `state.snapshot.json` + `state.wal.ndjson` — WAL은 control 전이만: task.created/status_changed/result_committed, inbox.created/resolved, session.registered/closed/owner_changed
- [ ] **durability protocol 명시**: artifact fsync → WAL append/fsync → 응답 반환; snapshot temp fsync → rename → directory fsync → WAL compaction
- [ ] replay idempotency — duplicate replay 무해
- [ ] v4→v5 migration + **downgrade 전략**(dual-read 또는 compat marker — 구 daemon이 기존 `state.json`만 읽고 빈 상태로 시작하는 사고 방지)
- [ ] terminal task/result reference 지속화 + task result artifact를 GC keep-set에 포함
- [ ] task retention과 session retention 분리
- [ ] persistence unhealthy 시 신규 task **fail-closed**(`PERSISTENCE_UNHEALTHY`) — durable create 완료 후에만 Task handle 반환
- [ ] daemon 재시작 후 in-flight task는 failed 처리 명시
- 테스트: crash-point matrix(kill -9: task 생성/permission/result commit 각 지점 — phantom 없음), WAL tail 절단·mid-record 손상·compaction 중 crash, migration 실패, downgrade, 재시작 후 terminal task 조회/result 회수
- 완료 기준: acceptance gate Task/Crash/Recovery 항목 통과

### PR 5 — Bounded transport & 자원 예산 (Bounded)

- [ ] `NdjsonChannel` 공통 채널: serialize-once, frame cap, priority lane, queue byte budget, `write()===false` 시 drain 대기, write timeout
- [ ] **HIGH lane은 "보장"이 아니라**: 미전송 LOW drop/coalesce + gap marker, HIGH queue reserve, timeout 후 disconnect, 재접속 시 cursor replay (kernel buffer에 들어간 프레임은 추월 불가)
- [ ] 적용: daemon socket / `GatewayRpcClient` / ACP child stdin
- [ ] connection당 bounded in-flight request
- [ ] `fs/read_text_file` streaming: stat → 요청 범위만 읽기 → byte budget 도달 시 중단 (전체 `readFile` 제거)
- [ ] byte budgets — knob 남발 금지, **root/session/connection 3단 정책**으로 시작: maxInboxItemBytes, pending inbox bytes(session/root), maxPromptBytes, maxTerminalOutputBytes 우선
- [ ] oversized permission/elicitation: 전문 메모리 유지 대신 compact record + artifact pointer
- 테스트: never-drain socket, partial LOW 후 HIGH 도달, timeout/close, oversized frame, telemetry starvation, reconnect gap replay, 거대 파일 read RSS plateau, budget 초과 structured error
- 완료 기준: slow observer 존재 시에도 permission/cancel/result 도달(재접속 replay 포함), RSS plateau

### PR 6 — Control/Telemetry 분리 + Usage 집계 (Quiet 내부화)

- [ ] session ring에서 control event(세션 생애·turn·task status·permission/elicitation·cancel·disconnect·error·config) 보호 — telemetry에 의해 eviction 불가. ※ "durable"의 의미 = 메모리 eviction 보호(디스크 내구성은 PR 4 WAL 범위)
- [ ] message chunk는 TurnAccumulator에만 append — raw chunk를 ring에 저장하지 않음
- [ ] `tool_call_update`: toolCallId별 최신 projection만 유지
- [ ] thought capture policy: `none | tail | full`
- [ ] usage_update 폐기 중단 → `UsageAccumulator[sessionId,turnId]` 집계, terminal `usageSummary`(옵션) + diagnostic 조회 노출
- 테스트: telemetry 폭주 시 control 보존, usage 집계 정확성(input/output/cache), 기존 기본 poll 필터 golden 유지
- 완료 기준: Wake-up 게이트 — 입력·완료 외 progress가 Main을 깨우지 않음

### PR 7 — Compact API & agent_acp_run (Quiet 표면, 전부 opt-in)

- [ ] poll `responseProfile`: **current(기본, 동결)** | compact | diagnostic — capability 협상 기반
- [ ] compact 응답: `{ok, sessionId, turnId, status, nextCursor, events[]}` + terminal일 때만 result
- [ ] inbox list summary + `limit/cursor/sessionId/type/status/detail` 필터 — **opt-in**(기본 공개 API 계약 유지), full payload는 get/artifact
- [ ] setup `mode=summary` + `session_open` 응답에 provider/model/relevantAlerts 포함해 정상 경로 setup 생략 (registry revision cache는 실측 후 별도 결정)
- [ ] per-turn result budget: `resultBudgetBytes`/`resultDelivery` → `{text(preview), totalBytes, omittedBytes, textArtifact}`
- [ ] `agent_acp_run` 신설: direct 결과와 MCP Task `tasks/result`가 **동일한 CallToolResult(동형성)**. 기존 `agent_acp_prompt`는 ack 의미 유지 — mode 인자로 반환 의미를 바꾸지 않음. prompt의 Task 지원은 deprecated 또는 ack 동형 유지
- [ ] `content`+`structuredContent` 중복 유지
- [ ] skill 분리: `SKILL.md`(정상 경로) + `references/{recovery,task-semantics,artifact-retrieval,multi-worker,diagnostics}.md` — capability 확인 후 compact 요청, 구 Gateway fallback
- [ ] waitMs/pollInterval 권장값은 skill·문서로(서버 기본값 불변): active poll 30~60s, Task pollInterval 3~5s + adaptive backoff
- [ ] MCP host schema cache 대응 재연결 절차 문서화
- 테스트: 프로파일별 golden, run↔task 동형성, PR1 baseline 대비 bench 개선 수치, 구 skill live smoke
- 완료 기준: Token/Inbox 게이트 + bench 개선 확인

---

## 3. 1.4.0에서 제외/연기 (red-team 권고)

| 항목 | 연기 사유 | 목표 |
|---|---|---|
| Transactional updater (staged runtime/rollback) | **stable launcher 선행 필요** — MCP 등록이 checkout `src/index.js`를 직접 참조(`src/installer.js:653-702`)해 pointer 교체만으로 runtime이 바뀌지 않음. canonical runtime의 배포·전환 모델 확정 선행. (1.4.1 연기 사용자 승인, 2026-08-12) | 1.4.1 |
| monolith 디렉터리 전면 재배치(core/persistence/transport/…) | stabilization release에 불필요한 대규모 churn | 1.5 |
| provider registry revision cache·setup delta | hot-path 비용 실측 후 | 1.4.1+ |
| updater TOCTOU/lock/rollback 테스트 | updater와 함께 이동 | 1.4.1 |

## 4. Non-goals (1.4.0)

DAG scheduler / LLM routing / auto result evaluator / distributed·multi-machine / TypeScript rewrite / SQLite·외부 broker / ACP v2 / 거대 generic tool 통합 / **content+structuredContent 중복 제거(금지 — 계측 전)** / thought·terminal output 무조건 제거

---

## 5. Acceptance Gate (1.4.0 릴리스 조건)

| 영역 | 통과 조건 |
|---|---|
| Task | 완료 Task가 daemon 재시작 후에도 TTL(createdAt 기준) 전까지 조회·result 회수 가능 |
| Crash | task 생성·permission·result commit 각 지점 kill -9에도 phantom state 없음 |
| Token | hot path에서 setup 반복 없음(opt-in 경로), compact profile에서 정적 필드 제거 |
| Wake-up | 입력·완료 외 progress가 Main을 깨우지 않음 |
| Inbox | (opt-in) list는 bounded summary, full payload는 get/artifact |
| Resource | 거대 파일 read가 전체 파일을 메모리에 올리지 않음 |
| Transport | slow observer 존재 시에도 permission/cancel/result가 drop/replay 정책 하에 전달됨 |
| Recovery | 잘린 WAL·손상 snapshot에서 명시적 복구 또는 안전 중단, v4 downgrade 안전 |
| Soak | 다중 Worker·tool-heavy workload에서 RSS와 queue plateau |
| Protocol | MCP Task TTL/result/list/related-task conformance 통과 |
| Compat | 공개 API 소비자·기존 skill·기존 poll 기본값 golden 무변화 |

---

## 6. 진행 규칙

1. PR 순서 고정 1→7. 각 PR은 `dev`에서 분기, `dev` 대상. 릴리스 시 `dev`→`main`.
2. 매 PR: 구현 → `npm run ci` green → golden diff 검토(의도된 변화만) → bench 회귀 확인 → merge 후 다음.
3. 행동 변화가 있는 PR은 checklist의 해당 항목과 golden diff를 PR 본문에 명시.
4. red-team 재검증: PR 3(Task 의미론), PR 4(WAL), PR 7(API 표면)은 merge 전 sol 재검토 권장.
