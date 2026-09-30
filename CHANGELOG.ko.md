# 변경 이력

**한국어** | [English](CHANGELOG.md)

## v1.7.1 변경 사항

npm 설치 크기를 바로잡는 패치 릴리스입니다. npm에서 `acp-gateway-daemon@1.7.0`을 설치하면 모든 플랫폼용 Claude Code 바이너리를 2GB 넘게 내려받으며, `--omit=optional`로도 막을 수 없습니다. 1.7.1은 약 49MB만 설치합니다. 또한 Claude Worker가 PATH에 있는 Claude CLI도 찾습니다. API major **1**과 state schema **5**는 유지되며, 새 필드·설정·오류 코드는 없습니다.

- **npm 설치 크기(1.7.0 버그):** Claude adapter가 의존하는 Claude Agent SDK는 Claude Code CLI를 플랫폼마다 하나씩 optional native 패키지(`@anthropic-ai/claude-agent-sdk-<platform>`, 각 약 245MB)로 배포합니다. 1.7.0의 `npm-shrinkwrap.json`에는 이 여덟 개가 모두 들어 있었고, npm은 게시된 패키지의 shrinkwrap을 OS·CPU·`--omit=optional`과 상관없이 적힌 그대로 설치합니다. 그래서 1.7.0을 npm으로 설치하면 여덟 개를 모두 받았고, 1.7.0 README가 안내한 `npm install -g acp-gateway-daemon --omit=optional`도 효과가 없었습니다. Gateway는 이 바이너리를 실행하지 않습니다.
  - 수정: shrinkwrap에서 이 패키지들을 빼고, SDK 항목의 optional 의존성 목록에서도 지웠습니다. 이제 `npm install -g acp-gateway-daemon`은 옵션 없이 약 49MB를 설치합니다.
  - maintainer용: shrinkwrap을 다시 쓰는 작업(`npm install` 등) 뒤에는 `node scripts/omit-claude-binary.js`로 다시 빼야 합니다. `npm run monitor:sync-dependencies`는 이 작업을 직접 실행합니다.
- **runtime 릴리스 크기 축소:** GitHub runtime 릴리스도 의존성을 `--omit=optional`로 설치하므로 archive에 Claude Code 바이너리가 더는 들어가지 않습니다. 크기는 약 80MB에서 약 6.6MB로 줄었습니다. 패키지 이름(`acp-gateway`), `package-lock.json`, 공개 client는 그대로입니다.
- **Claude CLI 찾는 순서:** Claude Worker는 다음 순서로 찾은 Claude CLI를 실행합니다. `CLAUDE_CODE_EXECUTABLE`이 비어 있지 않으면 그 경로, 아니면 daemon의 PATH 중 절대 경로 디렉터리에서 처음 찾은 실행 가능한 `claude`(Gateway 자신의 의존성 안에 있는 것과 Claude Agent SDK에 딸린 바이너리는 제외), 그것도 없으면 `~/.local/bin/claude`입니다. provider 감지와 Worker는 같은 결과를 씁니다.
  - 1.7.1 이전의 기본 Claude provider는 `CLAUDE_CODE_EXECUTABLE`이 없으면 늘 `~/.local/bin/claude`를 썼기 때문에, 패키지 관리자로 설치한 CLI처럼 다른 곳에 있는 CLI는 쓰지 않았습니다.
  - `~/.local/bin/claude`가 있으면서 PATH에서 그보다 앞에 다른 `claude`가 있으면, 이제 Worker는 PATH 쪽을 실행합니다. `CLAUDE_CODE_EXECUTABLE`이 여전히 가장 우선하므로, 특정 CLI를 계속 쓰려면 이 값을 지정하세요.
  - 아무것도 찾지 못하면 Claude는 설치되지 않은 것으로 보고되며, Worker가 SDK에 딸린 바이너리로 대신 실행하는 일은 없습니다.
- **CI 검사:** `scripts/ci-check.js`(`npm run ci`에 포함)는 `npm-shrinkwrap.json`이 Claude 플랫폼 바이너리를 포함하거나 이름으로 가리키면 실패합니다. `npm run smoke:npm`은 설치된 패키지에 바이너리가 하나도 없는지, 그리고 그 안의 Claude adapter가 정상적으로 로드되면서 설치본 밖의 CLI를 가리키는지 확인합니다. `release:verify`는 바이너리가 든 runtime archive를 거부합니다.
- **호환성:** API, state, 설정, 응답 형태는 바뀌지 않았습니다. 동작이 바뀐 곳은 `CLAUDE_CODE_EXECUTABLE`이 없을 때 어느 Claude CLI를 실행하는지(위 항목) 하나뿐입니다.
- **업그레이드:** npm 설치본은 `npm install -g acp-gateway-daemon@latest`를 실행한 뒤 `acp-gateway-bootstrap --update`를 실행하세요. daemon 재시작까지 해 줍니다. npm의 `acp-gateway-daemon@1.7.0`은 deprecated 처리됐으니 설치하지 마세요. 소스 checkout은 `acp-gateway-bootstrap --update`로 업데이트하고, 앱이 관리하는 runtime은 그 앱이 업데이트합니다.

## v1.7.0 변경 사항

세션과 작업이 누구의 것인지, 왜 지금 상태에 있는지, 재시작이나 장애로 무엇을 모르게 되었는지를 Main이 Gateway 응답만 보고 알 수 있게 하는 릴리스입니다. v1.6.0에서는 Codex 프로세스 하나에 속한 여러 thread가 모두 한 Main으로 보였고, Worker는 daemon을 띄운 Main의 신원을 그대로 물려받았습니다. 작업이 중간에 끊기면 Worker가 이미 prompt를 받아 움직였는지도 Main이 알 수 없었습니다. API major **1**과 state schema **5**는 유지되며, 새 필드·action·설정·오류 코드는 모두 additive입니다. npm에 `acp-gateway-daemon`으로 게시하는 첫 릴리스이기도 합니다.

- **thread 단위 호출자 기록:** 호출을 프론트 도어 프로세스가 아니라 그 호출을 보낸 thread 단위로 기록합니다.
  - Codex: Control MCP 서버가 tool 호출마다 `_meta`(`threadId`, `x-codex-turn-metadata`)에서 thread id와 turn id를 읽습니다. 그래서 한 Codex 프로세스 안의 서로 다른 thread가 연 세션과 턴을 구분할 수 있습니다. 프로세스 단위 `caller`는 바꾸지 않습니다.
  - Worker 환경 변수: Worker, Worker 터미널, 자동으로 뜬 daemon의 환경에서 `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_THREAD_ID`, `GROK_SESSION_ID`를 지웁니다. 예전에는 어떤 Worker든 daemon을 띄운 Main인 것처럼 보고될 수 있었습니다.
  - 에이전트 이름: 부모 프로세스 이름을 단어 단위로 비교해 provider를 정합니다. 둘 이상의 provider에 해당하는 이름은 `null`로 기록합니다.
  - `viaSession`: 이 Main의 Worker가 Main처럼 호출했다면 `openedBy`·`promptedBy`에 그 Worker의 Gateway 세션 id가 `viaSession`으로 붙습니다.
  - `prompt`·`run`·`task_prompt`의 접수 응답이 `promptedBy`를 돌려줍니다. 연 Main이 기록되지 않은 세션은 세션 조회에서 `attribution: "none"`으로 나옵니다(poll에는 나오지 않음).
  - `setup`은 daemon이 뜬 뒤 호출자 정보 없이 들어온 세션 열기·복구·prompt·run 횟수를 `legacyControlRequests`로 보고하고, 0이 아니면 `front_door_without_caller` 경고를 띄웁니다.
- **어느 쪽이 낡았는지(`staleFrontDoor`):**
  - `reason`이 낡은 쪽을 알려 줍니다(`front_door_older` / `gateway_older`). 프론트 도어가 낡았다면 `action`은 전과 같이 재연결입니다. daemon이 낡았다면 재연결해도 같은 daemon에 다시 붙을 뿐이므로, `action`은 한가할 때 daemon을 재시작하라고 안내합니다(`acp-gateway-admin shutdown_if_idle`, 1.5.0보다 오래된 daemon이면 확인 절차를 거친 최후 수단 `kill`). 그러면 다음 `agent-acp` 호출이 프론트 도어 버전으로 daemon을 띄웁니다. 두 버전의 순서를 정할 수 없으면 `reason` 없이 재연결을 안내합니다.
  - installer: 관리 중인 `agent-acp` 항목의 스크립트가 사라졌거나, 그 항목이 더 오래된 Gateway를 가리키는 고정 경로라면 현재 설치본을 가리키도록 다시 등록합니다. symlink를 거치는 경로(다른 앱이 갱신하는 포인터)는 그대로 두고, 더 오래된 Gateway로 이어지면 경고만 남깁니다. 더 낮은 버전으로 되돌리는 일은 없습니다.
  - `--dry-run`은 MCP 항목마다 `would-update`·`would-install`·`would-replace`·`unknown` 중 하나를 보고하며, 읽기만 하고 아무것도 바꾸지 않습니다. Claude 항목은 설정 파일에서 직접 읽으므로 dry run이 프론트 도어를 띄우지 않습니다.
- **세션이 그 상태인 이유:**
  - 상태가 바뀔 때마다 `statusReason`(정해진 목록 중 하나)과 `statusChangedAt`을 기록하며, 둘 다 재시작 뒤에도 남습니다. 그래서 idle unload(`session_unloaded`)와 장애(`provider_disconnected`)를 재시작 뒤에도 구분할 수 있습니다.
  - `lastWorkerActivityAt`은 Worker가 직접 보낸 update에서만 갱신됩니다. poll, 설정 변경, 사용량·세션 정보로는 바뀌지 않습니다.
  - 실행 중인 턴이 `stallHintMs`(새 설정, 기본 300000ms) 동안 아무것도 보내지 않으면 조회 시점에 `stallSuspected`를 계산해 붙입니다. 힌트일 뿐 상태를 바꾸거나 작업을 취소하지 않습니다. `setup`은 호출한 Main의 세션에 대해서만 `sessions_stall_suspected` 경고를 띄웁니다.
  - idle unload는 영구 기록하지 않는 `session_unloaded` 이벤트를 남기고 `updatedAt`은 건드리지 않습니다. 보존 기간 계산에는 영향이 없습니다.
  - 새 필드는 세션 `get`/`list`와 `diagnostic` poll에 나오며, `diagnostic` poll에는 `silentForMs`도 추가됩니다.
- **중단으로 모르게 된 것:**
  - Gateway가 끊은 작업에는 `interruption: {reason, executionOutcome, at}`이 붙습니다. `reason`은 `gateway_restarted`·`provider_disconnected`·`orphan_cancelled` 중 하나입니다. prompt가 Worker에 닿지 않았음이 확실하면 `executionOutcome`은 `not_started`이고, 그렇지 않으면 `unknown`입니다. prompt를 보내기 직전에 영구 기록해 두는 표시로 판단합니다. 기존 상태값과 오류 문구는 그대로입니다.
  - 이런 작업의 최종 응답에는 `next`가 붙습니다: `session_check`, `workspace_diff`(결과를 알 수 없는 snapshot 세션), `decide_rerun`. Gateway가 알아서 다시 실행하지는 않습니다.
  - `agent_acp_session {action: "check"}`는 읽기 전용이며 provider를 띄우지 않습니다. `restorable`·`restorable_with_caveats`·`not_restorable`·`unknown` 중 하나를 복구 방법(`live`·`resume`·`load`)과 caveat 코드와 함께 알려 줍니다.
  - 세션은 `lastRestore: {at, method, outcome, errorCode}`와 `generation` 카운터를 기록하고, restore 이벤트에도 방법과 결과가 실립니다. resume이 실패해도 새 세션을 대신 여는 일은 여전히 없습니다.
  - Worker가 사라져 실패한 턴은 콜백이 어떤 순서로 오든 `disconnected` / `provider_disconnected`로 끝납니다.
- **attention inbox:**
  - 작업은 자신을 만든 `caller`를 기록합니다. 값이 있을 때만 작업 조회에 나옵니다.
  - 최종 결과가 작업을 만든 Main에게 전달되면 확인한 것으로 표시합니다. `run`, `task_result`/`tasks/result`, 그 턴의 결과를 돌려준 poll이 여기에 해당합니다. observer, `task_get`, `task_list`, inbox `list`는 표시하지 않으므로, 같은 root를 쓰는 다른 Main이 내 새 소식을 지워 버리는 일이 없습니다. 이 표시는 재시작 뒤에도 남습니다.
  - `agent_acp_inbox {action: "attention"}`(읽기 전용)는 `needsMain`(`ageMs`·`stale`이 붙은 대기 중 요청)과 `updates`(아직 확인하지 않은 종료 작업, 중단된 작업 포함, 결과 본문은 빼고)를 돌려줍니다. 오래된 것부터 정렬하고, cursor 하나로 페이지를 나누며, 전체 건수도 함께 줍니다. 요청은 `attentionStaleMs`(새 설정, 기본 600000ms)가 지나면 `stale`로 표시됩니다.
  - `ack {taskIds}`는 요청한 Main의 작업(또는 호출자가 기록되지 않은 작업)을 확인한 것으로 표시하고, 건너뛴 id는 이유와 함께 알려 줍니다.
  - `setup`은 `attention_stale_requests`·`attention_unseen_updates` 경고를 띄웁니다. `agent-delegator` skill은 재연결이나 재시작 뒤에 attention부터 확인하라고 안내합니다.
  - inbox `list`/`get` 응답은 바뀌지 않습니다. 작업 조회와 접수 응답에는 `caller`·`parentTaskId`·`inputTaskIds`·`promptedBy`가 값이 있을 때만 붙고, 전달되는 `run` 결과는 그대로입니다.
- **작업 연결 선언과 `scope: "mine"`:**
  - `agent_acp_run`, `task_prompt`, `task_run`은 `parentTaskId`(이 작업이 이어받는 작업)와 `inputTaskIds`(prompt에 결과를 활용한 작업 1~16개)를 받습니다. 모든 id는 호출한 root에서 보이는 작업이어야 하며, 아니면 `INVALID_ARGUMENT`와 `details.unknownTaskIds`로 거부하고 아무것도 시작하지 않습니다. Gateway는 선언된 연결만 기록하고 추측해서 잇지 않습니다. 선언했을 때만 작업 조회에 나오며, 재시작 뒤에도 남습니다.
  - 연결은 `idempotencyKey` 비교에 포함됩니다(순서는 따지지 않음). 연결이 없는 run의 digest는 예전과 똑같습니다. 일반 `prompt`와 `run` attach는 연결을 받지 않습니다.
  - `task_list`는 `parentTaskId`·`callerSessionId`·`callerInstanceId`·`scope: "mine"`으로 거를 수 있고, 세션 `list`도 `scope: "mine"`을 받습니다. 호출자 정보가 없는 요청(1.6 이전 프론트 도어, observer)은 빈 목록 대신 `INVALID_ARGUMENT`를 받습니다. 이 인자를 쓰지 않으면 목록은 예전과 같습니다.
- **복구가 거듭 실패한 세션 격리:**
  - `restoreFailures`는 세션의 자동·명시적 복구 실패를 세고, 성공하면 초기화됩니다. unload, close, 재시작 표시, cancel, 종료 중인 Gateway는 실패로 세지 않습니다.
  - `maxConsecutiveRestoreFailures`(새 설정, 기본 3)에 이르면 세션을 격리합니다. 이때 `prompt`·`task_prompt`·`run`·`config`는 provider를 띄우거나 건드리지 않고 새 오류 코드 `SESSION_QUARANTINED`로 곧바로 실패합니다. `details.next`에는 Main이 고를 수 있는 선택지가 담깁니다: `session_check`, 그대로 호출하면 되는 `session_restore`, `session_open`. cancel, close, get/list, poll, pin, `workspace_diff`, `check`는 계속 동작합니다.
  - `agent_acp_session_restore`는 이제 이 Main이 가진, live가 아닌 세션을 그 자리에서 복구합니다(예전에는 이미 등록된 세션이면 모두 거부). 복구에 성공하면 격리가 풀립니다. live 세션은 여전히 거부하되, 이제 provider를 부르기 전에 거부합니다.
  - `check`는 caveat `session_quarantined`를 보고합니다. `setup`은 provider 시작이 같은 횟수만큼 연달아 실패하면 `provider_degraded` 경고를 띄웁니다. 경고일 뿐 아무것도 막지 않습니다.
  - `restoreFailures`와 `quarantined`는 값이 있을 때만 나오며, 기본·compact poll에는 나오지 않습니다.
- **npm 배포:**
  - 패키지 이름: npm에서는 `acp-gateway`라는 이름이 이미 쓰이고 있어 `acp-gateway-daemon`으로 게시합니다. 명령 이름(`acp-gateway-bootstrap`, `acp-gateway-admin` 등)은 그대로이고, 공개 client는 `acp-gateway-daemon/client`로 import합니다. 패키지에는 README 네 개, 두 변경 이력, `docs/`, `LICENSE`가 들어 있습니다.
  - lockfile: `package-lock.json` 대신 `npm-shrinkwrap.json`을 씁니다. shrinkwrap은 패키지 안에 함께 들어가므로 `npm install -g acp-gateway-daemon`은 CI에서 검증한 의존성 트리를 그대로 설치합니다. 소스 checkout은 전처럼 `npm ci`로 설치합니다.
  - 설치 방식 감지: Gateway는 패키지가 놓인 위치로 설치 방식을 판단합니다. `source`(Git checkout), `npm`(`.git` 없이 `node_modules` 안), `runtime`(`~/.acp-gateway/runtime/versions/` 아래에 앱이 설치한 릴리스, 또는 runtime 빌드만 만드는 `runtime-manifest.json`이 있는 트리. `node_modules` 안에 있어도 이쪽이 우선), `unknown` 중 하나입니다. health의 `gatewayUpdate`에 `installMode`가 함께 나옵니다.
  - 설치 방식별 업데이트: 소스 checkout은 전과 같이 `acp-gateway-bootstrap --update`가 pull, 검증, 재실행까지 합니다. npm 설치본은 Git 대신 npm registry의 `latest`를 확인하고, 더 새 버전이 있으면 `gateway_source_update_available` 알림과 `--update`가 `npm install -g acp-gateway-daemon@latest`를 실행한 뒤 `acp-gateway-bootstrap --update`를 실행하라고 안내합니다. 앱이 관리하는 runtime은 `managed`로 보고하며, 업데이트는 그 앱이 맡습니다. npm·runtime 설치본에서 `--update`는 Git이나 npm을 실행하지 않고 registry, adapter, MCP 등록을 갱신한 뒤 daemon을 다시 시작합니다.
  - runtime 릴리스: 이름과 구성은 그대로입니다. GitHub runtime 릴리스의 패키지 이름은 여전히 `acp-gateway`이고 lockfile도 `package-lock.json`(shrinkwrap으로 만든 것)이며, `release:verify`가 둘 다 확인합니다. 이 릴리스를 마운트하는 앱은 계속 `acp-gateway/client`를 import합니다.
  - CI: 두 CI OS에서 `npm run smoke:npm`이 돕니다. 패키지를 pack하고, shrinkwrap을 따르는 loopback registry에서 tarball을 설치한 뒤(임시 HOME·cache·npmrc, `--ignore-scripts`), 설치된 명령과 daemon을 격리된 환경에서 실제로 실행해 봅니다.
  - 게시: 수동으로 실행하는 `Publish npm` workflow가 요청한 버전을 `package.json`·`GATEWAY_VERSION`과 대조하고, npm에 이미 있는 버전은 거부하며, `npm run ci`와 `npm run smoke:npm`을 통과한 뒤 provenance와 함께 게시합니다(secret `NPM_TOKEN`). 자세한 내용은 [운영 가이드](docs/operations.ko.md#npm-배포-maintainer용)를 참고하세요.
- **호환성:** 모든 변경은 additive입니다. 기본·compact poll 응답과 일반 작업·run의 결과 envelope는 바이트 단위까지 같습니다. `interruption`과 `next`는 Gateway가 끊은 작업에만 붙습니다. 세션 `list`/`get`은 위에서 설명한 조회용 필드가 늘어난 것 말고는 형태가 같고, `setup`에는 `legacyControlRequests`가 추가됩니다. 접수 응답의 `promptedBy`는 프론트 도어가 자신을 밝힐 때만 붙습니다. 세션 목록을 읽는 모니터 같은 소비자는 새 필드를 무시해도 됩니다.
- **업그레이드:** 새 버전이 실행되도록 한가할 때 daemon을 재시작하세요(`acp-gateway-admin shutdown_if_idle`, 그러면 다음 `agent-acp` 호출이 1.7.0을 띄웁니다). `acp-gateway-bootstrap --update`는 재시작까지 해 주며, 다시 실행하면 예전 설치본에 고정된 프론트 도어도 새 설치본을 가리키게 됩니다. 1.7.0부터 npm 설치본은 `npm install -g acp-gateway-daemon@latest --omit=optional`을 실행한 뒤 같은 `acp-gateway-bootstrap --update`로 업그레이드합니다. 그다음 호스트 세션을 다시 연결해야 새 인자가 보이고, 바뀐 `agent-delegator` 안내는 `acp-gateway-bootstrap --update-skill`로 받으세요.

## v1.6.0 변경 사항

어느 Main이 세션을 열고 턴을 시작했는지 Gateway가 직접 기록하는 릴리스입니다. 지금까지는 한 PC의 모든 Main이 같은 `rootId`를 써서 Gateway 응답만으로는 Main을 구분할 수 없었습니다. 그래서 모니터 같은 소비자가 각 Main의 transcript를 읽어 연결을 추측했습니다. API major **1**과 state schema **5**는 유지되며, 새 필드는 모두 additive입니다.

- **호출자 식별(`caller`):** Control MCP 서버는 자신을 띄운 에이전트 CLI를 호출자로 보고합니다. 요청마다 `caller: {provider, sessionId, pid, instanceId}`를 함께 보냅니다.
  - `provider`: 부모 프로세스 이름으로 정합니다(`claude` / `codex` / `grok`).
  - `sessionId`: CLI가 내보낸 세션 id입니다(`CLAUDE_CODE_SESSION_ID`, `GROK_SESSION_ID`, `CODEX_THREAD_ID`). Codex는 MCP 서버에 thread id를 넘기지 않으므로 `null`입니다.
  - `pid`: 부모 CLI의 pid입니다.
  - `instanceId`: Control MCP 서버 프로세스마다 새로 만드는 값입니다. Codex처럼 세션 id가 없을 때도 같은 thread가 한 요청끼리 묶입니다.
- **`openedBy`:** 세션을 연(또는 처음 복구한) Main입니다. 한 번 정해지면 바뀌지 않습니다. `session_open`·`session_restore` 응답, `session list`, 재시작 후 상태에 남습니다.
- **`promptedBy`:** 턴을 시작한 Main입니다. `turn_start` 이벤트와 세션의 최신 값에 들어갑니다. 그 턴의 응답을 받을 쪽입니다. `prompt`·`run`·`task_prompt` 모두 기록합니다.
- **호환성:** 1.6.0 이전 Control 서버는 `caller`를 보내지 않으므로 세 필드가 모두 없습니다. 기존 응답 형태는 그대로입니다. observer 연결이 보낸 `caller`는 기록하지 않습니다. 형식이 잘못된 `caller`는 호출을 막지 않고 기록만 하지 않습니다.
- **개인정보:** 기록하는 값은 provider, 세션 id, pid, 무작위 instance id뿐입니다. 명령줄과 환경 변수는 저장하지 않습니다.

## v1.5.2 변경 사항

v1.5.1 이후 Codex·Grok 자문과 실사용 matrix에서 나온 결함을 한 번에 정리한 강화 릴리스입니다. API major **1**과 state schema **5**는 유지되며, 새 필드와 오류 코드는 모두 additive입니다.

**보안·권한**
- **경로 기반 자동 승인:** 자동 승인이 `toolCall.locations`와 `rawInput`의 경로를 세션 루트와 비교합니다(symlink 해석 포함). 루트 밖 요청은 `read_only`에서 거절되고, `auto_approve`에서는 Main에게 넘어갑니다.
- **Gateway 보호 경로:** `~/.acp-gateway`, state·settings 디렉터리, control socket은 정책과 무관하게 거절됩니다. 워커가 `install.json`의 Control token을 읽을 수 없습니다. `ask` 세션에서도 사람에게 묻지 않고 바로 거절합니다.
  - 셸 명령 문자열도 검사합니다. `~`·`$HOME`·따옴표 표기와 `link/..` 같은 symlink 경유 경로가 대상이며, `terminal/create` 인자도 포함됩니다.
- **Grok 샌드박스:** Grok은 Gateway가 만든 프로필(`.grok/sandbox.toml`, `ACP_GATEWAY_GROK_SANDBOX_DIR`)로 프로세스 전체에 OS 샌드박스(Seatbelt/Landlock)를 적용해 보호 경로를 거부합니다. 내장 `grep`처럼 ACP를 거치지 않는 도구도 토큰 파일을 읽을 수 없습니다.
- **Claude 세션 규칙:** Claude 세션에는 `_meta.claudeCode.options.disallowedTools`를 전달합니다. `read_only`는 Bash·Edit·Write를 막고, 모든 정책에서 보호 경로 읽기를 막습니다. v1.5.1까지 Claude가 권한 요청 없이 실행하던 셸 명령과 루트 밖 읽기가 이제 차단됩니다.
- **거절 옵션 선택:** 자동 거절이 "계속 진행" 성격의 옵션(Codex의 `decline`)을 "턴 중단" 옵션(`cancel`)보다 우선 고릅니다. 예전에는 셸 명령 하나가 거절되면 Codex 턴 전체가 끝났습니다.

**작업 안전성**
- **`workspace: "snapshot"`:** `session_open`에 지정하면 워커가 cwd의 사본에서 일하고 원본은 건드리지 않습니다. 변경은 `agent_acp_session {action: "workspace_diff"}`로 패치를 받아 Main이 직접 적용합니다. Codex처럼 루트 안 편집을 막을 수 없는 provider에 편집이 절대 일어나면 안 되는 작업을 맡길 때 씁니다.
  - **비교 기준:** 스냅샷 시점의 baseline과 비교하므로, 그 뒤에 원본에서 한 사용자 수정이 역패치로 섞이지 않습니다.
  - **symlink:** 트리 안을 가리키는 링크는 사본 안으로 다시 연결되고, 밖을 가리키는 링크는 복사하지 않습니다(`droppedLinks`).
  - **제외 대상:** 보호 디렉터리는 복사하지 않습니다.
  - **diff 크기:** 64MB로 제한됩니다.
  - **위치·수명:** 사본은 close 시 삭제되며 `ACP_GATEWAY_WORKSPACES`(기본 `~/.cache/acp-gateway/workspaces`)에 생성됩니다. APFS·reflink를 지원하는 파일시스템에서는 clone으로 복사합니다.
- **idempotencyKey 충돌:** 같은 키로 다른 prompt·model을 보내면 `IDEMPOTENCY_CONFLICT`(details에 기존 `taskId`)를 반환합니다. 예전에는 이전 결과를 조용히 돌려줬습니다. 대기·결과 예산 옵션만 바꾼 재시도는 그대로 attach됩니다. digest는 WAL에 저장되어 재시작 뒤에도 유지됩니다.

**신뢰성·운영**
- **ACP 오류 코드:** 워커의 JSON-RPC 오류는 `ACP_ERROR`로 전달되며, restore 대상이 없으면 `UNKNOWN_SESSION`입니다. `details.acpCode`·`acpMessage`에 원본 오류가 담깁니다.
- **adapter 세대 관리:** adapter 정의(버전 pin)가 바뀌면 기존 프로세스는 보유 세션만 마저 처리하고, 새 세션은 새 프로세스로 엽니다. 할 일이 없어진 구 프로세스는 GC가 정리합니다. `setup`의 `started`는 실제 생존 여부를 보여 주고(예전엔 항상 false), provider 상세에 `runningVersion`과 `retiredProcesses`가 추가되었습니다.
- **격리 state의 provider 파일:** `ACP_GATEWAY_STATE`를 기본 위치 밖으로 지정하면 `providers.json`과 registry cache도 그 디렉터리를 씁니다. 파일이 없을 때는 전역 정의를 읽고, 첫 쓰기 때 전역 내용을 복사합니다. 격리 daemon의 자동 업데이트가 더 이상 전역 파일을 바꾸지 않습니다.
- **원자적 `--update`:** 새 upstream commit을 임시 `git worktree`에서 `npm ci`와 `npm run ci`로 먼저 검증한 뒤에만 live checkout을 fast-forward합니다.
  - **직렬화:** 동시 update는 lock으로 막습니다.
  - **HEAD 재확인:** merge 직전에 HEAD와 clean 상태를 다시 확인합니다.
  - **롤백:** 이후 의존성 설치가 실패하면 이전 commit으로 되돌립니다. 되돌리기는 HEAD가 이번 update의 결과이고 트리가 깨끗할 때만 수행하며, 롤백 실패는 실패로 보고합니다.
- **종료 호출은 daemon을 띄우지 않음:** `daemon_shutdown`·`shutdown_if_idle`은 daemon이 없으면 새로 띄우지 않고 `{ok:true, alreadyStopped:true}`를 반환합니다.

**테스트**
- **mock 회귀 테스트:** `test/hardening.test.js`에 기능별 회귀 테스트 23개를 추가했고, `test/source-update.test.js`는 staging·lock·CAS·롤백 11개로 다시 작성했습니다(전체 397개).
- **live 시나리오:** `npm run usecases:live`는 격리 daemon과 실제 Claude·Codex·Grok으로 22개 시나리오(setup, 세션, run, 권한 8종, snapshot, 오류, `kill -9` 복구)를 돌려 provider별 pass / known-limit / fail 표를 만듭니다. 구독 할당량을 쓰므로 릴리스 전 수동 게이트로 실행합니다. 결과는 [Live use cases](docs/live-usecases.md)에 누적합니다.

**알려진 한계:** 세션의 `permission_policy_partial` 경고의 `scope`가 막을 수 없는 항목을 정확히 나열합니다. live matrix는 이 범위 안의 누출만 known-limit으로 인정합니다.
- **Codex** (`edit_inside_roots`, `shell_write_inside_roots`, `read_outside_roots`, `read_protected`): codex-acp는 자기 도구로 파일을 다루며 진짜 읽기 전용 sandbox가 없습니다. 편집을 막으려면 `workspace: "snapshot"`을 쓰고, Control token이 있는 머신에서는 Codex에 신뢰할 수 없는 입력을 맡기지 마세요.
- **Grok** (`read_outside_roots`): 내장 `grep`이 루트 밖 일반 파일을 읽을 수 있습니다. 보호 경로는 샌드박스가 거부합니다.
- **Claude:** 경고가 없습니다. live matrix의 모든 권한 시나리오를 통과합니다.
- **`auto_approve`:** 루트 안에서 신뢰한다는 정책입니다. 경로를 확인할 수 없는 셸 명령은 자동 승인되며, 보호 경로를 가리키는 명령만 거절됩니다.

## v1.5.1 변경 사항

실제 Claude·Codex·Grok Worker로 오케스트레이션 사용 사례를 돌려 보며 찾은 결함을 고친 패치 릴리스입니다. 사용 사례와 재현 절차는 [Live use cases](docs/live-usecases.md)에 기록했습니다. API major **1**과 state schema **5**는 바뀌지 않습니다.

- **재시작 뒤 Claude·Codex 세션 복구 실패 수정:** daemon 재시작, provider 종료, idle unload(기본 30분) 뒤에 Claude·Codex 세션을 다시 쓰면 `required model=…, actual=<missing>`가 나고 세션이 `unavailable`로 바뀌던 문제를 고쳤습니다. 원인은 세션마다 모델을 고르는 registry provider도 프로세스 시작 시점에 모델을 검사한 것이었습니다. 이 검사는 provider 프로세스가 이미 떠 있으면 건너뛰어졌기 때문에 실행 순서에 따라 성공과 실패가 갈렸습니다. 이제 세션 단위 provider의 모델은 세션을 연 뒤 `configOptions`로만 확인합니다. 콜드 상태의 `session_open`에서 `model`을 명시해도 거부되지 않습니다.
- **Codex 권한 정책 완화와 명시:** Codex adapter는 자기 도구로 파일을 고치며, 기본 `agent` preset은 승인을 자체 `auto_review`로 처리합니다. 그래서 `read_only`·`ask` 세션에서도 permission 요청 없이 편집이 일어났습니다. 이제 Gateway는 `read_only`·`ask` 세션을 열 때와 복구할 때마다 Worker가 광고한 `mode` 옵션 중 `read-only`를 선택합니다. 이 설정으로 세션 루트 밖 쓰기, 네트워크, 권한 상승이 차단되거나 Gateway로 올라옵니다. codex-acp에는 진짜 읽기 전용 sandbox preset이 없어서 루트 **안** 편집은 막을 수 없습니다. 이런 세션에는 `session_open`의 `relevantAlerts` 맨 앞에 `permission_policy_partial` 경고를 붙입니다. 편집이 절대 일어나면 안 되는 작업은 버려도 되는 작업 사본을 `cwd`로 지정하세요.
- **skill 문서 정정:** prompt 수준 `model`과 `agent_acp_config` 모델 변경은 한 턴이 아니라 이후 모든 턴에 적용됩니다. 위 버그를 피하려고 넣었던 "기본 모델을 다시 명시하면 거부될 수 있다"는 안내도 삭제했습니다. 설치된 skill은 `acp-gateway-bootstrap --update-skill`로 갱신하세요.

## v1.5.0 변경 사항

**Gateway가 엔진과 실행 정책을 소유하고, AgenLynk 등 앱과 CLI는 공개 API를 소비합니다.** 소비자가 설정 파일을 직접 쓰거나 provider 실행 차단·보존·안전 종료 정책을 별도로 구현하지 않아도 되도록 관리 계약을 추가했습니다.

- **Observer 역할:** `GatewayRpcClient({access: "observer"})`는 서버가 읽기 전용 method를 집행합니다. 모니터 연결은 Main의 owner presence를 유지하지 않으며, 설정 조회 때문에 Worker를 복구하지 않습니다. 동일 Control token의 역할 제한이며 독립적인 observer credential을 제공하는 것은 아닙니다.
- **Provider 정책:** `provider`의 `list`, `set_enabled`, `install`을 제공합니다. Off는 Gateway가 새 세션·새 restore 등록 단계에서 거부합니다(`PROVIDER_DISABLED`). 이미 등록된 세션은 계속 수행·복구할 수 있습니다. 설치는 기존 Gateway installer를 사용하고 기본적으로 dry-run입니다.
- **엔진 설정:** `gateway_config`로 지원 옵션·활성값·저장값·revision·재시작 필요 여부를 조회하고 갱신합니다. `expectedRevision`이 낡았으면 `CONFIG_CONFLICT`로 거부합니다. `~/.acp-gateway/settings.json`이 엔진 설정의 기준이며, 해당 파일이 없으면 기존 `install.json`의 지원 설정을 읽고 최초 변경 시 migration합니다. 환경변수는 가장 우선합니다.
- **안전 종료:** `shutdown_if_idle`과 기본 `daemon_shutdown`은 작업·Inbox·세션 생성/복구·관리 요청·background update가 남으면 `SHUTDOWN_BLOCKED`와 blockers를 반환합니다. 통과하면 새 mutation을 막고 종료합니다. 강제 종료는 명시적인 `daemon_shutdown {force:true}` 또는 OS signal입니다.
- **정직한 replay:** live-only message/thought 유실 및 daemon 재시작 뒤 이력 단절을 subscription의 `cursorTruncated`와 새 `replay` 메타데이터로 알립니다. 실시간 연결 회복이 과거 메시지 복구를 뜻하지 않습니다. 완료 Task 결과는 `task_result`로 별도로 회수합니다.
- **보존 미리보기:** `retention_preview`는 실제 GC와 공유하는 판정으로 세션·Task·Inbox·결과의 정리 예상 건수를 반환합니다. 진행 중 Task는 보존 기간만으로 지우지 않습니다. preview는 조회 시점의 advisory이며, 참조 보호가 적용되는 artifact의 정확한 삭제 건수를 추정하지 않습니다.
- **오류 경로:** 취소된 `run` 대기의 waiter를 즉시 회수하고, 잘못된 cursor의 subscribe를 등록 전에 거부합니다. root당 구독 수는 64개로 제한합니다. 세션 생성 예산은 Worker 호출 전 예약합니다.
- **실행본 식별:** full setup에 `gatewayBuildId`(실행 시점 src 파일 SHA-256), `runtimeRoot`, `instanceId`, `sourceCommit`(release manifest가 있는 경우), 적용 `configRevision`, 관리 `capabilities`를 제공합니다.
- **의존성:** fast-uri, ip-address, hono, qs의 보안 수정 버전을 lockfile에 반영했습니다.

기존 API major **1**, state schema **5**, public client 4개 export는 유지합니다. State v4 병행 기록도 1.5.x에서 계속 유지해 명시적 rollback을 지원합니다. `daemon_shutdown` 기본 거부 조건과 subscription truncation 의미의 보강은 소비자가 확인해야 하는 동작 변경입니다. 기존 AgenLynk는 새 관리 API를 호출하고 capability를 소비하도록 별도 업데이트해야 합니다. 엔진 업그레이드만으로 앱의 자체 설정 쓰기·501 endpoint가 바뀌지는 않습니다.

`artifactSessionLimit`, `workerThoughtStream`, `workerSubagentTranscript`는 1.5.0 엔진 지원 설정이 아닙니다. Legacy 값은 `unsupportedLegacySettings`로 보고하며 적용된 것처럼 표시하지 않습니다. Monitor/Pet/화면 설정은 소비자 책임입니다.

### 공개 관리 API와 CLI

정확한 요청·응답, 소유권과 migration 절차는 [관리 API 계약](docs/management-api.md)을 참고하세요. 관리 CLI도 같은 `acp-gateway/client` RPC를 사용하며 이미 실행 중인 daemon에 연결합니다.

```bash
acp-gateway-admin setup
acp-gateway-admin gateway_config
acp-gateway-admin gateway_config '{"action":"set","expectedRevision":0,"values":{"idleUnloadMs":1800000}}'
acp-gateway-admin provider '{"action":"set_enabled","provider":"claude","enabled":false}'
acp-gateway-admin provider '{"action":"install","registryId":"claude-acp","dryRun":true}'
acp-gateway-admin retention_preview '{"values":{"sessionRetentionMs":86400000}}'
acp-gateway-admin shutdown_if_idle
```

`expectedRevision`은 예시의 0을 복사하지 말고 직전 조회값을 사용하세요. 설정은 안전 종료 후 새 daemon 시작에 적용됩니다. 재시작·runtime 교체를 수행하는 소비자는 자동 재연결 client를 먼저 닫고, 선택한 runtime으로 새 daemon을 시작한 뒤 setup의 실행본 식별과 적용값을 확인해야 합니다.

### 1.5.x·1.6.0·1.7.0·1.7.1 runtime 빌드

1.5.x(`v1.5.0`~`v1.5.2`), `v1.6.0`, `v1.7.0`, `v1.7.1` builder는 tag와 별도로 검토한 전체 source SHA를 요구합니다. tag가 해당 SHA와 다르면 빌드와 검증을 거부하며, 새 runtime의 엔진과 public client는 모두 같은 source commit에서 추출합니다. 기존 1.4.0 태그의 고정 SHA 검증은 유지합니다.

```bash
npm run release:runtime -- --source-tag v1.7.1 --source-commit FULL_REVIEWED_SOURCE_SHA --output-dir dist
npm run release:verify -- --source-commit FULL_REVIEWED_SOURCE_SHA \
  --archive dist/acp-gateway-runtime-darwin-arm64.tar.gz \
  --sha256 dist/acp-gateway-runtime-darwin-arm64.tar.gz.sha256 \
  --build-record dist/acp-gateway-runtime-darwin-arm64.tar.gz.build-record.json
```

위 명령은 로컬 산출물을 생성·검증합니다. GitHub Release 업로드와 attestation은 별도의 `Release runtime` workflow로 수행하며 기존 asset은 덮어쓰지 않습니다. 소비자는 게시된 새 asset의 checksum과 source SHA로 자신의 lock을 갱신해야 합니다.

## v1.4.0 변경 사항

**Durable · Bounded · Quiet** — 재시작 후에도 정확하고, 주요 자원이 명시된 상한 안에 머물며, Main을 불필요하게 깨우지 않는 안정화 릴리스입니다.

### 버전 정보

| 항목 | 버전·요구사항 | 의미 |
|---|---|---|
| ACP Gateway | `1.4.0` | daemon, Control MCP와 installer의 릴리스 버전 |
| Gateway Control API | `1` | 공개 control method와 응답 계약. additive 변경에는 올리지 않음 |
| State schema | `5` | `state.snapshot.json` + checksummed `state.wal.ndjson` |
| Legacy state schema | `4` | rollback을 위해 병행 기록하며 1.5.x에서도 rollback 호환을 위해 유지 |
| Runtime | Node.js `>=22` | macOS와 Linux 지원 |
| 호환 기준 | `1.3.2` | 인자 없는 핵심 호출의 응답 형태와 기존 method 유지 |

`package.json`, daemon과 Control MCP가 모두 `1.4.0`을 보고해야 정상입니다. `agent_acp_setup`에서는 `gatewayVersion`, `gatewayApiVersion`, `stateSchemaVersion`으로 각각 확인할 수 있습니다. MCP 호스트가 이전 tool schema를 캐시한 경우에는 `staleFrontDoor`가 표시되므로 [호스트 재연결 절차](docs/operations.ko.md#호스트-재연결-절차)를 수행하세요.

### 1.4.0 불변 runtime release 기록

1.4.0 downstream 앱은 이동하는 branch나 `src/` private subpath 대신 `v1.4.0` Release의 `acp-gateway-runtime-darwin-arm64.tar.gz`와 `acp-gateway/client`만 소비합니다. 공개 client 계약은 `GatewayRpcClient`, `GatewayError`, `ERROR_CODES`, `GATEWAY_API_VERSION` 네 항목이며 다른 package subpath는 `exports` 경계에서 차단됩니다.

릴리스 빌더는 고정된 `v1.4.0` 소스 커밋 `a1fdb353777337ca6ec481f8563d77efaea55e95`에 public client와 production dependency를 결합하고, allowlist와 파일별 digest를 담은 `runtime-manifest.json`을 생성합니다. 로컬 산출물 옆에는 SHA-256과 서명되지 않은 build record(`*.build-record.json`)가 생성됩니다. 이 파일은 attestation이 아니며, GitHub Actions 밖에서는 `origin: local`로 표시됩니다. 공식 서명은 GitHub Actions의 `actions/attest-build-provenance`이며, workflow는 게시 전에 `gh attestation verify`로 아카이브를 검증합니다. 이미 올라간 세 asset은 덮어쓰지 않습니다.

```bash
npm run release:runtime -- --source-tag v1.4.0 --output-dir dist
npm run release:verify -- \
  --archive dist/acp-gateway-runtime-darwin-arm64.tar.gz \
  --sha256 dist/acp-gateway-runtime-darwin-arm64.tar.gz.sha256 \
  --build-record dist/acp-gateway-runtime-darwin-arm64.tar.gz.build-record.json
```

builder checkout은 clean 상태여야 합니다. `v1.4.0` 태그가 pinned commit에서 이동하면 builder와 verifier가 모두 거부합니다. manifest에는 source tag/commit과 builder commit이 모두 기록되고 tar entry 순서·정규화된 mode·mtime·소유권과 gzip OS header가 고정되므로 동일한 두 commit에서는 동일한 bytes가 생성됩니다.

### 릴리스 변경 이력

1. **오류 계약과 characterization 기반 확립** — 안정적인 Gateway error code와 `{code,message,details}` wire envelope를 추가하고, 1.3.2의 prompt·poll·Task·Inbox 기본 동작을 characterization test로 고정했습니다.
2. **SessionActor-lite 도입** — 세션별 mailbox와 명시적 FSM guard로 prompt·cancel·close·restore·provider-exit을 직렬화했습니다. 늦은 callback과 중복 terminal 처리도 idempotent하게 만들었습니다.
3. **TaskStore v2 전환** — Task TTL을 `createdAt` 기준으로 통일하고, terminal-first-wins, blocking result waiter, 취소 의미론, root 격리, waiter·Task 상한과 keyset pagination을 구현했습니다.
4. **State schema v5와 crash-safe 복구** — snapshot과 checksummed WAL, fsync barrier, replay idempotency, state-directory lock, v4 migration·downgrade 감지를 추가했습니다. 손상된 내부 WAL이나 snapshot에서는 빈 상태로 시작하지 않고 안전하게 중단합니다.
5. **Bounded transport와 자원 예산** — 모든 NDJSON 전송 구간에 frame·queue·lane·write-timeout 상한을 적용하고, prompt·파일 읽기·terminal 출력·session·Inbox·artifact에도 명시적인 예산을 추가했습니다. 대용량 파일은 전체 `readFile` 대신 bounded streaming read로 처리합니다.
6. **Control/telemetry 분리** — permission·질문·Task 상태 같은 control event를 telemetry flood에서 보호합니다. raw message/thought chunk는 live subscription으로만 전달하고, usage는 ring 저장이나 poll wake-up 없이 turn/session 누계로 집계합니다.
7. **Compact API와 실행 경로 단순화** — `agent_acp_run`, `current|compact|diagnostic` 응답 프로파일, setup summary, 결과 byte budget, Inbox 필터·페이징과 idempotency key를 추가했습니다.

마무리 안정화에서는 close flush timer의 참조가 사라져 shutdown이 멈출 수 있던 문제, transport 종료가 worker-death로 정규화되지 않던 문제, aggregate transport·Inbox budget 우회, 구조적 오류 누락과 compact run의 복구 중 중복 실행 가능성을 수정했습니다. CI에는 session race, resource budget, transport backpressure, Task conformance, state corruption과 18개 crash cut-point 검증이 포함됩니다.

### 주요 API 추가

- **`agent_acp_run` 신설** — prompt를 보내고 결과까지 기다리는 단일 도구입니다. 직접 반환값과 MCP Task 결과가 **같은 객체**라서 처리할 shape가 하나뿐입니다. 대기 시간이 끝나면 오류가 아니라 `{status:"working", taskId}`를 돌려주므로, 실패 시에는 prompt를 다시 보내지 말고 `{taskId}`로만 재시도하면 됩니다(중복 실행이 구조적으로 불가능). permission이 필요하면 `{status:"input_required", pending}`으로 제어권을 즉시 돌려줍니다. `idempotencyKey`로 재시도 안전성을 한 겹 더 확보할 수 있습니다.
- **응답 프로파일** — `agent_acp_poll`에 `responseProfile: "compact"`를 주면 세션 봉투를 제거하고 `events`·최종 `result`만 남겨 **약 3분의 1 크기**로 줄어듭니다(빈 poll 483 → 152 bytes, permission poll 814 → 483 bytes). `"diagnostic"`은 큐 깊이·대기 요청 수 등 진단 정보를 더합니다. 인자를 생략하면 기존 응답 그대로입니다.
- **`setup mode:"summary"`** — 버전·프로파일·persistence·alert·provider 목록만 담은 요약(363 bytes, 전체의 약 19%)입니다. 세션마다 필요한 값은 `agent_acp_session_open` 응답이 직접 실어 보내므로(`responseProfiles`, `limits`, `relevantAlerts`) 위임할 때마다 setup을 다시 부를 필요가 없습니다.
- **결과 예산** — `resultBudgetBytes`(0–65,536)·`resultDelivery`로 돌려받을 결과 크기를 호출마다 제한할 수 있습니다. 초과분은 잘린 본문과 함께 전체 답변 기준 `totalBytes`·`omittedBytes`·완전한 `textArtifact` 포인터로 전달되며, 같은 답변에 대한 spill은 한 번만 일어납니다.
- **Inbox 필터·페이징** — `sessionId`, `type`, `limit`, `cursor`, `detail:"summary"`를 지원합니다. 인자 없는 호출은 기존과 완전히 동일한 전체 목록입니다.
- **내구성·경계·정숙성(PR 1~6)** — state v5 snapshot + WAL과 crash-safe 복구, MCP Task 의미론(TTL은 생성 시점 기준), 세션별 mailbox와 명시적 상태 전이, 모든 전송 구간의 프레임·큐·타임아웃 예산, control/telemetry 레인 분리와 usage 집계가 포함됩니다.
- **호스트 재연결 감지** — 프론트 도어와 daemon 버전이 어긋나면 `staleFrontDoor`로 알립니다. [호스트 재연결 절차](docs/operations.ko.md#호스트-재연결-절차)를 따르세요.

### 호환성 참고

- 인자 없는 `task_list`와 Inbox list, 기본 `current` poll 응답 형태는 1.3.2 공개 계약을 유지합니다. compact·diagnostic profile, pagination과 summary는 opt-in입니다.
- raw message/thought chunk는 보존형 poll history가 아니라 live subscription 전용입니다. 재연결 후 과거 chunk replay가 필요한 consumer는 자체 저장 계층이 필요합니다.
- 큰 Inbox payload는 메모리에 전문을 중복 보관하지 않고 preview와 artifact pointer를 반환합니다.
- 새 resource budget을 넘는 요청은 무제한으로 수용하는 대신 안정적인 error code로 거부됩니다. 기존에 상한을 초과하던 workload는 setup의 `limits`를 확인해 설정을 조정해야 합니다.
- State v5를 사용한 뒤 1.3.2로 rollback하면 병행 기록된 legacy v4 상태를 읽습니다. downgrade 감지 alert를 확인한 뒤 다시 1.4.0으로 복귀하세요.

## v1.3.2 변경 사항

- **최종 결과 중심 poll** — poll은 raw message/thought chunk를 보관하거나 전달하지 않고, 종료 시 최종 `result`와 Main이 처리해야 하는 permission·질문을 중심으로 응답합니다. raw chunk는 명시적으로 구독한 live observer에만 전달되며, 저장된 중간 증거는 `eventTypes`, `includeToolEvents`, `includeInspection`, 결과 thought는 `includeThoughts`로 요청합니다.
- **usage 이벤트 집계** — 반복되는 ACP `usage_update` 원문은 event ring에 저장하거나 poll을 깨우지 않고 turn/session 누계로 합산합니다. poll의 `includeUsage`, session 상세 조회, 명시적으로 요청한 Task 결과에서만 작은 summary를 노출합니다.
- **간결한 Worker 반환 기본** — `agent-delegator`가 상세 보고서가 필요하지 않은 요청에 결론·필수 근거·변경 경로·테스트 상태만 간결히 반환하도록 지시합니다.

## v1.3.1 변경 사항

- **ACP/MCP 실행 가이드 완성** — `agent-delegator`가 routing 결과를 실제 Control MCP 호출로 옮기는 전 과정을 설명합니다. provider·정확한 모델 검증, session 경계와 `mcpServers`, 직접 prompt와 MCP Task, cursor polling, permission·structured input, 복구·정리, bounded result·artifact 회수 계약을 포함합니다.
- **Skill 전용 안전 업데이트** — `--update-skill`이 Gateway runtime을 건드리지 않고 installer 관리본만 갱신합니다. 설치 시 기록한 SHA-256 tree digest로 사용자 수정 여부를 확인하며 customized·legacy install은 기본적으로 보존하고 `--force`에서만 덮어씁니다.
- **초기 설치와 갱신 분리** — `--install-skill`은 최초 설치 경로로 고정하여 기존 관리본을 암묵적으로 교체하지 않습니다. `--dry-run`, 대상 검증, 공용 skill root 중복 제거와 상태 기록도 두 경로에서 유지합니다.

## v1.3.0 변경 사항

v1.2.x 대비 Worker 위임 턴 1회당 오케스트레이터로 유입되는 토큰 사용량이 실측 기준 **최대 87% 감소**합니다(동일 시나리오 재생 벤치마크, 전체 턴 기준 약 84~87%). 누적 결과 재전송과 tool 페이로드 이중 전달을 기본 경로에서 제거한 결과이며, 절감치는 `agent_acp_setup`의 `metrics`로 직접 확인할 수 있습니다.

- **Poll 기본값 절약형 전환** — 턴이 진행 중일 때 누적 `result`를 반복 전송하지 않고 종료 후에만 포함하며, `tool_call*` 이벤트는 poll과 subscribe 모두 `includeToolEvents: true`로 요청할 때만 전달합니다.
- **결과 모델 분리** — Worker 턴의 누적 transcript에서 최종 답변을 분리합니다. `result.text`는 마지막 작업 경계(`tool_call` 시작, permission, elicitation) 이후의 메시지 텍스트만 담고, 진행 narration은 `includeInspection: true`(세그먼트별 4KB 미리보기 + artifact 포인터, `inspectionDropped` 카운트)로 조회합니다. `includeTranscript: true`는 bounded inline transcript를 반환하고 overflow 전체본은 `resultArtifact`로 회수합니다. 진행 업데이트(`tool_call_update`)·thought·usage 등은 경계를 만들지 않아 답변을 자르거나 지울 수 없으며, 최종 세그먼트가 비면 retained transcript로 안전하게 폴백합니다.
- **Cap-and-point 전달** — 상한에 걸리는 모든 페이로드가 정보 손실 없이 디스크 포인터를 갖습니다. 4KB(UTF-8 byte 기준)를 넘는 tool 이벤트 `data`·permission `toolCall`·elicitation schema·메시지 청크 사본은 잘린 미리보기와 함께 `dataArtifact`로, 64KB(`maxInlineResultBytes`)를 넘는 최종 답변은 `textArtifact`로 스필됩니다. 응답용 Inbox 레코드는 전문을 유지합니다.
- **Poll 조회 표면 확장** — `toCursor`와 `eventTypes`(정확 일치, 후행 `*`만 접두어)로 보존된 이벤트 이력을 대기 없이 범위 조회할 수 있고, `filteredCount`로 커서가 건너뛴 이벤트 수를 확인합니다. 대기는 호출자가 실제로 받을 이벤트나 상태 변화가 있을 때만 깨어나며, 숫자 인자는 음수·NaN·소수를 명시적으로 거부합니다.
- **생명주기 안정화** — 새 턴 시작 시 retention 타이머를 리셋하고 진행 중인 턴은 transient 정리에서 제외합니다. orphan 취소도 결과 모델을 거쳐 발행하며, 라이브 세션이 참조하는 artifact는 24시간 prune에서 보존됩니다.
- **전송량 계측** — Gateway가 poll 응답 수, byte, event type별 전달량을 누적해 `agent_acp_setup`의 `metrics`로 노출합니다. 토큰 절감을 추정이 아닌 운영 지표로 확인할 수 있습니다.
- **Skill 가이드 갱신** — `agent-delegator`에 결과 회수 경로 표(final/narration/transcript/tool evidence/oversized payload)와 포인터 기반 Worker 핸드오프(경로만 전달, 하류 Worker가 직접 읽는 콜드 스타트) 지침을 추가했습니다.

## v1.2.1 변경 사항

- **Claude 프론트 도어 설치 수정** — Claude Code 2.1.220의 variadic `-e` 파싱 규칙에 맞춰 MCP 이름을 환경변수보다 먼저 전달합니다. `--install-all --front-door claude`가 `Invalid environment variable format: agent-acp`로 중단되던 문제를 해결했습니다.
- **Claude MCP 회귀 테스트** — Control MCP 등록 명령에서 `agent-acp` 이름이 환경변수 앞에 위치하는지 검증합니다.

## v1.2.0 변경 사항

- **Worker 파라미터 제어** — `agent_acp_config`로 ACP Worker가 공개한 설정 목록과 현재값을 조회하고, 지원되는 select·boolean 값을 세션 단위로 변경할 수 있습니다.
- **자율 오케스트레이션 기반** — 모델, 모드, 추론 수준과 모델 설정 category를 공통 형식으로 노출하고 변경 이력을 `config_changed` 이벤트로 남겨 향후 DAG 노드별 파라미터 정책에 사용할 수 있게 했습니다.
- **안전한 동적 검증** — Worker가 광고하지 않은 옵션, 허용 목록 밖의 select 값, 잘못된 boolean 타입, 실행 중 세션의 변경을 차단합니다. process 단위 모델 변경은 새 세션을 요구합니다.
- **완전한 수동 업데이트** — `--update`가 상류 확인과 전체 테스트를 daemon 교체 전에 수행하며, GitHub Actions 없이 snapshot·adapter pin을 갱신하는 `npm run update:upstream`을 추가했습니다.

## v1.1.0 변경 사항

- **프론트 도어 선택 설치** — `--install-all` 실행 시 Codex, Claude, Grok 중 사용자가 대화할 오케스트레이터 하나를 선택합니다. 선택한 AI에는 Control MCP를, 발견된 AI 전체에는 Guide MCP와 `agent-delegator` 스킬을 설치합니다. 자동화 환경에서는 `--front-door codex|claude|grok`으로 명시할 수 있습니다.
- **ACP adapter 자동 업데이트** — Gateway daemon이 시작될 때와 이후 24시간마다 ACP agent registry를 확인합니다. 더 최신인 `npx`·`uvx` adapter는 자동으로 갱신하며, 이미 실행 중인 작업은 종료하지 않고 다음 Worker 실행부터 새 버전을 적용합니다.
- **업데이트 상태 알림** — health check에서 adapter 업데이트 적용·실패, 수동 업데이트 필요, 오래된 registry, downgrade 위험을 확인할 수 있습니다. `agent-delegator`는 이 알림을 사용자에게 전달합니다.
- **Gateway 새 버전 알림** — GitHub `main`에 로컬보다 높은 버전이 있으면 health check로 알려줍니다. Gateway 소스는 임의로 변경하지 않으며, 사용자가 `acp-gateway-bootstrap --update`를 실행할 때만 갱신합니다.
- **상류 변경 자동 모니터링** — GitHub Actions가 ACP protocol release와 공식 registry의 agent 버전을 매일 확인하고, 변경이 발견되면 `dev` 브랜치 대상 업데이트 PR을 생성하거나 갱신합니다.
- **설치·업데이트 안정화** — 이전 버전 daemon이 남아 health check가 실패하던 문제를 보완해 버전 불일치 시 daemon을 교체합니다. `--version`을 추가했고, `--update`는 사용자가 수정한 `agent-delegator` 스킬을 덮어쓰지 않습니다.
- **의존성 기준 갱신** — Claude ACP `0.64.1`, Codex ACP `1.1.9`, MCP SDK `1.30.0` 기준으로 registry snapshot과 런타임 의존성을 갱신했습니다.
