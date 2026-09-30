# 운영 가이드

**한국어** | [English](operations.md)

README에서 다루지 않는 설치 옵션, 업데이트 절차, Worker 제어, 세션·데이터 관리의 상세 내용입니다. 처음 설치한다면 [README](../README.ko.md)의 빠른 시작을 먼저 보세요.

## 설치와 업데이트

이전 버전의 daemon이 남아 있으면 installer가 health 응답의 버전을 비교해 자동으로 교체한 뒤 다시 검사합니다. 따라서 `git pull`, `npm ci` 후 `--install-all --refresh-registry`를 실행하는 수동 업그레이드도 지원합니다.

여러 agent를 모두 오케스트레이터 후보로 등록하려면 `--target all`을 사용할 수 있습니다. 이 옵션은 각 agent 설정에 오케스트레이터 권한이 있는 Control MCP를 넣으므로, 신뢰하는 로컬 agent에만 사용하세요.

나중에 설치 계획만 다시 확인하려면:

```bash
acp-gateway-bootstrap --install-all --dry-run
```

갱신 방법은 Gateway를 설치한 방식에 따라 다릅니다(아래 참고). 소스 checkout이라면 다음 명령 하나면 됩니다.

```bash
acp-gateway-bootstrap --update
```

소스 checkout에서 `--update`는 상류 commit을 받아 임시 worktree에 설치하고 테스트한 뒤(`npm ci`, 이어서 `npm run ci`)에야 checkout을 fast-forward합니다. ACP protocol·공식 registry의 상류 변경도 확인하며, snapshot 검증과 전체 자동 테스트를 통과해야 다음 단계로 진행합니다. 이후 내부 dry-run 계획을 출력하고 ACP registry와 adapter, MCP 등록을 갱신합니다. 마지막으로 실행 중인 Gateway daemon을 새 버전으로 다시 시작하고 실제 버전까지 확인합니다. 설치 상태, Control identity와 최초 설치에서 선택한 프론트 도어는 그대로 유지됩니다. 상류 확인이 일시적으로 실패하면 경고를 남기되 이미 받은 소스의 로컬 검증은 계속하며, 테스트 실패는 daemon을 교체하기 전에 update 전체를 중단합니다.

`--update`는 먼저 패키지가 놓인 위치를 보고 Gateway가 어떻게 설치됐는지 판단합니다. 위처럼 pull과 검증을 하는 것은 소스 checkout(`.git`이 있는 디렉터리)뿐입니다. npm 설치본(`node_modules` 안의 패키지)에서는 Git도 npm도 실행하지 않습니다. npm registry에서 `acp-gateway-daemon`의 `latest` 버전을 확인해 새 버전이 있으면 `npm install -g acp-gateway-daemon@latest`를 안내하고, 곧바로 dry-run 계획, registry·adapter·MCP 갱신, daemon 재시작으로 넘어갑니다. 그러니 새 버전을 먼저 설치한 뒤 `--update`를 실행하세요.

```bash
npm install -g acp-gateway-daemon@latest
acp-gateway-bootstrap --update
```

앱이 관리하는 runtime(`~/.acp-gateway/runtime/versions/` 아래)은 `managed`로 보고합니다. Gateway 교체는 그 앱이 맡고, `--update`는 이 설치본의 등록 정보만 갱신합니다.

Claude Worker는 사용자가 설치한 Claude CLI를 실행하며, 다음 순서로 찾습니다. `CLAUDE_CODE_EXECUTABLE`이 비어 있지 않으면 그 경로, 아니면 daemon의 PATH 중 절대 경로 디렉터리에서 처음 찾은 실행 가능한 `claude`(Gateway 자신의 의존성 안에 있는 것과 Claude Agent SDK에 딸린 바이너리는 제외), 그것도 없으면 `~/.local/bin/claude`입니다. 셋 다 없으면 Claude는 설치되지 않은 것으로 보고됩니다. 1.7.2부터는 npm 설치(npm 10·11·12 모두)와 GitHub runtime 릴리스 어느 쪽에도 Claude Agent SDK에 딸린 Claude Code 바이너리가 들어가지 않습니다. 1.7.1도 runtime 릴리스와 npm 10·11로 한 설치에서는 이미 이 바이너리를 뺐습니다.

사용자가 수정한 `agent-delegator`를 보호하기 위해 skill은 최초 `--install-all`에서만 설치하며 `--update`에서는 건드리지 않습니다. `--install-skill`도 최초 설치용이므로 이미 installer가 관리하는 복사본을 자동으로 덮어쓰지 않습니다. 로컬 소스 변경을 보호하기 위해 Git 작업 트리가 깨끗하지 않으면 update를 중단하므로 먼저 변경 사항을 commit하거나 stash해야 합니다. 소스와 직접 연결되는 `npm link`는 최초 설치 후 다시 할 필요가 없습니다.

현재 checkout에 포함된 최신 기본 skill만 별도로 반영하려면 먼저 계획을 확인한 뒤 업데이트합니다.

```bash
acp-gateway-bootstrap --update-skill --dry-run
acp-gateway-bootstrap --update-skill
```

`--update-skill`은 installer 상태에 기록된 모든 `agent-delegator` 복사본을 대상으로 하며, Gateway 소스 pull, adapter·MCP 변경, daemon 재시작은 수행하지 않습니다. 설치 시 기록한 SHA-256 tree digest와 현재 설치본이 일치할 때만 교체하므로 사용자가 수정한 skill은 `customized` 경고와 함께 보존됩니다. v1.3.0 이하에서 설치해 digest가 없는 복사본도 내용이 현재 기본본과 같더라도 `legacy-unverified`로 보존합니다. 내용을 검토한 뒤 기본본으로 덮어쓰려는 경우에만 `--update-skill --force`를 사용하세요. 최신 Gateway 소스를 먼저 받을 때는 `acp-gateway-bootstrap --update`가 성공한 다음 별도 명령으로 실행합니다.

### 호스트 재연결 절차

Gateway를 새 버전으로 올린 뒤에는 **호스트(Claude/Codex/Grok/Auggie) 세션을 반드시 다시 연결해야** 새 tool과 인자가 보입니다. MCP 호스트는 서버가 처음 응답한 tool 목록을 세션 동안 캐시하고, daemon 재시작은 소켓만 교체하기 때문에(RPC가 투명하게 재접속) 낡은 스키마는 아무 오류 없이 그대로 남습니다. 서버 version을 올려도 캐시는 깨지지 않습니다.

순서대로 실행하세요.

```bash
acp-gateway-bootstrap --update          # 1. Gateway 소스·adapter·daemon 갱신
acp-gateway-bootstrap --update-skill    # 2. skill 갱신 (수정본이면 --force)
```

3. **호스트 재연결** — Claude Code는 `/mcp reconnect` 또는 새 세션, Codex·Grok·Auggie는 새 세션을 시작합니다.
4. **검증** — tool 목록에 `agent_acp_run`이 있고, `agent_acp_setup` 응답에 `staleFrontDoor`가 없으면 정상입니다.

`staleFrontDoor`는 프론트 도어(호스트에 등록된 MCP 프로세스)의 버전과 실행 중인 daemon 버전이 다를 때 `agent_acp_setup`·`agent_acp_session_open` 응답에 붙는 알림으로, `frontDoorVersion`·`gatewayVersion`·필요한 조치(`action`)와, 두 버전의 순서를 정할 수 있으면 `reason`을 담고 있습니다. `reason: "front_door_older"`이거나 `reason`이 없으면 3번을 수행하세요. `reason: "gateway_older"`이면 daemon 쪽이 오래된 것이라 재연결해도 같은 daemon에 다시 붙을 뿐입니다. 한가할 때 `acp-gateway-admin shutdown_if_idle`로 daemon을 재시작하면(작업이 진행 중이면 거부하므로 나중에 다시 시도) 다음 `agent-acp` 호출이 프론트 도어 버전으로 daemon을 띄웁니다. `acp-gateway-bootstrap --update`는 스크립트가 사라졌거나 더 오래된 Gateway를 고정 경로로 가리키는 관리 중인 `agent-acp` 항목을 현재 설치본을 가리키도록 다시 등록합니다. 단, 그 항목이 이 installer가 등록한 바로 그 항목임이 입증될 때만 그렇게 합니다. 1.7.2부터 설치 상태에 등록할 때마다 그 실행 정보(command와 args)를 기록하며, 항목이 여전히 정확히 그것을 실행해야 합니다. 1.7.2 이전에 등록한 항목에는 이 기록이 없으므로, installer가 쓰는 형태(node 실행 파일이 Gateway의 `src/index.js`를 실행)를 유지하고 그 스크립트가 Gateway 패키지(`acp-gateway` 또는 `acp-gateway-daemon`) 안에 실제로 있을 때만 옮깁니다. 이런 항목의 스크립트가 사라졌다면 그대로 둡니다. 이 확인을 통과하지 못한 항목은 경고와 함께 그대로 두고, `--force`로 다시 등록할 수 있습니다. 다른 앱이 관리하는 symlink를 거치는 항목도 그대로 두고, 더 오래된 Gateway로 이어지거나 링크가 끊겼거나 그 뒤에 스크립트가 없으면 경고만 남깁니다. agent CLI에는 원자적인 교체 명령이 없으므로, installer는 항목을 지우기 전에 그 command·args·env를 읽어 둡니다. 그 뒤 새 항목을 추가하지 못하면 이전 항목을 원래 모습 그대로 되돌립니다. 정확히 되돌릴 수 없는 항목(예: CLI가 env를 알려 주지 않는 경우)은 업데이트가 지우지 않고 경고와 함께 그대로 두며, `--force`를 주면 그래도 교체합니다.

### 주요 installer 옵션

| 옵션 | 설명 |
|---|---|
| `--version`, `-V` | 현재 설치된 ACP Gateway 버전 확인 |
| `--update` | 소스 pull·상류 확인·전체 테스트(소스 checkout만 해당, npm·앱 관리 설치본은 Git을 건너뜀)와 dry-run 후 Adapter, MCP, daemon 갱신—사용자 skill 유지 |
| `--install-all` | Adapter, Guide, skill 전체 설치 후 프론트 도어 하나에 Control 등록 |
| `--front-door codex\|claude\|grok` | `--install-all`의 Control MCP 대상 명시 |
| `--install-control` | 오케스트레이터용 Control MCP만 설치 |
| `--install-guide` | 읽기 전용 Guide MCP만 설치 |
| `--install-skill` | 발견된 AI에 `agent-delegator` skill 최초 설치—기존 관리본은 보존 |
| `--update-skill` | 현재 checkout의 기본본으로 변경되지 않은 installer 관리 skill만 별도 갱신 |
| `--discover-agents` | 설치된 AI를 ACP 공식 registry와 대조 |
| `--registry-agent ID` | 발견 여부와 무관하게 registry agent 하나를 선택 설치 |
| `--refresh-registry` | 24시간 cache를 무시하고 공식 registry 갱신 |
| `--offline` | 저장된 registry cache만 사용 |
| `--target codex\|claude\|grok\|auggie\|all` | 오케스트레이터용 Control MCP 설치 대상 선택 |
| `--dry-run` | 실제 변경 없이 계획만 출력 |
| `--rotate-token` | Control token과 오케스트레이터 식별자(Main ID) 교체 |
| `--force` | 관리하지 않던 항목 또는 사용자가 수정한 관리 skill을 명시적으로 교체 |
| `--agent-auto-update on\|off` | ACP agent/adapter 자동 업데이트 설정 후 daemon 재시작 |
| `--agent-update-notifications on\|off` | health check 업데이트 알림 설정 후 daemon 재시작 |

Control token과 오케스트레이터 식별자(Main ID)는 `~/.acp-gateway/install.json`에 권한 `0600`으로 저장되며 반복 설치에서도 재사용됩니다.

Skill은 Codex `~/.codex/skills`, Claude `~/.claude/skills`, Grok `~/.grok/skills`, Auggie `~/.augment/skills`에 설치합니다. 별도 경로가 알려지지 않은 registry provider는 공용 `~/.agents/skills`를 사용합니다. 같은 공용 경로를 사용하는 provider가 여러 개면 skill 파일은 한 번만 복사하고 installer 상태에는 각 provider를 모두 기록합니다.

Control·Guide MCP 등록은 Codex, Claude, Grok, Auggie를 지원합니다. 기본 `--install-all`에서 Control은 사용자가 프론트 도어로 선택한 Codex·Claude·Grok 중 하나에만 등록되고, Guide와 skill은 발견된 지원 agent 전체에 설치됩니다. `--target`은 고급 수동 대상 지정 용도로 유지됩니다. Control MCP는 Gateway 전체 제어 권한이 있으므로 신뢰하는 로컬 agent에만 설치하세요. 이 토큰은 그 agent의 MCP 설정에 저장되므로, 자기 도구로 Gateway를 거치지 않고 파일을 읽는 Worker(Codex는 `read_only`에서도 그렇게 읽는 것을 확인했습니다)가 읽어서 Main처럼 행동할 수 있습니다. 이런 Worker에게 신뢰할 수 없는 자료를 맡기기 전에 [권한 정책](../README.ko.md#권한-정책)을 확인하세요.

공식 registry 원본은 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`이며 `~/.acp-gateway/registry.json`에 24시간 캐시합니다. 발견된 provider 실행 정의는 `~/.acp-gateway/providers.json`에 저장됩니다. `npx`·`uvx` 배포는 registry에 고정된 버전을 설치하고, binary 배포는 이미 설치된 실행 파일을 사용합니다. registry에 등록되지 않은 임의의 AI는 ACP 실행 계약을 안전하게 추론할 수 없으므로 자동 등록하지 않습니다.

### ACP 상류 버전 모니터링

ACP 공식 protocol 저장소와 registry 확인은 maintainer가 아래 명령으로 수동 수행합니다. Protocol release·공개 wire version, registry agent의 추가·삭제·버전·배포 정보가 바뀌면 snapshot을 갱신해 검토 후 `dev`에 커밋합니다. npm과 GitHub Actions의 일반 버전 업데이트는 Dependabot이 별도의 `dev` 대상 PR로 관리합니다. 보안 업데이트는 GitHub 정책에 따라 기본 브랜치인 `main`을 대상으로 합니다.

```bash
npm run monitor:check   # 변경이 있으면 보고서를 출력하고 종료 코드 2 반환
npm run monitor:update  # 검토용 snapshot을 현재 상류 상태로 갱신
npm run monitor:sync-dependencies  # 저장소가 직접 포함한 ACP adapter 버전 동기화
npm run update:upstream  # 위 갱신과 전체 CI를 한 번에 실행하는 수동 유지보수 경로
```

maintainer가 `npm run update:upstream`을 실행하면 snapshot 갱신, 관리 대상 ACP adapter pin·lockfile 동기화와 전체 CI를 로컬에서 한 번에 수행할 수 있습니다. 이 명령은 커밋이나 push를 자동으로 하지 않습니다. `git diff`로 protocol·registry 변경과 테스트 결과를 검토한 뒤 `dev`에 커밋하면 됩니다. 일반 사용자의 `acp-gateway-bootstrap --update`는 저장소 파일을 임의로 수정하지 않고 상류 변경을 보고한 뒤 runtime adapter만 안전하게 갱신합니다.

두 업데이트 경로는 역할이 다릅니다.

- **ACP agent/adapter 버전:** daemon이 공식 registry의 고정 버전을 주기적으로 확인해 자동 갱신합니다. `acp-gateway-bootstrap --update`를 실행할 때도 즉시 registry를 새로 읽고 같은 갱신을 수행합니다.
- **ACP protocol wire version:** 새 major를 감지해 `monitor:check` 보고서에 경고하지만 자동 적용하지 않습니다. 호환성 테스트 후 `src/acp-version.js`와 monitor 설정을 함께 바꿔야 합니다.
- **Gateway npm 의존성:** Dependabot PR에서 lockfile과 CI 결과를 확인한 뒤 병합합니다.

현재 runtime은 ACP wire version 1을 사용합니다. 공식 저장소의 `schema/v2`도 감지되지만, v2 지원으로 표시하거나 자동 전환하지 않습니다. Snapshot 갱신은 알림과 검토 시작점이며 자동 병합 또는 Gateway release를 수행하지 않습니다.

v1.1.0부터 daemon은 시작 시점과 이후 24시간마다 ACP 공식 registry를 확인합니다. 발견된 `npx`·`uvx` adapter가 새 버전이면 자동으로 설치하고 provider 정의를 갱신합니다. 이미 실행 중인 Worker process는 중단하지 않으며, 새 process나 session부터 갱신된 adapter가 적용됩니다. 직접 설치해야 하는 binary 배포는 자동 교체하지 않고 health 경고로 남깁니다.

`agent_acp_setup` health 응답의 `agentUpdates`에는 확인 시각, 적용된 버전, 남은 수동 업데이트와 오류가 포함됩니다. 알림이 켜져 있으면 같은 응답의 `alerts`에 사용자에게 보여줄 메시지가 들어갑니다. 즉 Gateway가 임의로 화면에 push하는 방식은 아니며, 오케스트레이터가 health check 결과를 받을 때 알림을 사용자에게 전달합니다. 즉시 다시 확인하려면 `refreshAgentUpdates: true`로 setup을 호출합니다.

Gateway 자체는 자동으로 pull하거나 설치하지 않습니다. 같은 주기에서 소스 checkout은 Git 저장소의 원격 `main`에 게시된 `package.json` 버전만, npm 설치본은 npm registry에 있는 `acp-gateway-daemon`의 `latest` 버전만 확인합니다. 더 높은 버전이 있으면 health의 `gatewayUpdate`(`installMode` 포함)와 `gateway_source_update_available` 알림으로, 소스 checkout에는 `acp-gateway-bootstrap --update`를, npm 설치본에는 `npm install -g acp-gateway-daemon@latest` 다음 `acp-gateway-bootstrap --update`를 안내합니다. 앱이 관리하는 runtime은 아무것도 확인하지 않고 `status: "managed"`로 보고하며, 업데이트는 그 앱이 맡습니다. 따라서 설치된 Gateway, 설치 상태와 사용자 정의 skill은 사용자가 명시적으로 업데이트하기 전까지 변경되지 않습니다.

자동 업데이트와 알림은 기본으로 켜집니다. 설치 후 다음처럼 각각 끄거나 다시 켤 수 있으며, 사용자 정의 skill은 변경하지 않습니다.

```bash
acp-gateway-bootstrap --agent-auto-update off
acp-gateway-bootstrap --agent-update-notifications off

acp-gateway-bootstrap --agent-auto-update on
acp-gateway-bootstrap --agent-update-notifications on
```

Dependabot 설정은 GitHub의 기본 브랜치에 존재해야 활성화되며, `dev` 대상 PR을 위해 원격 `dev` 브랜치를 유지해야 합니다.

### npm 배포 (maintainer용)

Gateway는 npm에 `acp-gateway-daemon`으로 게시합니다(명령 이름은 그대로 `acp-gateway-*`). 릴리스 버전이 `package.json`, `package-lock.json`, `src/version.js`의 `GATEWAY_VERSION`, 두 변경 이력의 최신 제목에 모두 반영된 commit만 게시하세요. 이 값들이 서로 맞는지는 `npm run ci`가 검사합니다. npm 버전은 바꿀 수 없습니다. 한 번 게시한 버전 번호는 unpublish한 뒤에도 다시 쓸 수 없으므로, 잘못 게시했다면 새 버전을 내는 수밖에 없습니다.

- **GitHub Actions(기본 경로):** 릴리스 태그를 push한 뒤, 그 태그에서 `Publish npm` workflow(`.github/workflows/publish-npm.yml`, 수동 `workflow_dispatch`)를 입력 `version`과 함께 실행합니다. 예: `gh workflow run publish-npm.yml --ref v1.7.2 -f version=1.7.2`. 실행이 `refs/tags/v<version>`에서 시작되지 않았거나, 입력 버전이 `package.json` 버전·`GATEWAY_VERSION`과 다르거나, 패키지 이름이 `acp-gateway-daemon`이 아니거나, checkout한 커밋이 태그의 커밋과 다르면(실행 후 태그를 옮긴 경우 포함) 실패합니다. npm에 이미 있는 버전은 거부합니다. 게시 권한이 없는 job에서 `npm ci --omit=optional`로 설치한 뒤 `npm run ci`와 `npm run smoke:npm`(npm 10·11·12)을 실행하고, `scripts/pack-release.js`로 pack합니다. 이렇게 만든 tarball의 sha256이 smoke test가 설치한 tarball과 다르면 실패합니다. GitHub OIDC 토큰을 요청할 수 있는 유일한 job인 두 번째 job은 저장소 코드를 실행하지 않고, 검증된 그 tarball만 npm 11로 게시합니다(`npm publish --provenance --access public`).
  - 게시는 npm trusted publishing(OIDC)을 사용하며, 저장소에 npm 토큰을 두지 않고 workflow도 토큰을 쓰지 않습니다. npmjs.com의 `acp-gateway-daemon` → Settings → Trusted Publisher에 GitHub Actions를 organization `creverse-ai-lab`, repository `agent_gateway`, workflow filename `publish-npm.yml`, environment 비움으로 등록하고, allowed actions에 `npm publish`를 포함해야 합니다. 2026-09-03 이후 만든 설정은 `npm publish`를 따로 체크하지 않으면 `npm stage publish`만 허용하는데, 이 workflow는 `npm publish`를 실행합니다. 각 항목은 대소문자를 구분하고 저장할 때 npm이 검증하지 않으므로, 값이 틀리면 게시 job의 실패(예: `ENEEDAUTH`, `E404`)로만 드러납니다. workflow 파일 이름을 바꾸면 이 설정을 고칠 때까지 게시할 수 없습니다.
  - trusted publishing이 동작하면 Settings → Publishing access를 "Require two-factor authentication and disallow tokens"로 바꾸세요. trusted publishing은 계속 동작하고, 유출된 토큰으로는 더 이상 게시할 수 없습니다.
  - npm은 공개 GitHub 저장소에서만 provenance를 붙이고 trusted publishing은 GitHub-hosted runner에서만 동작하므로, 저장소가 비공개인 동안에는 이 workflow로 게시할 수 없습니다.
- **로컬 게시:** 릴리스 태그를 깨끗하게 checkout한 상태에서 `npm ci --omit=optional`로 설치하고, 검사를 돌리고, 로그인한 뒤 게시합니다. 패키지는 설치된 `node_modules`를 그대로 번들하며, `npm publish`는 잠긴 production 트리와 정확히 같지 않은 트리를 거부하는 `prepack` 검사(`scripts/pack-release.js`)를 실행하므로 `--ignore-scripts`를 붙이지 마세요. 이 경로로 게시하면 provenance가 붙지 않습니다.

```bash
git clone --branch v1.7.2 https://github.com/creverse-ai-lab/agent_gateway.git
cd agent_gateway
npm ci --omit=optional
npm run ci
npm run smoke:npm
npm login
npm publish --access public
```

npm 게시가 데스크톱 앱이 설치하는 GitHub runtime 릴리스(`acp-gateway-runtime-darwin-arm64.tar.gz`)를 대신하지는 않습니다. runtime 릴리스는 지금처럼 `Release runtime` workflow로 따로 빌드하며, 패키지 이름도 그대로 `acp-gateway`입니다. 한쪽을 게시한다고 다른 쪽이 만들어지지는 않습니다.

## Worker 파라미터 제어

`agent_acp_config`는 Worker가 ACP `configOptions`로 직접 공개한 세션 파라미터를 조회하고 변경합니다. `action: list`로 가능한 값과 현재값을 확인한 뒤, 세션이 작업 중이 아닐 때 `action: set`, `configId`, `value`를 전달합니다. ACP wire v1 기준으로 선택형 문자열과 boolean 설정을 지원하며, `model`, `mode`, `model_config`, `thought_level` 같은 category를 그대로 보존합니다.

Gateway는 Worker가 공개하지 않은 `temperature`, `max_tokens` 같은 값을 임의로 만들어 전달하지 않습니다. 따라서 지원 범위는 Claude, Codex, Grok 등 각 ACP adapter가 실제로 광고하는 옵션에 따라 달라집니다. 설정 변경은 `config_changed` 세션 이벤트로 남으므로, 추후 DAG 오케스트레이터가 노드의 작업 유형·비용·품질 정책에 따라 파라미터를 선택하고 결과와 함께 추적할 수 있습니다. process 단위로 모델을 고정하는 Worker는 기존 세션에서 모델을 바꾸지 않고 새 세션을 열어야 합니다.

## 결과 회수와 artifact

v1.3.0부터 poll 기본값이 절약형입니다. 턴이 진행 중일 때 `result`는 자동으로 생략되고(`includeResult: true`로 명시할 때만 포함), 종료 후 poll의 `result.text`에는 누적 transcript가 아니라 **최종 답변 세그먼트**(마지막 작업 경계 이후의 메시지 텍스트)만 담깁니다. 진행 narration은 `includeInspection: true`로 조회합니다. `agent_acp_session` `get`의 `includeTranscript: true`는 메모리에 남은 bounded transcript를 반환하며, overflow된 전체 transcript는 `resultArtifact`를 따라 회수합니다. `cursor`/`toCursor`/`eventTypes`로 보존된 이벤트 이력도 범위 조회할 수 있습니다. 자세한 회수 경로는 `agent-delegator` skill의 "Retrieve the correct result" 표를 따르세요.

인라인 상한을 넘는 데이터는 전부 `~/.acp-gateway/artifacts`의 파일로 스필되고 응답에는 잘린 미리보기와 포인터(경로·바이트 수·완료 여부)가 실립니다 — 4KB(UTF-8)를 넘는 tool 이벤트 payload는 `dataArtifact`, 64KB를 넘는 최종 답변은 `textArtifact`, 메모리 상한(1MB)을 넘는 transcript는 `resultArtifact`. 인라인에는 상한 내 내용만 유지하므로 RAM과 오케스트레이터 컨텍스트가 결과 크기에 따라 늘어나지 않습니다. Artifact는 파일당 100MB·전체 512MB이고, 라이브 세션이 참조하는 파일은 24시간 정리에서 보존됩니다. 동시 미응답 권한·질문 요청은 세션당 64개의 안전 상한을 따르며, 큰 설명 chunk는 32MB protocol frame 상한 안에서 그대로 처리합니다. 전송·세션·Main 단위 예산도 `setup().resourceLimits`에 함께 실립니다 — control 연결당 쓰기 큐 4MB와 10초 무진행 상한(worker stdin 쪽 큐는 동시 요청 상한에서 파생), prompt 1MB, 파일 읽기 500KB(바이트 기준, 초과분은 `_meta["acp-gateway/read"]`로 절단을 알림), terminal 출력 10MB, Main당 세션 64개와 처리 완료 inbox 이력 1000건.

## 세션과 데이터

- 상태 파일(schema v5): `~/.acp-gateway/state.snapshot.json`(전체 상태) + `~/.acp-gateway/state.wal.ndjson`(control 전이 로그)
- `~/.acp-gateway/state.json`은 v4 형식으로 계속 기록됩니다. 1.4 Gateway로 명시적으로 롤백할 수 있도록 현재 버전에서도 계속 기록합니다.
- idle resumable 세션은 기본 30분 후 unload
- 결과와 이벤트는 기본 24시간 보존
- session resume checkpoint는 기본 7일 보존, Task 핸들의 바이트는 기본 24시간 보존(`ACP_GATEWAY_TASK_RETENTION_MS`)
- 장시간 유지가 필요한 세션은 `pin` 사용
- 응답 본문, thought, 전체 이벤트 이력은 상태 파일에 영구 저장하지 않음
- 인라인 상한을 넘은 결과와 terminal 출력은 `~/.acp-gateway/artifacts`에 임시 저장 후 결과 보존 기간에 맞춰 정리

### 상태·중단·attention

v1.7.0부터 Gateway는 맡긴 작업이 어디까지 왔는지 알려 주므로 오케스트레이터가 짐작할 필요가 없습니다. 어느 것도 대신 취소하거나 다시 실행하지 않습니다.

- **상태 이유와 멈춤 힌트** — 세션 `get`/`list`에 `statusReason`·`statusChangedAt`·`lastWorkerActivityAt`이 나오고, 실행 중인 턴이 `stallHintMs` 동안 아무것도 보내지 않으면 `stallSuspected`가 붙습니다. `setup`은 `sessions_stall_suspected` 경고를 띄웁니다.
- **중단** — Gateway가 끊은 작업에는 `interruption: {reason, executionOutcome, at}`이 붙고(`executionOutcome`은 `not_started` 또는 `unknown`), 결과에 `next` 단계가 담깁니다. v1.7.2부터 `not_started` 판정은 v1.7.2 이후에 만든 작업에만 나올 수 있고, 그 이전에 만든 작업은 이후에 중단되면 `unknown`입니다. 그런 작업에 v1.7.0이나 v1.7.1이 이미 기록한 `not_started`도 `unknown`으로 읽히며, `next`도 그에 맞게 다시 만들어집니다. `agent_acp_session {action: "check"}`는 provider를 띄우지 않고 세션이 `restorable`·`restorable_with_caveats`·`not_restorable`·`unknown` 중 어디에 해당하는지 알려 줍니다.
- **attention** — `agent_acp_inbox {action: "attention"}`은 `needsMain`(대기 중 요청, `attentionStaleMs`가 지나면 `stale`)과 `updates`(작업을 시작한 Main에게 결과가 아직 닿지 않은 종료 작업)를 돌려줍니다. `{action: "ack", taskIds}`는 지정한 작업을 확인한 것으로 표시합니다.
- **scope** — `agent_acp_session {action: "list"}`와 `task_list`에 `scope: "mine"`을 주면 호출한 Main의 기록만 남깁니다. 호출자 정보를 보내지 않는 프론트 도어(1.6 이전)는 `INVALID_ARGUMENT`를 받습니다.
- **격리** — 복구가 `maxConsecutiveRestoreFailures`번 연달아 실패하면 `prompt`·`task_prompt`·`run`·`config`는 provider에 연락하지 않고 `SESSION_QUARANTINED`로 실패합니다. `check`, `agent_acp_session_restore`(이 Main의 기존 기록을 그 자리에서 복구하며, provider가 꺼져 있어도 쓸 수 있고, 성공하면 격리가 풀림), `agent_acp_session_open`은 계속 쓸 수 있습니다.

### 내구성과 복구

Task 생성과 결과 확정은 응답을 반환하기 전에 WAL에 append + fsync합니다. 즉 Main이 받은 Task 핸들은 daemon이 죽어도 남아 있고, 재시작 후 미완 Task는 `failed`(재시작 메시지)로 확정됩니다. v1.7.0부터는 `interruption`도 함께 붙습니다(아래 참고). 나머지 전이(permission·질문 기록, 세션 등록/종료, 상태 변경)는 5ms group commit입니다. v1.7.2부터는 세션 복구 실패(실패 횟수, 격리, `lastRestore`)와 실패 연속을 끝내는 복구 성공도 응답을 반환하기 전에 fsync하므로, 장애가 나도 격리가 풀리거나 복구 성공으로 풀린 격리가 되살아나지 않습니다. 이 동기화 쓰기가 실패해도 복구 결과는 그대로지만 그 사실을 알립니다. persistence가 불건강 상태가 되고, `setup`에 `STATE_RESTORE_NOT_DURABLE` 경고가 나타나며(다음 write가 성공해도 사라지지 않음), 복구 응답에는 `durability: { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" }`가 붙습니다(복구가 실패했다면 오류의 `details.durability`에 붙음). macOS에서 Node는 `F_FULLFSYNC`를 노출하지 않으므로 `fsync(2)`만 사용합니다 — 프로세스 비정상 종료는 완전히 보호되고, 전원 손실은 group commit 창(기본 5ms)만 노출됩니다.

상태 파일이 손상되면 daemon은 **빈 상태로 조용히 시작하지 않고** 중단합니다. 이때 `~/.acp-gateway/state.recovery-required`에 이유를 기록하고 exit 78로 종료하며, Control MCP 연결 실패 메시지에 그 내용이 표면화됩니다. 복구는 명시적으로 선택합니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ACP_GATEWAY_WAL` | `on` | `off`면 WAL 없이 critical mutation마다 snapshot을 동기 기록(동일한 내구성 약속, 더 큰 쓰기 비용) |
| `ACP_GATEWAY_WAL_GROUP_COMMIT_MS` | `5` | 비임계 전이의 group commit 간격 |
| `ACP_GATEWAY_WAL_ROTATE_BYTES` / `_RECORDS` / `_INTERVAL_MS` | `4MiB` / `10000` / `15m` | WAL 회전 조건 |
| `ACP_GATEWAY_WAL_INLINE_RESULT_BYTES` | `4096` | 이 크기를 넘는 Task 결과는 artifact로 분리하고 WAL은 참조 + preview만 기록 |
| `ACP_GATEWAY_FSYNC` | `normal` | `off`는 테스트·임시 볼륨 전용 |
| `ACP_GATEWAY_STATE_RECOVERY` | (없음) | `truncate`: 손상 직전까지 WAL replay 후 시작 / `snapshot-drop`: snapshot 폐기 후 `state.json`에서 복구 / `cold`: 빈 상태로 시작 |
| `ACP_GATEWAY_TASK_RETENTION_MS` | `24h` | Task 레코드와 결과 artifact의 디스크 생존 기간(세션 보존과 독립) |
| `ACP_GATEWAY_MAX_QUEUE_BYTES` | `4000000` | control 연결당 OS+channel 합산 쓰기 예산. HIGH는 전체, NORMAL은 7/8, LOW는 1/2까지 사용 |
| `ACP_GATEWAY_WRITE_TIMEOUT_MS` | `10000` | 이 시간 동안 OS가 한 바이트도 받지 않으면 해당 연결·프로바이더를 종료 |
| `ACP_GATEWAY_MAX_PROMPT_BYTES` | `1000000` | 초과 prompt는 턴을 만들기 전에 `PROMPT_TOO_LARGE`로 거부 |
| `ACP_GATEWAY_MAX_FILE_READ_BYTES` | `500000` | worker의 `fs/read_text_file` 응답 바이트 상한(거부 대신 절단) |
| `ACP_GATEWAY_MAX_TERMINAL_OUTPUT_BYTES` | `10000000` | terminal 출력 버퍼 상한(기존 하드코딩 값과 동일) |
| `ACP_GATEWAY_MAX_SESSIONS_PER_ROOT` | `64` | Main당 동시 세션 상한. 초과 시 `SESSION_LIMIT_EXCEEDED` |
| `ACP_GATEWAY_MAX_INBOX_ITEM_BYTES` | `65536` | worker permission/elicitation 한 건의 보관 바이트 상한 |
| `ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_SESSION` | `524288` | 세션당 pending inbox 합산 바이트 상한 |
| `ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_ROOT` | `4194304` | Main당 pending inbox 합산 바이트 상한 |
| `ACP_GATEWAY_MAX_INBOX_HISTORY_PER_ROOT` | `1000` | Main당 보관하는 처리 완료 inbox 건수(pending은 제거 대상 아님) |
| `ACP_GATEWAY_STALL_HINT_MS` | `300000` | 설정 `stallHintMs`(최소 `10000`). 실행 중인 Worker가 이 시간 동안 아무것도 보내지 않으면 세션 조회에 `stallSuspected`가 붙음. 힌트일 뿐 |
| `ACP_GATEWAY_ATTENTION_STALE_MS` | `600000` | 설정 `attentionStaleMs`(최소 `10000`). Worker 요청이 이 시간 넘게 기다리면 attention 조회와 `setup`이 stale로 표시. 표시일 뿐 |
| `ACP_GATEWAY_MAX_CONSECUTIVE_RESTORE_FAILURES` | `3` | 설정 `maxConsecutiveRestoreFailures`(최소 `1`). 복구가 이 횟수만큼 연달아 실패하면 세션을 격리(`SESSION_QUARANTINED`). provider 시작이 같은 횟수만큼 실패하면 `provider_degraded` 경고 |

persistence가 불건강해지면 **새 Task 생성만** `PERSISTENCE_UNHEALTHY`로 거부합니다(핸들 = 내구성 약속). `session_open`과 직접 `prompt`는 계속 동작하며, 다음 성공한 write에서 건강 상태가 회복됩니다. `setup().persistence`에 `mode`, `walSeq`, `walBytes`, `snapshotEpoch`, `fsyncCount`, `lastRecovery`가 함께 보고됩니다.
