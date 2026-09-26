# ACP Gateway Test Scenarios

이 문서는 ACP Gateway의 기능·보안·복구 동작을 검증하는 acceptance test 기준이다. 파일명은 프로젝트에서 요청한 `test_scinario.md`를 유지한다.

## 실행 시간 원칙

- Worker turn 자체에는 전체 실행 deadline을 두지 않는다. 다만 unpinned session은 Main 활동이 orphan grace 동안 없으면 abandoned resource로 정리한다.
- 오래 실행된다는 이유만으로 Gateway가 worker를 종료하거나 실패 처리하면 안 된다.
- `poll.waitMs`와 socket RPC timeout은 한 번의 통신 대기를 끝내는 값이며 worker 실행 제한이 아니다.
- MCP Task의 `ttl`은 완료된 task handle의 보존 기간이다. 실행 중인 task를 만료시키면 안 된다.
- 실행 종료는 worker의 정상 완료, 사용자 취소, provider 종료, 복구 불가능한 오류 또는 unpinned orphan lease 만료로만 발생한다.
- 테스트 harness도 반복 횟수가 아니라 terminal state까지 기다려야 한다. CI 보호용 timeout이 필요하면 제품 동작과 분리하고 실패 원인을 `harness_timeout`으로 표시한다.

## 상태 표기

- `자동화됨`: 현재 테스트가 acceptance condition을 검증한다.
- `부분`: 관련 테스트는 있지만 핵심 조건 일부가 빠져 있다.
- `미구현`: 제품 코드 또는 테스트가 아직 없다.
- `수동`: 실제 provider와 장시간 실행이 필요한 smoke test다.

## 1. MCP → ACP 옵션 전달

### SC-01 Full-access session

1. Main이 MCP로 `model`, `permissionPolicy=auto_approve`, 작업 디렉터리와 MCP server 목록을 전달한다.
2. Worker가 작업 디렉터리 파일을 읽고 수정한다.
3. Worker가 terminal로 테스트 명령을 실행한다.
4. 전달된 worker용 MCP server를 사용할 수 있는지 확인한다.

기대 결과: Main이 선택한 모델로 실행되고 파일 수정과 명령 실행이 성공하며, Control MCP와 Gateway token은 worker 환경에 없어야 한다.

현재 상태: `부분` — ACP 표준 session model config와 Grok process model 전달, 실제 write/terminal, Control MCP 차단을 검증한다. 별도 worker MCP의 실제 호출은 아직 smoke 범위 밖이다.

### SC-02 Read-only session

1. `permissionPolicy=read_only`로 session을 연다.
2. 파일 읽기·검색은 허용한다.
3. 파일 쓰기와 terminal 생성을 요청한다.

기대 결과: 읽기만 성공하고 쓰기·terminal은 Gateway에서 거절된다.

현재 상태: `자동화됨` — ACP direct write의 read-only 거절을 검증한다.

### SC-03 Ask policy

1. `permissionPolicy=ask`로 session을 연다.
2. Worker가 읽기, 수정, terminal 명령을 각각 요청한다.
3. Main이 MCP inbox를 읽고 한 요청은 승인, 한 요청은 거절한다.

기대 결과: 승인된 작업만 실행되고, 요청과 응답이 올바른 session/turn에 기록된다.

현재 상태: `자동화됨` — permission 왕복, 직접 write 승인, edit 승인과 terminal 승인의 capability 분리, terminal 거절을 검증한다.

## 2. 파일시스템 경계

### SC-04 Write and overwrite

작업 루트 안에서 새 파일 생성, 기존 파일 덮어쓰기, UTF-8 콘텐츠 쓰기를 검증한다.

기대 결과: 내용이 정확하고 다른 session의 root에는 영향을 주지 않는다.

현재 상태: `자동화됨` — 새 파일 생성과 내용 검증을 수행한다.

### SC-05 Path escape

다음 경로를 읽기와 쓰기 양쪽에서 시도한다.

- `../`를 이용한 root 이탈
- 절대 경로로 root 이탈
- root 내부 symlink가 외부 파일을 가리키는 경우
- 존재하지 않는 파일의 부모 디렉터리가 외부 symlink인 경우

기대 결과: 모두 거절되며 외부 파일이 변경되지 않는다.

현재 상태: `부분` — 실제 경로, 외부 파일 symlink 쓰기, 존재하지 않는 파일의 외부 symlink 부모 쓰기를 차단한다. read 방향 전체 조합 검증이 남아 있다.

## 3. Terminal lifecycle

### SC-06 Create, output, wait, release

1. 짧은 stdout/stderr 명령을 생성한다.
2. 실행 중 output을 조회한다.
3. `wait_for_exit`로 종료 코드와 signal을 확인한다.
4. release 후 같은 terminal ID를 조회한다.

기대 결과: stdout/stderr와 종료 상태가 정확하며 release 후에는 unknown terminal 오류가 난다.

현재 상태: `자동화됨` — create/output/wait/release와 종료 출력을 검증한다.

### SC-07 Kill and cleanup

장시간 명령을 실행한 뒤 `kill`, session cancel, session close, provider stop을 각각 수행한다.

기대 결과: child process와 wait promise가 모두 정리되고 orphan process가 남지 않는다.

현재 상태: `부분` — 명시적 task cancel의 terminal 종료와 task/session `cancelled`, ask 대기 operation 정리를 검증한다. SIGTERM 무시 프로세스의 SIGKILL 전환과 session close/provider stop별 orphan 확인은 남아 있다.

### SC-08 Terminal session isolation

두 session에서 terminal을 하나씩 생성하고 상대 terminal ID로 output, wait, kill, release를 요청한다.

기대 결과: 모든 교차 요청이 거절된다.

현재 상태: `자동화됨` — terminal 소유 session을 저장하고 교차 조회를 거절한다.

### SC-09 Output limit and Unicode

byte limit보다 큰 ASCII·다국어 출력을 생성한다.

기대 결과: 앞부분이 잘리고 `truncated=true`이며 UTF-8 문자가 깨지지 않는다.

현재 상태: `자동화됨` — 다국어 출력을 작은 byte limit으로 자른 경우와 한 문자가 여러 stream chunk로 분리된 경우의 UTF-8 무결성, `truncated`, suffix를 검증한다.

### SC-10 Environment isolation

terminal에서 환경변수를 출력한다.

기대 결과: 일반 환경과 명시적으로 전달한 session 환경은 보이지만 Gateway control token, root ID, socket path는 없어야 한다.

현재 상태: `자동화됨` — 명시적 환경은 전달하고 Gateway token/root/socket은 부모·요청 양쪽에서 제거하는지 검증한다.

## 4. Worker 질문과 Inbox

### SC-11 Permission inbox

권한 요청 생성, Main 재접속, 승인·거절, Gateway 재시작을 검증한다.

기대 결과: Main 재접속 중에는 pending 상태가 유지되고, Gateway 재시작으로 RPC가 사라지면 `interrupted`가 된다.

현재 상태: `자동화됨` — Gateway 재시작과 provider process 종료를 모두 검증한다.

### SC-12 General worker question

Worker가 권한 요청이 아닌 선택 질문을 ACP elicitation으로 보낸다.

기대 결과: 질문과 선택지가 inbox에 저장되고 Main 응답이 같은 worker turn으로 돌아간다.

현재 상태: `자동화됨` — ACP form elicitation을 durable inbox의 `worker_question`으로 보존하고 `agent_acp_answer` 응답을 같은 turn으로 되돌린다.

## 5. Socket event delivery

### SC-13 Cursor replay

구독 중 연결을 끊고 마지막 session sequence 이후로 재구독한다.

기대 결과: 누락·중복 없이 이후 이벤트만 전달되고 다른 Main의 이벤트는 노출되지 않는다.

현재 상태: `자동화됨` — service replay, 과거 event의 고유 turn ID, cursor truncation 표시, 소유권, client의 마지막 cursor 기반 자동 재연결·재구독, 같은 socket chunk에서 replay/live event 순서를 검증한다.

### SC-14 Dynamic watch-all

Main의 전체 session을 구독한 후 새 worker session을 만든다.

기대 결과: 새 session의 첫 이벤트부터 같은 구독으로 전달된다.

현재 상태: `자동화됨` — session ID를 생략한 watch-all 구독이 구독 이후 생성된 동일 Main session의 첫 이벤트부터 받는지 검증한다.

### SC-15 Slow subscriber

이벤트 소비를 중단해 socket buffer 제한을 초과시킨다.

기대 결과: Gateway가 해당 연결만 종료하고 다른 session과 subscriber는 유지한다. 재구독 시 cursor replay가 가능해야 한다.

현재 상태: `자동화됨` — daemon이 사용하는 sender 경계에 1 MiB 초과 상태를 deterministic fault injection하여 느린 subscription만 제거하고 Control RPC 연결을 유지하며 `subscription_error` 후 client 상태가 정리되는지 검증한다.

## 6. Persistence and recovery

### SC-16 Atomic state recovery

session, task, inbox가 있는 상태에서 daemon을 정상 종료하고 재시작한다.

기대 결과: 최소 session resume checkpoint만 보존되고 실행 중 task와 pending inbox는 재시작 후 failed/interrupted 처리된다. 완료 task, 응답 본문, thought, event history는 디스크에 남지 않는다.

현재 상태: `자동화됨` — 재시작 시 pending inbox는 `interrupted`, 진행 중 task는 동일 handle의 `failed` 결과가 되고 최소 checkpoint만 남는지 검증한다.

### SC-17 Periodic lifecycle GC

1. idle resumable session, 완료 task/inbox, 오래된 결과, orphan active session을 만든다.
2. Main poll 없이 daemon maintenance 주기를 진행한다.
3. pinned session과 resume을 지원하지 않는 provider session을 함께 둔다.

기대 결과: idle resumable 연결은 unload되고, 결과·inbox·task·session은 각 retention 이후 삭제된다. socket이 살아 있어도 Main 활동이 없는 orphan active session은 grace 이후 취소된다. pinned session은 유지되며 non-resumable session은 최종 session retention까지 live 상태를 유지한다.

현재 상태: `자동화됨` — maintenance를 직접 실행해 각 시간 경계와 예외, Main detach 후 grace 내 reconnect의 lease 갱신을 검증한다. 실제 5분 wall-clock 대기는 deterministic test를 위해 사용하지 않는다.

### SC-18 Persistence failure

state 디렉터리를 쓰기 불가능하게 만들거나 디스크 쓰기 실패를 주입한다.

기대 결과: 오류가 로그와 health 상태에 드러나며 durable하다고 응답하지 않는다.

현재 상태: `자동화됨` — 저장 실패가 reject되고 Gateway health용 오류 상태에 남는지 검증한다.

## 7. Unlimited worker execution

### SC-19 Long-running turn

1. Worker가 CI 기준 시간보다 긴 작업을 시작한다.
2. 여러 번 poll timeout과 Main socket 재접속을 발생시킨다.
3. worker가 정상 완료할 때까지 기다린다.

기대 결과: poll/RPC timeout은 조회 요청만 끝내며 worker turn과 ACP process는 계속 실행된다. 최종 결과가 같은 task/session에 기록된다.

현재 상태: `수동` — 제품 코드에 turn deadline은 없지만 실제 provider 장시간 smoke test가 없다.

### SC-20 Explicit cancellation

장시간 작업을 Main이 MCP cancel로 종료한다.

기대 결과: ACP cancel이 전달되고 terminal child가 종료되며 task가 `cancelled` terminal state가 된다.

현재 상태: `자동화됨` — 장시간 terminal을 가진 task에 cancel을 보내 child terminal 정리, session `cancelled`, task `cancelled`를 검증한다.

## 8. Parameter control and concurrency hardening

### SC-21 Main-selected model and session parameters

1. Main이 `session_open`에 provider와 `model`을 함께 전달한다.
2. `agent_acp_config`로 Worker가 광고한 select·boolean 설정과 현재값을 조회한다.
3. 지원되는 `thought_level`, boolean 모델 설정과 `model`을 prompt 전에 변경한다.
4. 허용 목록 밖의 select 값, 잘못된 boolean 타입과 다른 Main의 변경 요청을 시도한다.
5. process model session에는 기존 session의 모델 변경을 요청한다.

기대 결과: Worker가 광고한 설정만 `session/set_config_option`으로 변경되고 `config_changed` event와 현재 model에 반영된다. 잘못된 ID·값·타입과 소유권 위반은 거절된다. process model provider는 모델별 ACP process를 사용하며 기존 session의 모델 변경은 새 session을 요구하는 오류가 된다.

현재 상태: `자동화됨` — mock ACP의 model·thought level·boolean config round-trip, 값 검증, 소유권, MCP tool 노출과 Grok process model 경계를 검증한다.

### SC-22 Concurrent startup and prompt admission

동일 provider의 초기화 중 두 session open, 동일 session의 두 `task_prompt`, 동일 socket/state를 사용하는 두 daemon 시작을 동시에 발생시킨다.

기대 결과: provider는 initialize 완료 후 공유되고, task는 하나만 active link를 소유하며, daemon은 정확히 하나만 socket과 state의 owner가 된다.

현재 상태: `자동화됨` — initialize gate, `activeTaskId`, daemon lock을 각각 검증한다.

### SC-23 Multiple pending requests and explicit cleanup

한 turn에서 두 permission 요청을 동시에 만들고 하나씩 답한다. 별도 turn은 permission 대기 중 cancel과 close를 수행한다.

기대 결과: 모든 요청이 해결될 때까지 task는 `input_required`이고 session은 waiting 상태다. cancel/close된 요청은 durable inbox에서 `interrupted`가 되며 영구 `pending` 항목이 남지 않는다.

현재 상태: `자동화됨`.

### SC-24 Session text byte boundary

ASCII와 emoji가 섞인 agent message/thought를 작은 `maxTextBytes`로 누적한다.

기대 결과: 실제 UTF-8 byte 수가 제한 이내이고 surrogate pair나 대체 문자가 생기지 않는다.

현재 상태: `자동화됨`.

### SC-25 Nested provider subagent round-trip

1. Main이 Control MCP로 Claude와 Grok parent session을 각각 연다.
2. 각 parent에게 built-in Agent/Task 도구로 child subagent 하나를 호출해 격리된 `task.txt`를 읽고 계산하도록 지시한다.
3. parent가 child 완료를 기다리고 결과를 읽은 뒤 Main에 최종 marker를 반환한다.
4. Main은 최종 텍스트뿐 아니라 ACP tool event에서 실제 nested-agent 호출과 완료가 관측됐는지 확인한다.

기대 결과: Claude에는 `Task` event와 child 작업 완료가, Grok에는 `spawn_subagent`와 `get_command_or_subagent_output` 완료가 나타난다. 두 parent 모두 child 결과 `CHILD_SUM_42`를 포함한 provider별 marker를 Main에 반환하고 session은 `idle`이 된다.

현재 상태: `실제 provider smoke 통과` — `npm run smoke:subagents`로 검증한다.

### SC-26 Official registry discovery and dynamic provider

1. installer가 ACP 공식 registry를 읽고 PATH, 일반 사용자 CLI 경로, 전역 npm package를 대조한다.
2. 발견된 npx/uvx agent는 registry에 고정된 package version을 설치하고 동적 provider 정의를 저장한다.
3. 발견된 각 agent의 사용자 skill 경로에 `agent-delegator`를 설치한다. 경로가 알려지지 않은 provider는 공용 Agent Skills 경로를 공유한다.
4. registry 접속 실패 시 24시간 cache로 fallback하고, offline mode에서는 network를 사용하지 않는다.
5. 저장된 동적 provider로 Gateway session을 열 수 있는지 확인한다.

기대 결과: registry에 없는 임의 실행 파일이나 binary wrapper가 아닌 유사 이름은 등록하지 않는다. HTTPS가 아닌 binary archive와 잘못된 manifest는 거부한다. `--dry-run`은 cache, provider 파일, package를 변경하지 않는다.

현재 상태: `자동화됨` — registry validation/discovery/cache fallback, explicit agent download, provider 정의 병합과 Gateway config 해석, 발견된 전체 agent의 skill 대상 계산과 공용 경로 중복 제거를 검증했다. 실제 공식 registry dry-run에서는 38개 항목 중 로컬 Auggie, Claude, Codex, Grok을 탐지하고 네 agent 모두의 skill 설치 경로를 생성했다.

### SC-27 Multi-agent MCP registration

1. Codex·Claude 외에 Grok과 Auggie가 설치된 환경을 구성한다.
2. installer가 각 CLI의 JSON 목록 형식으로 기존 MCP를 검사한다.
3. `--target all`로 Control과 Guide를 등록하고 installer 상태를 확인한다.
4. 관리되지 않은 같은 이름의 MCP가 있으면 `--force` 없이 교체하지 않는지 확인한다.

기대 결과: Grok은 `grok mcp add/list/remove`, Auggie는 `auggie mcp add/list/remove` 형식을 사용한다. Control token은 출력에서 가려지고 관리 상태에는 네 종류의 MCP가 각각 기록된다. 기본 target 미지정 설치에서는 하나의 Main만 Control을 가지며 나머지는 Guide만 가진다.

현재 상태: `자동화됨` — Grok·Auggie JSON 목록 검사, Control·Guide 등록 명령과 managed state 기록을 검증했다.

## 9. v1.5.2 강화: 경로·보호·작업공간·운영

각 시나리오는 mock 회귀 테스트(`test/hardening.test.js` 등)와 live matrix(`npm run usecases:live`) 양쪽에서 검증한다. live ID는 괄호에 적었다.

### SC-28 경로 기반 자동 승인 (P02)

1. `read_only`·`auto_approve`·`ask` 세션에서 `toolCall.locations`로 루트 안, 루트 밖, `..`, 내부 symlink, `link/..` 경로를 요청한다.

기대 결과: 루트 안 read는 승인된다. 루트 밖은 `read_only`에서 거절되고 `auto_approve`에서는 Main에게 넘어간다. `link/..`는 커널처럼 symlink를 먼저 따라간 뒤 판정한다.

현재 상태: `자동화됨` — mock 3건과 live P02. Codex는 known-limit다.

### SC-29 Gateway 보호 경로 (P03, P08)

1. 루트 안과 밖에 있는 보호 경로(`~/.acp-gateway`, state 디렉터리, socket)를 permission 요청, 셸 명령 문자열(`~`, `$HOME`, `${HOME}` 표기 포함), `terminal/create`, `fs/read_text_file`로 요청한다.

기대 결과: 모든 정책에서 거절되고 `ask`에서도 사람에게 묻지 않는다. `.acp-gateway-old`처럼 더 긴 이름과 단순한 이름 언급은 오탐하지 않는다.

현재 상태: `자동화됨` — mock 3건과 live P03·P08. Codex는 known-limit다.

### SC-30 Claude 세션 규칙 (P01, P04)

1. Claude `read_only` 세션에 파일 편집과 셸 명령을 요청한다.
2. daemon 재시작 뒤 restore된 세션에서도 같은 요청을 반복한다.

기대 결과: `_meta.claudeCode.options.disallowedTools`가 `session/new`와 매 `session/resume`에 전달되고, 편집과 셸 쓰기가 일어나지 않는다.

현재 상태: `자동화됨`.

### SC-31 자동 거절 옵션 선택

1. 같은 `reject_once` 종류로 "계속"(decline)과 "중단"(cancel) 옵션을 함께 제시한다.

기대 결과: 자동 거절은 decline을 고른다. cancel만 있으면 cancel을 고른다.

현재 상태: `자동화됨` — v1.5.2 Codex 리뷰 턴이 셸 거절 하나로 통째로 취소된 실사용 결함에서 나왔다.

### SC-32 Snapshot workspace (W01)

1. `workspace:"snapshot"`으로 연 세션에서 워커가 파일을 수정한다.
2. `workspace_diff`로 변경을 받는다.
3. daemon을 재시작한다.
4. 세션을 close한다.

기대 결과: 원본은 변하지 않고, diff는 트리 상대 경로의 적용 가능한 패치다. 재시작 뒤에도 사본이 유지되고 close 시 삭제된다. 보호 디렉터리는 스냅샷 대상이 될 수 없고 사본에서도 빠진다.

현재 상태: `자동화됨`.

### SC-33 idempotencyKey 충돌 (R03)

1. 같은 키로 같은 prompt, 대기 옵션만 바꾼 prompt, 다른 prompt를 보낸다.
2. daemon을 재시작한 뒤 다시 보낸다.

기대 결과: 앞의 둘은 같은 taskId로 attach되고, 다른 prompt는 `IDEMPOTENCY_CONFLICT`(details.taskId)로 거절된다. 재시작 뒤에도 같다.

현재 상태: `자동화됨`.

### SC-34 ACP 오류 코드 (E01)

1. 워커가 JSON-RPC 오류를 반환하게 한다.

기대 결과: `ACP_ERROR`로 전달된다. restore 대상 세션이 없음을 뜻하는 오류만 `UNKNOWN_SESSION`이며, cwd·모델·경로 오류는 `ACP_ERROR`로 남는다. 원본 오류는 details에 보존된다.

현재 상태: `자동화됨`.

### SC-35 Adapter 세대 교체와 health (S01)

1. 세션을 연 뒤 provider 정의(버전 pin)를 바꾸고 새 세션을 연다.

기대 결과: 새 세션은 새 프로세스를 쓰고, 기존 세션은 구 프로세스에서 계속 동작한다. 구 프로세스는 세션이 닫힌 뒤 GC가 정리한다. `started`, `runningVersion`, `retiredProcesses`가 실제 상태와 일치한다.

현재 상태: `자동화됨`.

### SC-36 격리 state의 provider 파일

1. 기본 위치 밖의 `ACP_GATEWAY_STATE`로 provider를 enable/disable한다.

기대 결과: 전역 파일은 변하지 않고 격리 사본이 생긴다. 파일이 없을 때는 전역 정의를 읽는다. `..`나 symlink로 표기한 전역 디렉터리는 격리로 보지 않는다.

현재 상태: `자동화됨`.

### SC-37 원자적 --update

1. 새 upstream commit이 있는 상태에서 update를 실행하되, 스테이징 검증 실패, 검증 중 live 트리 변경, fast-forward 후 `npm ci` 실패, 롤백 실패를 각각 주입한다.

기대 결과: 검증은 임시 worktree에서만 돌고, 실패하면 live 트리를 건드리지 않는다. 설치 실패는 이전 commit으로 롤백하며, 롤백 자체가 실패하면 그 사실을 보고한다.

현재 상태: `자동화됨`.

### SC-38 종료 호출과 daemon 자동 기동 (E02)

1. daemon이 없는 상태에서 `daemon_shutdown`·`shutdown_if_idle`을 호출한다. 동시에 autostart 호출도 보낸다.

기대 결과: 종료 호출은 `alreadyStopped`를 반환하고 daemon을 띄우지 않는다. 동시 autostart 호출은 종료 호출의 실패를 물려받지 않는다.

현재 상태: `자동화됨`.

### SC-39 Live matrix와 daemon kill -9 복구 (F01, F02)

1. 실제 Claude·Codex·Grok으로 22개 시나리오를 실행한다.
2. 도중에 daemon을 `kill -9`한다.

기대 결과: idle 세션은 모델과 맥락을 유지한 채 복구되고, 진행 중 task는 `failed: Gateway restarted…`로 표시된 뒤 세션을 재사용할 수 있다.

현재 상태: `수동` — 릴리스 전 `npm run usecases:live`.

## 권장 자동화 순서

1. SC-06~SC-10 terminal lifecycle과 격리
2. SC-04~SC-05 파일 쓰기와 symlink 경계
3. SC-12 elicitation inbox
4. SC-13~SC-15 socket 복구와 backpressure
5. SC-18 저장 실패 가시화
6. SC-19~SC-20 실제 provider 장시간 smoke test
7. SC-21~SC-24 model 및 concurrency 회귀 테스트
8. SC-25 실제 provider nested subagent round-trip
9. SC-26 공식 registry 자동 발견과 동적 provider
10. SC-27 Grok·Auggie MCP 등록과 Main 경계

## 기본 실행 명령

```bash
npm test
npm run smoke
```

`npm test`는 deterministic mock 기반 acceptance test로 유지한다. `npm run smoke`는 실제 Claude/Grok adapter 인증과 모델 상태가 준비된 환경에서만 실행한다.

## Latest baseline

- 2026-08-03 `npm test`: 87/87 통과. `agent_acp_config`의 지원 옵션 조회, select·boolean·model 변경, 잘못된 값과 타입 거부, Main 소유권, MCP tool 노출 및 `config_changed` event를 포함한다. 수동 source update의 pull·상류 확인·전체 CI 순서, 기존 프론트 도어 보존과 Claude MCP 이름·환경변수 인자 순서도 검증한다.
- 2026-07-30 `npm test`: 62/62 통과. Main model 선택, provider initialize/task/daemon 경쟁 조건, 복수 permission, cancel/close inbox, reconnect event 순서, subscription error/backpressure, reconnect lease, UTF-8 byte limit·분할 surrogate, 상태 디렉터리 재생성, symlink parent 경계와 installer identity 재사용·충돌 차단·dry-run·Main/Worker 대상 분리·skill 원자적 갱신·전체 발견 agent skill 배포·Grok/Auggie MCP 등록·health check, 공식 registry 검증·탐지·cache fallback·동적 provider 등록을 포함한다.
- 2026-07-30 `npm run smoke`: Main이 지정한 Grok `grok-4.5`, Claude `sonnet`이 session 응답에 반영됐고 각각 `GROK_MCP_ACP_OK`, `CLAUDE_MCP_ACP_OK`, `idle`로 완료했다.
- 2026-07-30 `npm run smoke:subagents`: Claude `sonnet`의 `Task` child와 Grok `grok-4.5`의 `spawn_subagent` child가 각각 `task.txt`를 처리했다. parent가 child 결과 `CHILD_SUM_42`를 회수해 Main에 provider별 marker를 반환했고 두 session 모두 `idle`로 완료했다.
- 2026-07-30 Claude coding scenario: 격리된 임시 디렉터리에 `sum.js`, `sum.test.js` 두 파일만 생성하고 `node --test sum.test.js` 3/3 통과. Codex가 파일 수·내용·테스트를 독립 검증한 뒤 임시 디렉터리를 삭제했다. ACP adapter는 실제 Claude model ID를 반환하지 않았다.
- 2026-07-30 Grok red-team: `grok-4.5`, read-only sandbox, terminal/write 차단 상태로 `idle/end_turn` 완료. 현재 SC-03, SC-05, SC-07, SC-08, SC-11, SC-13, SC-18, SC-20에 대응하는 8개 위험을 제기했고 Codex 코드 검토에서 모두 재현 가능한 경로로 확인했다. 관련 회귀 테스트를 추가했다.
- 2026-07-30 hardening 후 Claude regression: full-access session이 임시 `check.js`를 만들고 terminal에서 실행해 `FULL_ACCESS_OK`를 반환했다. Codex가 파일 수와 출력을 재검증한 뒤 임시 디렉터리를 삭제했다.
- 2026-07-30 provider 사용 후기: Claude Code ACP adapter는 source 검토와 `npm test`를 수행해 `end_turn`으로 완료했으나 model ID를 제공하지 않았고, 지정 범위를 벗어나 `/tmp` probe를 생성·삭제했으므로 실행 규율은 부적합으로 판정했다. 지적 중 capability별 grant, UTF-8 chunk decoder, terminal 종료, event turn ID, inbox ID 재사용 문제를 채택했다. Grok은 정확히 `grok-4.5`, read-only 정책으로 `end_turn` 완료했고 pending operation 취소, `allow_always` 호환, socket 재연결/backpressure 문제를 지적했다. 재현된 권한·취소·protocol 항목과 socket 자동 재연결을 수정했으며 실제 slow-buffer 통합 검증만 SC-15 잔여 과제로 유지한다.
- 2026-07-30 최적화 검증: streamed result/terminal 누적을 bounded UTF-8 chunk accumulator로 교체하고, 범위 없는 파일 읽기의 line split을 제거했으며, MCP/checkpoint JSON을 compact encoding으로 전환했다. `poll(includeResult: false)`로 누적 결과 재전송을 생략할 수 있다. 5,000×1 KiB 누적 벤치마크는 동일 실행에서 908.12 ms에서 4.56 ms로 감소했고, `npm run smoke`와 `npm run smoke:subagents`에서 Claude Sonnet/Grok 4.5 및 각 built-in child subagent 결과 회수까지 통과했다.
- 2026-07-30 installer 검증: adapter·Control·Guide·`agent-delegator` skill 설치 계획, `0600` identity 보존과 재사용, 명시적 token 회전, unmanaged MCP/skill 충돌 차단, dry-run 무변경, Codex Main 우선 및 Worker-safe Guide 분리, skill 원자적 갱신, 설치 후 daemon 인증 health check를 자동화했다. npm package dry-run 결과는 37,040 bytes이며 runtime source, skill과 README만 포함한다.
- 위 baseline은 provider 연결과 기본 prompt lifecycle을 증명한다. `미구현` 또는 `부분`으로 표시된 acceptance scenario의 통과를 의미하지는 않는다.
