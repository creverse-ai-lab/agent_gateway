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

`staleFrontDoor`는 프론트 도어(호스트에 등록된 MCP 프로세스)의 버전과 실행 중인 daemon 버전이 다를 때 `agent_acp_setup`·`agent_acp_session_open` 응답에 붙는 알림으로, `frontDoorVersion`·`gatewayVersion`·필요한 조치(`action`)와, 두 버전의 순서를 정할 수 있으면 `reason`을 담고 있습니다. `reason: "front_door_older"`이거나 `reason`이 없으면 3번을 수행하세요. `reason: "gateway_older"`이면 daemon 쪽이 오래된 것이라 재연결해도 같은 daemon에 다시 붙을 뿐입니다. 한가할 때 `acp-gateway-admin shutdown_if_idle`로 daemon을 재시작하면(작업이 진행 중이면 거부하므로 나중에 다시 시도) 다음 `agent-acp` 호출이 프론트 도어 버전으로 daemon을 띄웁니다. `acp-gateway-bootstrap --update`는 스크립트가 사라졌거나 더 오래된 Gateway를 고정 경로로 가리키는 관리 중인 `agent-acp` 항목을 현재 설치본을 가리키도록 다시 등록합니다. 단, 그 항목이 이 installer가 등록한 바로 그 항목임이 입증될 때만 그렇게 합니다. 1.7.2부터 설치 상태에 등록할 때마다 그 실행 정보(command와 args)와 환경 변수 이름을 기록하며, 항목이 여전히 정확히 그것을, 정확히 그 환경 변수들로 실행해야 합니다. 그 변수에 Control token과 Main ID가 들어 있다면(1.8.0 이전에 등록한 항목) 값도 `install.json`에 있는 것과 같아야 합니다. 다음 두 가지 차이는 installer 자신이 만든 것이므로 그래도 installer의 항목으로 봅니다. token이나 Main ID 변수가 사라진 경우(항목을 다시 쓴 뒤 기록하기 전에 실행이 멈춘 경우)와, `install.json`이 기본 경로에 있지 않을 때 `ACP_GATEWAY_INSTALL_STATE`가 정확히 이 설치본의 `install.json`을 가리키는 경우입니다. 그 밖에 env가 바뀐 항목(`HTTP_PROXY`나 `NODE_OPTIONS` 같은 변수를 추가했거나, 변수를 지웠거나, token이나 Main ID가 다른 경우)은 교체하면 그 변경이 사라지므로 경고와 함께 그대로 둡니다. 1.7.2 이전에 등록한 항목에는 이 기록이 없고, 사용자가 직접 가리켜 둔 이전 Gateway 설치본과 구별할 방법도 없으므로 자동으로는 절대 옮기지 않습니다. 이미 이 설치본을 실행하는 항목이 아니면 경고와 함께 그대로 두며, `--force`로 한 번 다시 실행하면 다시 등록하고 실행 정보를 기록합니다. 그 뒤로는 `--update`가 알아서 옮깁니다. 이 확인을 통과하지 못한 항목은 경고와 함께 그대로 두고, `--force`로 다시 등록할 수 있습니다. 다른 앱이 관리하는 symlink를 거치는 항목도 그대로 두고, 더 오래된 Gateway로 이어지거나 링크가 끊겼거나 그 뒤에 스크립트가 없으면 경고만 남깁니다. agent CLI에는 원자적인 교체 명령이 없으므로, installer는 항목을 지우기 전에 그 command·args·env를 읽어 둡니다. 그 뒤 새 항목을 추가하지 못하면 이전 항목을 원래 모습 그대로 되돌립니다. 1.8.0부터는 `--rotate-token`에서도 마찬가지입니다. 어떤 항목에도 새 token을 넣지 않으며, 실패한 교체는 `install.json`에 이전 식별 정보를 그대로 둡니다([Control 식별 정보와 token 교체](#control-식별-정보와-token-교체) 참고). 정확히 되돌릴 수 없는 항목(예: CLI가 env를 알려 주지 않는 경우)은 업데이트가 지우지 않고 경고와 함께 그대로 두며, `--force`를 주면 그래도 교체합니다.

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
| `--rotate-token` | `install.json`에 보관한 Control token과 오케스트레이터 식별자(Main ID) 교체([Control 식별 정보와 token 교체](#control-식별-정보와-token-교체) 참고) |
| `--force` | 관리하지 않던 항목 또는 사용자가 수정한 관리 skill을 명시적으로 교체 |
| `--agent-auto-update on\|off` | ACP agent/adapter 자동 업데이트 설정 후 daemon 재시작 |
| `--agent-update-notifications on\|off` | health check 업데이트 알림 설정 후 daemon 재시작 |

Skill은 Codex `~/.codex/skills`, Claude `~/.claude/skills`, Grok `~/.grok/skills`, Auggie `~/.augment/skills`에 설치합니다. 별도 경로가 알려지지 않은 registry provider는 공용 `~/.agents/skills`를 사용합니다. 같은 공용 경로를 사용하는 provider가 여러 개면 skill 파일은 한 번만 복사하고 installer 상태에는 각 provider를 모두 기록합니다.

v1.8.0부터 `install.json`은 한 번에 installer 실행 하나만 바꿉니다. 이 파일을 바꾸는 실행(Control·Guide MCP나 skill을 설치하거나 업데이트하는 실행, token을 교체하는 실행, agent 업데이트 정책을 설정하는 실행. dry run과, adapter 설치나 agent 발견만 하는 실행은 해당하지 않으며 daemon 자신의 adapter 업데이트가 바로 그런 실행입니다)은 파일을 읽기 전부터 마지막으로 쓸 때까지 그 옆의 잠금 파일 `install.json.lock`을 잡습니다. 그동안 시작한 두 번째 실행은 잠금을 잡은 실행의 pid를 알리며 곧바로 실패하므로, 그 실행이 끝난 뒤 다시 실행하세요. 이전에는 두 실행이 각자 자기 사본으로 파일을 통째로 다시 써서, 마지막에 쓴 쪽이 다른 실행이 등록한 항목을 installer 기록에서 빠뜨렸고, 이후 업데이트는 그 항목을 자기 것으로 보지 않았습니다. 비정상 종료한 실행이 남긴 잠금은 다음 실행이 넘겨받습니다.

Control·Guide MCP 등록은 Codex, Claude, Grok, Auggie를 지원합니다. 기본 `--install-all`에서 Control은 사용자가 프론트 도어로 선택한 Codex·Claude·Grok 중 하나에만 등록되고, Guide와 skill은 발견된 지원 agent 전체에 설치됩니다. `--target`은 고급 수동 대상 지정 용도로 유지됩니다. Control MCP는 Gateway 전체 제어 권한이 있으므로 신뢰하는 로컬 agent에만 설치하세요. v1.8.0부터 이 항목에는 token이 들어 있지 않지만(아래 참고), 자기 도구로 Gateway를 거치지 않고 파일을 읽는 Worker(Codex는 `read_only`에서도 그렇게 읽는 것을 확인했습니다)는 여전히 `install.json`에서, 또는 이전 installer가 써서 아직 token이 남아 있는 항목에서 token을 읽어 Main처럼 행동할 수 있습니다. 이런 Worker에게 신뢰할 수 없는 자료를 맡기기 전에 [권한 정책](../README.ko.md#권한-정책)을 확인하세요. Worker 자신의 agent CLI가 사용자 설정에서 Control MCP를 불러올 수도 있습니다(Codex Worker는 `~/.codex/config.toml`을 읽습니다). v1.8.0부터 이 서버는 Worker의 프로세스 트리 안에서는 시작을 거부하고 상태 코드 77로 종료하며 stderr에 한 줄을 남깁니다. 그래서 Worker의 CLI가 `agent-acp`를 시작하지 못했다고 보고할 수 있는데, 정상 동작입니다. 자기 자신의 프로세스 정보조차 읽을 수 없는 macOS·Linux 호스트(`/proc`이 없고 `ps`도 없거나 막힌 경우)에서는 Worker와 Main을 구별할 수 없으므로 같은 방식으로 시작을 거부하며, 이때 stderr에는 Gateway Worker 안에서 실행 중인지 판단할 수 없다고 남깁니다. daemon도 어디서 실행 중인지 확인할 수 없는 호출자를 `WORKER_CONTROL_DENIED`("ancestry cannot be verified on this host")로 거부합니다. 이런 호스트에서는 `/proc`이나 `ps`를 쓸 수 있게 되어야 Main이 다시 Control MCP를 쓸 수 있습니다. `/proc`을 `hidepid=1`이나 `2`로 마운트한 Linux 호스트에 SSH로 로그인했을 때의 root 소유 `sshd`처럼, 위쪽에 이 사용자가 볼 수 없는 프로세스가 있다는 것만으로는 Main의 Control MCP가 시작을 거부하지 않습니다. 그 프로세스가 비정상 종료한 daemon이 남긴 잠금 파일(`<socket>.lock`)에 적힌 pid를 이어받았더라도 마찬가지입니다.

공식 registry 원본은 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`이며 `~/.acp-gateway/registry.json`에 24시간 캐시합니다. 발견된 provider 실행 정의는 `~/.acp-gateway/providers.json`에 저장됩니다. `npx`·`uvx` 배포는 registry에 고정된 버전을 설치하고, binary 배포는 이미 설치된 실행 파일을 사용합니다. registry에 등록되지 않은 임의의 AI는 ACP 실행 계약을 안전하게 추론할 수 없으므로 자동 등록하지 않습니다.

### Control 식별 정보와 token 교체

Control token과 오케스트레이터 식별자(Main ID)는 `~/.acp-gateway/install.json`에 권한 `0600`으로 저장되며 반복 설치에서도 재사용됩니다. v1.8.0부터 installer는 이 파일에만 이 값을 보관합니다. Control MCP 항목은 이 값 없이 등록하고, `install.json`이 기본 경로에 있지 않을 때만 `ACP_GATEWAY_INSTALL_STATE`를 넣습니다. Control MCP는 시작할 때 `install.json`에서 이 값을 읽습니다. 항목의 환경 변수에 `ACP_GATEWAY_CONTROL_TOKEN`과 `ACP_GATEWAY_ROOT_ID`가 있으면 여전히 그 값이 우선합니다. agent CLI의 설정에도, 항목을 등록하는 명령줄에도 token이 남지 않습니다. v1.8.0부터 installer는 `install.json`을 쓸 때마다 rename으로 파일을 바꾸고, 바뀌어 나간 이전 파일을 하드 링크가 아직 붙잡고 있으면 그 파일을 비웁니다. 그래서 그 전에 만든 `install.json`의 하드 링크(Worker는 파일을 읽을 수 없어도 하드 링크는 만들 수 있습니다)에는 installer가 실행된 뒤 token도 Main ID도 남지 않으며, `--rotate-token` 여부와 상관없습니다. 다만 installer가 이전 파일을 비울 수 있을 때에 한합니다. 링크를 따라가지 않고 여는 방법이 없는 Windows에서는 비우지 않고, 그 파일을 쓰기용으로 열 수 없을 때도 비우지 않으며, 그런 링크를 Gateway로 읽으면 그 안의 token 때문에 여전히 거부됩니다. rename에 실패한 쓰기는 파일을 그대로 둡니다. 엔진 설정과 상태 snapshot도 같은 방식으로 바꿉니다.

v1.8.0부터 daemon을 띄우는 프론트 도어나 installer는 token과 Main ID를 daemon의 환경 변수가 아니라 stdin으로 넘깁니다. 환경 변수는 같은 사용자의 다른 프로세스가 읽을 수 있기 때문입니다(`ps -E`, `/proc/<pid>/environ`). Windows는 여전히 환경 변수를 씁니다. `ACP_GATEWAY_CONTROL_TOKEN`을 설정해 직접 띄운 daemon은 계속 그 값을 씁니다. 넘겨받기에 실패하면 daemon은 상태 코드 78로 종료하고, 상태 복구 중단 때처럼 그 이유(`DAEMON_IDENTITY_INVALID`)가 Control MCP 연결 오류에 나타납니다. 어느 경우든 daemon은 자기 환경에서 이 값을 지우므로 daemon이 띄우는 프로세스는 이 값을 물려받지 않습니다. daemon 환경의 나머지는 여전히 Worker와 그 터미널에 전달됩니다([권한 정책](../README.ko.md#권한-정책) 참고).

v1.8.0 이전에 등록한 항목은 환경 변수에 token과 Main ID를 가지고 있습니다. `--install-all`, `--install-control`, `--update`, `--rotate-token`은 이런 항목이 [호스트 재연결 절차](#호스트-재연결-절차)의 소유 확인을 통과하면 이 값 없이 다시 등록합니다. 더 오래된 Gateway를 실행하던 항목은 이때 이 설치본을 가리키도록 함께 옮깁니다. 그 밖에 아직 token을 가진 항목, 예컨대 1.7.2 이전에 등록한 항목, 그 뒤 환경 변수가 바뀐 항목, 다른 Gateway 설치본을 실행하는 항목은 경고와 함께 그대로 둡니다. 이때 token이 든 agent 설정 파일을 다른 사용자도 읽을 수 있으면 installer가 그 파일을 `0600`으로 바꿉니다(Grok CLI는 자기 설정을 `0644`로 씁니다). `--force`를 주면 이런 항목도 token 없이 다시 등록합니다. 항목 하나 이상에서 token을 뺀 실행은 마지막에 token 교체를 권하는 경고를 남깁니다. agent CLI의 설정 백업(`*.bak`)처럼 그 전에 만든 사본에는 token이 그대로 남아 있기 때문입니다. installer가 알아서 교체하지는 않습니다. AgenLynk 같은 앱은 읽어 둔 식별 정보를 계속 쓰므로, 새 token이 생기면 접속하지 못하게 됩니다.

token과 Main ID를 교체하려면 순서대로 실행하세요.

```bash
acp-gateway-admin shutdown_if_idle      # 1. 진행 중인 작업이 없을 때 Gateway 중지
acp-gateway-bootstrap --rotate-token    # 2. install.json에 새 식별 정보 기록, health check가 그 값으로 daemon 시작
```

3. **재연결** — 모든 호스트 세션(호스트 재연결 절차의 3번)과 AgenLynk처럼 식별 정보를 보관하는 앱을 다시 연결합니다. 모두 시작할 때 식별 정보를 한 번만 읽었고, 다시 시작한 daemon은 이전 값을 거부합니다.

`--rotate-token`은 새 식별 정보를 `install.json`에 쓰고, 거기서 식별 정보를 읽는 항목은 다시 등록하지 않습니다. installer가 관리하는 Control 항목이 없으면(AgenLynk 같은 앱이 관리하는 설치처럼) 아무 항목도 등록하지 않으며 dry run도 등록을 계획하지 않습니다. `--target`으로 지정한 호스트는 여전히 등록합니다. 아직 token을 가진 항목은 다른 업데이트 때와 마찬가지로 이 installer의 것임이 입증되면 token을 빼고 다시 등록하며, 그렇지 않으면 폐기된 token을 가지고 있어 daemon이 다시 시작하면 더는 쓸 수 없다는 경고와 함께 그대로 둡니다. 항목 하나라도 갱신하지 못한 교체는 확정하지 않습니다. 이때 `install.json`은 실행 중인 daemon과 모든 항목이 함께 쓰는 이전 식별 정보를 그대로 유지하며, 다시 실행하면 교체를 마무리합니다. installer가 다시 쓴 항목은 쓰는 즉시 `install.json`에 기록합니다. 실행 중인 daemon은 자신이 시작할 때 받은 식별 정보만 받아들이므로 1번에서 daemon을 멈춥니다. daemon이 아직 실행 중이거나 그 사이에 이전 식별 정보를 가진 프론트 도어가 daemon을 다시 띄웠다면, 새 식별 정보가 이미 `install.json`에 기록된 상태에서 2번의 health check가 `CONTROL_ACCESS_DENIED`로 실패하고, 새 식별 정보를 읽는 `acp-gateway-admin`으로도 그 daemon을 멈출 수 없습니다. 이때는 `<socket>.lock`에 적힌 pid에 SIGTERM을 보내 daemon을 끝내세요(실행 중인 Worker까지 멈추는 무조건 종료입니다). 그러면 다음 호출이 새 식별 정보로 daemon을 띄웁니다.

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

v1.1.0부터 daemon은 시작 시점과 이후 24시간마다 ACP 공식 registry를 확인합니다. 발견된 `npx`·`uvx` adapter가 새 버전이면 자동으로 설치하고 provider 정의를 갱신합니다. 이미 실행 중인 Worker process는 중단하지 않으며, 새 process나 session부터 갱신된 adapter가 적용됩니다. 직접 설치해야 하는 binary 배포는 자동 교체하지 않고 health 경고로 남깁니다. v1.8.0부터 installer가 실행하는 모든 명령은 이 설치를 포함해 10분이 지나면 멈추고 시간 초과로 보고되며, 출력은 스트림마다 처음과 마지막 512KB만 남기고 그 사이에 생략한 바이트 수를 표시합니다. 업데이트가 아직 진행 중일 때 종료 요청을 받은 daemon은 최대 5초만 기다린 뒤 업데이트를 중단하고(그 `npm`/`uv` 프로세스도 멈춥니다), 이어서 worker를 멈추고 상태를 저장합니다. 다음에 시작할 때 다시 확인합니다. 이런 일이 생기면 daemon이 stderr에 그 사실을 남깁니다.

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

- **GitHub Actions(기본 경로):** 릴리스 태그를 push한 뒤, 그 태그에서 `Publish npm` workflow(`.github/workflows/publish-npm.yml`, 수동 `workflow_dispatch`)를 입력 `version`과 함께 실행합니다. 예: `gh workflow run publish-npm.yml --ref v1.8.0 -f version=1.8.0`. 실행이 `refs/tags/v<version>`에서 시작되지 않았거나, 입력 버전이 `package.json` 버전·`GATEWAY_VERSION`과 다르거나, 패키지 이름이 `acp-gateway-daemon`이 아니거나, checkout한 커밋이 태그의 커밋과 다르면(실행 후 태그를 옮긴 경우 포함) 실패합니다. npm에 이미 있는 버전은 거부합니다. 게시 권한이 없는 job에서 `npm ci --omit=optional`로 설치한 뒤 `npm run ci`와 `npm run smoke:npm`(npm 10·11·12)을 실행하고, `scripts/pack-release.js`로 pack합니다. 이렇게 만든 tarball의 sha256이 smoke test가 설치한 tarball과 다르면 실패합니다. GitHub OIDC 토큰을 요청할 수 있는 유일한 job인 두 번째 job은 저장소 코드를 실행하지 않고, 검증된 그 tarball만 npm 11로 게시합니다(`npm publish --provenance --access public`).
  - 게시는 npm trusted publishing(OIDC)을 사용하며, 저장소에 npm 토큰을 두지 않고 workflow도 토큰을 쓰지 않습니다. npmjs.com의 `acp-gateway-daemon` → Settings → Trusted Publisher에 GitHub Actions를 organization `creverse-ai-lab`, repository `agent_gateway`, workflow filename `publish-npm.yml`, environment 비움으로 등록하고, allowed actions에 `npm publish`를 포함해야 합니다. 2026-09-03 이후 만든 설정은 `npm publish`를 따로 체크하지 않으면 `npm stage publish`만 허용하는데, 이 workflow는 `npm publish`를 실행합니다. 각 항목은 대소문자를 구분하고 저장할 때 npm이 검증하지 않으므로, 값이 틀리면 게시 job의 실패(예: `ENEEDAUTH`, `E404`)로만 드러납니다. workflow 파일 이름을 바꾸면 이 설정을 고칠 때까지 게시할 수 없습니다.
  - trusted publishing이 동작하면 Settings → Publishing access를 "Require two-factor authentication and disallow tokens"로 바꾸세요. trusted publishing은 계속 동작하고, 유출된 토큰으로는 더 이상 게시할 수 없습니다.
  - npm은 공개 GitHub 저장소에서만 provenance를 붙이고 trusted publishing은 GitHub-hosted runner에서만 동작하므로, 저장소가 비공개인 동안에는 이 workflow로 게시할 수 없습니다.
- **로컬 게시:** 릴리스 태그를 깨끗하게 checkout한 상태에서 `npm ci --omit=optional`로 설치하고, 검사를 돌리고, 로그인한 뒤 게시합니다. 패키지는 설치된 `node_modules`를 그대로 번들하며, `npm publish`는 잠긴 production 트리와 정확히 같지 않은 트리를 거부하는 `prepack` 검사(`scripts/pack-release.js`)를 실행하므로 `--ignore-scripts`를 붙이지 마세요. 이 경로로 게시하면 provenance가 붙지 않습니다.

```bash
git clone --branch v1.8.0 https://github.com/creverse-ai-lab/agent_gateway.git
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

v1.3.0부터 poll 기본값이 절약형입니다. 턴이 진행 중일 때 `result`는 자동으로 생략되고(`includeResult: true`로 명시할 때만 포함), 종료 후 poll의 `result.text`에는 누적 transcript가 아니라 **최종 답변 세그먼트**(마지막 작업 경계 이후의 메시지 텍스트)만 담깁니다. 진행 narration은 `includeInspection: true`로 조회합니다. `agent_acp_session` `get`의 `includeTranscript: true`는 메모리에 남은 bounded transcript를 반환하며, overflow된 전체 transcript는 `resultArtifact`를 따라 회수합니다. `cursor`/`toCursor`/`eventTypes`로 보존된 이벤트 이력도 범위 조회할 수 있습니다. v1.8.0부터 `resultBudgetBytes`나 `resultDelivery: "artifact"`로 읽을 때 받는 `textArtifact`는 항상 그 읽기가 돌려주는 텍스트를 담습니다. 턴이 진행 중일 때 받은 것은 그때까지의 transcript를 담고 텍스트가 더 오면 새로 쓰며, 턴이 끝나면 poll, `agent_acp_run`, Task 결과는 최종 답변을 가리킵니다. 이전에는 진행 중인 턴에서 처음 스필한 파일을 그 턴의 나머지 동안과 끝난 뒤에도 다시 내주어, 최종 답변 대신 그 파일이 나갔습니다. 자세한 회수 경로는 `agent-delegator` skill의 "Retrieve the correct result" 표를 따르세요.

인라인 상한을 넘는 데이터는 전부 `~/.acp-gateway/artifacts`의 파일로 스필되고 응답에는 잘린 미리보기와 포인터(경로·바이트 수·완료 여부)가 실립니다 — 4KB(UTF-8)를 넘는 tool 이벤트 payload는 `dataArtifact`, 64KB를 넘는 최종 답변은 `textArtifact`, 메모리 상한(1MB)을 넘는 transcript는 `resultArtifact`. 인라인에는 상한 내 내용만 유지하므로 RAM과 오케스트레이터 컨텍스트가 결과 크기에 따라 늘어나지 않습니다. Artifact는 파일당 100MB·전체 512MB이며, 그중 마지막 1/8(64MB)은 내구성 있는 Task 결과만 쓸 수 있습니다. 그래서 transcript, terminal 출력, tool 이벤트 payload가 공간을 다 써서 완료된 결과에 미리보기만 남는 일이 없습니다. 라이브 세션이 참조하는 파일은 24시간 정리에서 보존됩니다. payload가 스필된 `tool_call_update`를 같은 tool call의 새 update가 대체하면, poll, 구독(live 또는 replay), 세션 `get`이 이미 그 경로를 내준 경우가 아니라면 이전 파일을 바로 지웁니다. 이미 내준 파일은 다른 파일과 함께 보존 기간이 지나면 정리됩니다. v1.8.0부터 Worker는 Gateway의 파일 요청(`fs/read_text_file`, `fs/write_text_file`)으로 artifact를 어떤 이름으로도 읽거나 덮어쓸 수 없습니다. 세션 루트 안에 만든 하드 링크도 마찬가지입니다. 그런 링크가 붙잡고 있는 artifact는 Gateway가 지우기 전에 먼저 비우므로 링크에는 아무것도 남지 않습니다. 동시 미응답 권한·질문 요청은 세션당 64개, 그리고 v1.8.0부터 provider 프로세스 하나의 모든 세션을 합쳐 1024개(승인을 기다리는 쓰기와 터미널 포함)의 안전 상한을 따르며, 큰 설명 chunk는 32MB protocol frame 상한 안에서 그대로 처리합니다. v1.8.0부터 Worker가 이런 요청을 세션의 명령 큐가 받을 수 있는 것(명령 32개, 그리고 Worker의 요청 몫으로 남겨 둔 2개)보다 많이 한꺼번에 보내면, 넘친 요청마다 곧바로 JSON-RPC 오류를 받고, 그 provider 프로세스에서 Gateway가 맡고 있지 않은 세션(그곳에서 열린 적이 없거나 이미 닫힌 세션)에 대한 요청도 마찬가지입니다. 이전에는 그런 요청이 Main이 답할 것이 없는 채로 답을 기다렸습니다. 전송·세션·Main 단위 예산도 `setup().resourceLimits`에 함께 실립니다 — control 연결당 쓰기 큐 4MB와 10초 무진행 상한(worker stdin 쪽 큐는 동시 요청 상한에서 파생), prompt 1MB, 파일 읽기 500KB(바이트 기준, 초과분은 `_meta["acp-gateway/read"]`로 절단을 알림), terminal 출력 10MB, Main당 세션 64개와 처리 완료 inbox 이력 1000건.

### MCP Tasks

Control MCP 서버는 `tools/call`에 MCP Tasks(protocol 2025-11-25)를 지원하며, `tasks.list`·`tasks.cancel`과 함께 `tasks.requests.tools.call`을 선언합니다. `execution.taskSupport`(`optional`)를 가진 도구는 `agent_acp_run` 하나입니다. `task`를 붙여 호출하면 곧바로 `CreateTaskResult`를 돌려주고, 호스트는 그 Task를 `tasks/get`·`tasks/list`·`tasks/cancel`·`tasks/result`로 따라갑니다. `tasks/result`는 일반 `agent_acp_run`이 돌려주는 것과 같은 객체를 돌려줍니다. `task` 없이 호출하면 전처럼 기다렸다가 답합니다. 다른 도구를 task로 호출하면 JSON-RPC 오류 `-32601`(Method not found)로 실패합니다. task 지원을 선언하지 않은 도구 호출에 명세가 정한 답입니다. Gateway가 만들기를 거절한 Task(예: 없는 세션이나 작업 중인 세션)는 Gateway의 메시지를 담은 JSON-RPC 오류로 실패합니다. 이전에는 서버가 `tasks.requests`를 선언하지 않아, MCP SDK가 task로 한 호출을 모두 Gateway에 닿기 전에 거절했습니다(`Server does not support task creation`).

이렇게 만든 Task마다 서버는 그 호스트에게, Task의 상태나 상태 메시지가 바뀔 때 `notifications/tasks/status`를 보냅니다. Worker가 권한이나 답을 요청하면 `input_required`, 그것을 받으면 다시 `working`, 그리고 종료 상태인 `completed`·`failed`·`cancelled`를 정확히 한 번 보내고, 그 뒤로는 그 Task를 따라가지 않습니다. params는 `tasks/get`이 읽는 Task(`taskId`, `status`, `statusMessage`, `createdAt`, `lastUpdatedAt`, `ttl`, `pollInterval`)이며, 명세가 이 알림에서 빼는 `io.modelcontextprotocol/related-task` 메타데이터는 없습니다. 세션이 닫힌 Task도 종료 상태를 알리고, daemon 재시작으로 중단된 Task도 daemon이 다시 뜨면 알립니다(`failed`). 서버는 daemon을 띄우지 않는 자기 연결로 Task를 따라갑니다. task id로 하는 구독(`taskIds`를 준 `subscribe`, [관리 API](management-api.md#replay-and-result-integrity) 참고)은 그 연결이 재연결 뒤에 복원하고, heartbeat는 따라가는 Task를 30초마다(`ACP_GATEWAY_TASK_HEARTBEAT_MS`를 MCP 항목의 환경에 두면 100ms~5분) `task_get`으로 읽어 구독이 전하지 못한 변화를 보냅니다. 따라갈 Task가 없으면 heartbeat도 그 연결도 없고, 이렇게 Task를 만들지 않는 호스트는 Task 알림을 받지 않습니다. 명세상 이 알림은 선택 사항이므로 호스트는 Task의 `pollInterval`에 맞춰 `tasks/get` 폴링도 계속해야 합니다.

## 세션과 데이터

- 상태 파일(schema v5): `~/.acp-gateway/state.snapshot.json`(전체 상태) + `~/.acp-gateway/state.wal.ndjson`(control 전이 로그)
- v1.8.0부터 `~/.acp-gateway/state.json`(v4 형식)은 더 이상 기록하지 않습니다. 남아 있는 파일은 시작할 때 계속 읽어 이전하고, 동기화된 v5 snapshot이 그 내용을 담은 뒤에 지웁니다. 롤백한 1.4~1.7 Gateway도 v5 파일을 읽지만, 큰 Task 결과는 미리보기만 제공합니다(`resultDegraded` 표시). 1.4보다 오래된 Gateway는 상태를 찾지 못하고 빈 상태로 시작합니다. v5 파일은 따로 변환할 필요가 없지만, Control MCP 항목은 다시 등록해야 할 수 있습니다. 1.8 installer가 등록했거나 다시 쓴 항목에는 token이 없고, 1.7.x 프론트 도어는 token을 항목의 환경 변수에서만 읽으므로 그런 항목으로는 시작하지 못합니다. 설치된 패키지를 1.7.x로 되돌린 뒤, 그런 항목을 가진 호스트마다 그 버전의 `acp-gateway-bootstrap --install-control --target <host> --force`를 실행하고 해당 호스트 세션을 다시 연결하세요([호스트 재연결 절차](#호스트-재연결-절차)의 3번). 1.8 installer로는 이 작업을 할 수 없습니다. `--force`를 주어도 token을 다시 넣지 않기 때문입니다. `--force` 없이는 1.7.x installer도 여전히 올바른 스크립트를 실행하는 항목은 그대로 둡니다.
- 상태가 바뀌는 동안 WAL이 켜져 있으면 전체 snapshot은 많아야 약 1초에 한 번 다시 쓰고, WAL 회전과 종료 때도 씁니다. WAL 레코드 자체는 전처럼 즉시 기록합니다. v1.8.0부터 이렇게 쓰는 snapshot은 모두 이전 snapshot을 대체하기 전에 fsync하고, 이름을 바꾼 뒤 그 디렉터리도 fsync합니다. 디렉터리 동기화가 실패하면(입출력 오류) 다른 쓰기 실패와 마찬가지로 그 쓰기가 실패하고, 그 쓰기가 속한 WAL 회전도 실패하며 회전이 옮겨 둔 구간은 남겨 둡니다. 디렉터리 동기화를 아예 지원하지 않는 파일 시스템만 예외입니다. 실패한 snapshot 쓰기는 성공할 때까지 해야 할 일로 남습니다. 다음 쓰기가 새로 시도하며 종료 때의 쓰기도 마찬가지이고, 종료는 그 시도가 성공했는지와 관계없이 상태 파일을 닫습니다. 이전에는 이런 실패 뒤 아무것도 바뀌지 않은 채 종료하면 다시 쓰지 않고 같은 실패를 돌려주며 상태 파일을 닫기 전에 멈춰서, snapshot에만 담기는 변경(세션 넘겨받기 같은 세션 정보, Main 활동)이 저장되지 않았습니다.
- idle resumable 세션은 기본 30분 후 unload
- Gateway가 Worker의 provider 프로세스를 끝낼 때(종료할 때, idle 세션을 unload할 때, adapter 업데이트로 교체된 프로세스가 더는 세션을 맡지 않을 때, provider가 입력을 읽지 않는 등 전송에 실패했을 때)는 SIGTERM을 보내고, 2초 뒤에도 실행 중이면 SIGKILL을 보냅니다. macOS와 Linux에서는 provider가 자기만의 프로세스 그룹에서 실행되고 두 신호 모두 그 그룹 전체에 가므로, `npx` 같은 launcher가 시작한 adapter처럼 provider가 시작한 프로세스도 함께 끝납니다. Windows에서는 provider 프로세스 자체에 보냅니다. Worker가 연 터미널도 같은 방식으로 끝내는데, macOS와 Linux에서는 터미널마다 프로세스 그룹 전체를, Windows에서는 터미널 프로세스 자체를 끝냅니다. v1.9.0부터는 터미널의 명령 자체가 끝난 뒤 그 프로세스 그룹에 남아 실행 중인 것, 예를 들어 셸이 `&`로 백그라운드에 보낸 작업도 여기에 포함됩니다. Gateway는 그런 그룹이 빌 때까지 계속 확인하고, Worker가 터미널을 해제하거나 턴이 취소되거나 세션이 닫히거나 provider가 종료되거나 daemon이 멈추면 그룹에 남은 것을 같은 방식으로 끝냅니다. 비어 있음을 확인한 그룹에는 신호를 보내지 않습니다. 그 id가 그사이 다른 그룹의 것이 됐을 수 있기 때문입니다. 이전에는 명령이 끝난 터미널은 전혀 끝내지 않아서, 그런 작업이 터미널과 세션, daemon보다 오래 실행됐습니다. v1.8.0 이전에는 SIGTERM을 무시하는 provider가 계속 실행됐고, provider가 시작한 프로세스도 마찬가지였습니다. v1.8.0부터 유지 관리와 idle unload는 어떤 provider에서 세션을 열거나 복구하는 동안 그 provider의 프로세스를 모두 그대로 둡니다. 이전에는 provider의 첫 세션이 아직 등록되기 전, 열리는 중에 유지 관리가 그 프로세스를 끝낼 수 있었고, 그러면 그 열기가 실패했습니다.
- v1.8.0부터 provider가 쓰는 어떤 줄도 daemon을 멈추지 않습니다. JSON이지만 Gateway가 처리할 수 있는 JSON-RPC 메시지가 아닌 줄은 버리고, provider 프로세스마다 처음 16개를 그 stderr 끝부분에 기록합니다(provider 시작에 실패하면 이 내용이 보고됩니다). 형식이 잘못됐어도 id가 있는 요청에는 JSON-RPC 오류로 답하며, provider는 계속 실행됩니다. 이전에는 `null` 같은 줄 하나만으로 daemon과 그 위의 모든 세션이 멈췄습니다. provider에게 이미 대기 중인 요청이 있는 id로 보낸 요청(`7`이 대기 중일 때의 `"7"` 포함)도 같은 방식으로 `-32600`으로 답하고 대기 중인 요청이 그 id를 유지하므로, Main의 승인은 Main이 본 요청에만 가고 나중에 같은 id로 보낸 요청에는 가지 않습니다.
- v1.8.0부터 Main이 Worker의 실행·편집 요청에 준 승인은, Main에게 물었을 때 작업 디렉터리에 있던 그 디렉터리에서 실행하는 터미널과, 그때 그 경로에 있던 파일에 대한 쓰기에만 적용됩니다. 그때 파일이 없었다면 그 쓰기는 파일을 새로 만들 수만 있으므로, 그사이 그 경로에 놓인 파일(다른 파일에 대한 하드 링크 포함)에는 쓰지 않습니다. Main을 기다리는 쓰기와 터미널도 같은 조건에 묶이며, 거기서 다른 것을 찾으면 거부되거나 다시 물어봅니다. v1.9.0부터는 파일의 diff를 Main에게 보여 주는 편집 요청을 승인하면 그 승인이 diff에도 묶입니다. 그 파일에 대한 쓰기는 diff를 지금 파일에 순서대로 적용한 결과 그대로 파일을 만들 때만 그 승인으로 통과합니다. 파일 전체가 무엇이었는지 밝히는 diff(`oldText`가 없거나, 그것이 지금 파일 전체인 diff)는 파일을 새 내용으로 바꾸고, 그 밖의 diff는 파일에 한 번 나오는 부분만 바꾸므로, 조각의 새 내용만 파일 전체로 쓴 쓰기는 통과하지 않습니다. 다른 내용은 대기 중인 쓰기로 Main에게 갑니다. Main을 기다리는 쓰기는 내용도 보여 줍니다. 2KiB까지는 전부, 그보다 길면 처음 2KiB를 보여 주고, 전체 내용의 SHA-256을 함께 보여 줍니다(`rawInput.preview`, `rawInput.sha256`). 이전에는 Main이 경로와 크기만 보았습니다. 자세한 내용은 [관리 API](management-api.md#permission-policy-enforcement)(영어)를 참고하세요.
- 터미널은 승인된 디렉터리에서만 시작하며, Worker가 시작 직전에 그 디렉터리를 link로 바꿔치기해도 마찬가지입니다. `/proc`이 있는 Linux에서는 그 디렉터리의 descriptor에서 시작하고, macOS(와 `/proc`이 없는 Linux)에서는 짧은 `/bin/dash` 스크립트가 들어간 디렉터리를 확인한 다음에야 명령을 exec합니다. 이때 디렉터리가 바뀐 터미널은 아무것도 실행하지 않고 상태 코드 75로 종료합니다. 이 스크립트는 터미널의 환경 변수를 그대로 넘기되 이름이 셸 변수 이름이 아닌 변수(내보낸 bash 함수 등)는 빼고 `PWD`와 `OLDPWD`는 설정합니다. bash는 환경 변수에서 코드를 가져오므로 이 스크립트를 다른 셸로는 실행하지 않습니다. `/proc`도 `/bin/dash`도 없는 호스트에서는 예전처럼 디렉터리를 확인한 직후 경로로 터미널을 시작하므로, 그 사이에 바꿔치기하면 명령이 다른 곳에서 실행될 수 있습니다.
- 결과와 이벤트는 기본 24시간 보존
- session resume checkpoint는 기본 7일 보존, Task 핸들의 바이트는 기본 24시간 보존(`ACP_GATEWAY_TASK_RETENTION_MS`)
- 장시간 유지가 필요한 세션은 `pin` 사용. pin은 세션이 열려 있는 동안만 보호하며, 닫힌 pin 세션은 다른 세션처럼 보존 기간이 지나면 정리됩니다.
- 응답 본문, thought, 전체 이벤트 이력은 상태 파일에 영구 저장하지 않음. `ACP_GATEWAY_WAL_INLINE_RESULT_BYTES`보다 큰 Task 결과는 WAL과 같은 형태로 artifact 참조와 짧은 미리보기만 snapshot에 남기므로, 보존된 transcript가 늘어도 snapshot이 커지지 않습니다.
- 인라인 상한을 넘은 결과와 terminal 출력은 `~/.acp-gateway/artifacts`에 임시 저장 후 결과 보존 기간에 맞춰 정리
- control socket은 `ACP_GATEWAY_SOCKET`이고, 기본값은 OS 임시 디렉터리(macOS는 사용자별, 대부분의 Linux는 공유 `/tmp`)의 `acp-gateway-<uid>.sock`이며, 잠금 파일 `<socket>.lock`이 그 옆에 있습니다. daemon은 socket을 권한 `0600`으로 만들며, 그보다 넓은 권한인 순간은 없습니다. v1.8.0부터 client는 같은 사용자가 소유한 socket에만 연결하며, socket이 든 디렉터리부터 파일 시스템 루트까지의 모든 디렉터리도 그 사용자(또는 root)의 것이고 다른 누구도 쓸 수 없어야 합니다(`/tmp`처럼 sticky 비트가 있는 디렉터리는 다른 사용자가 쓸 수 있어도 됩니다). 하나라도 어긋나면 token을 포함해 아무것도 보내기 전에 `SOCKET_UNTRUSTED`로 실패합니다. 디렉터리까지 확인하는 것은 socket의 소유자만 봐서는 중간 디렉터리를 link로 바꿔치기하는 공격을 막지 못하기 때문입니다(`lstat`는 마지막 구성 요소가 symlink면 거부하지만 중간의 symlink는 따라갑니다). Node는 native addon 없이는 연결된 상대 프로세스의 신원을 읽을 수 없으므로, 다른 사용자가 바꿀 수 없는 경로라는 사실이 그 확인을 대신합니다. daemon도 그 경로를 건드리기 전, 즉 잠금 파일을 만들거나 남아 있는 socket을 확인해 지우거나 bind하기 전에 같은 확인을 하고, 다른 사용자가 link로 바꿔치기할 수 있는 곳에 socket을 두는 대신 시작을 거부합니다. 이때 상태 파일이 손상됐을 때처럼 복구 표시 파일(`state.recovery-required`)에 `SOCKET_UNTRUSTED`를 기록하고 상태 코드 78로 종료합니다. 그러니 `ACP_GATEWAY_SOCKET`을 직접 지정한다면 본인이나 root가 소유하고 다른 누구도 쓸 수 없는 디렉터리 안의 경로로 지정해야 합니다(`/tmp` 같은 sticky 디렉터리는 예외). socket이 들어갈 디렉터리 자체가 없을 때는 믿을 수 없는 경로로 보지 않습니다. 그 안에서 실행 중인 daemon이 있을 수 없으므로 `daemon_shutdown`과 `shutdown_if_idle`은 Gateway가 이미 멈춰 있다고(`alreadyStopped`) 답하고, 다른 호출은 daemon을 자동으로 띄웁니다. daemon은 그 디렉터리를 만들지 않으므로 위와 같이 시작을 거부하고, 그 호출은 복구 표시 파일에 기록된 `SOCKET_UNTRUSTED`를 보고합니다. 이 확인은 정규 경로(canonical path) 하나에 대한 것입니다. client와 daemon은 모두 커널이 하듯 link와 `..`를 따라가 socket이 든 실제 디렉터리를 구하고, 그 안의 socket 경로 하나를 확인에도, 연결과 bind에도 씁니다. 설정에 적힌 경로를 그대로 다시 쓰면 그 안의 link를 쓸 때마다 커널이 새로 풀기 때문에, link의 소유자가 확인 뒤에 다른 곳을 가리키도록 바꿔 놓을 수 있습니다. 직접 지정하는 경로는 짧게 두세요. Unix socket 주소에 들어가야 하는 것은 이 정규 경로이고 그 한도는 macOS 103바이트, Linux 107바이트(UTF-8 기준)이며, macOS의 임시 디렉터리 안 경로는 `/private` 아래로 풀리면서 8바이트 길어집니다. 이보다 긴 경로는 `daemon_shutdown`과 `shutdown_if_idle`을 포함해 아무것도 보내기 전에 `SOCKET_PATH_TOO_LONG`으로 실패하고, daemon은 그 경로로는 시작을 거부하며 복구 표시 파일에 `SOCKET_PATH_TOO_LONG`을 기록하고 상태 코드 78로 종료합니다. 전에는 일부 시스템에서 Node가 그런 경로를 잘라 써서, daemon은 다른 경로에서 기다리고 client는 그것을 찾지 못했습니다. 다른 사용자와 함께 쓰는 Linux 호스트에서는 그중 누군가가 기본 경로를 먼저 차지해 Gateway가 시작하지 못하게 할 수 있습니다. 이때는 `$XDG_RUNTIME_DIR/acp-gateway.sock`처럼 본인만 쓸 수 있는 디렉터리의 경로를 `ACP_GATEWAY_SOCKET`으로 지정하되, client가 실행되는 모든 곳(`agent-acp` MCP 항목의 env, 앱, `acp-gateway-admin`, installer)에 지정하세요.
- 시작에 실패했을 때 운영자를 위해 따로 남겨 두는 손상된 상태 파일 사본(`state.wal.ndjson.corrupt-<time>`, `state.snapshot.json.downgraded-<time>` 등)과 `cold` 시작이 따로 옮겨 두는 상태 파일(`<file>.cold-<time>`, 아래 참고)은 파일과 이유별로 최신 3개까지만 남기고, 7일이 지나면 지웁니다. 비정상 종료한 writer가 상태·설정 파일 옆에 남긴 임시 파일은 다음 시작 때 지웁니다.

### 상태·중단·attention

v1.7.0부터 Gateway는 맡긴 작업이 어디까지 왔는지 알려 주므로 오케스트레이터가 짐작할 필요가 없습니다. 어느 것도 대신 취소하거나 다시 실행하지 않습니다.

- **상태 이유와 멈춤 힌트** — 세션 `get`/`list`에 `statusReason`·`statusChangedAt`·`lastWorkerActivityAt`이 나오고, 실행 중인 턴이 `stallHintMs` 동안 아무것도 보내지 않으면 `stallSuspected`가 붙습니다. `setup`은 `sessions_stall_suspected` 경고를 띄웁니다.
- **중단** — Gateway가 끊은 작업에는 `interruption: {reason, executionOutcome, at}`이 붙고(`executionOutcome`은 `not_started` 또는 `unknown`), 결과에 `next` 단계가 담깁니다. v1.7.2부터 `not_started` 판정은 v1.7.2 이후에 만든 작업에만 나올 수 있고, 그 이전에 만든 작업은 이후에 중단되면 `unknown`입니다. 그런 작업에 v1.7.0이나 v1.7.1이 이미 기록한 `not_started`도 `unknown`으로 읽히며, `next`도 그에 맞게 다시 만들어집니다. `agent_acp_session {action: "check"}`는 provider를 띄우지 않고 세션이 `restorable`·`restorable_with_caveats`·`not_restorable`·`unknown` 중 어디에 해당하는지 알려 줍니다.
- **attention** — `agent_acp_inbox {action: "attention"}`은 `needsMain`(대기 중 요청, `attentionStaleMs`가 지나면 `stale`)과 `updates`(작업을 시작한 Main에게 결과가 아직 닿지 않은 종료 작업)를 돌려줍니다. `{action: "ack", taskIds}`는 지정한 작업을 확인한 것으로 표시합니다.
- **작업 기다리기** — v1.9.0부터 Main은 `agent_acp_run {waitMs: 0}`으로 실행을 시작한 뒤, 폴링하는 대신 `agent_acp_wait` 안에서 잠듭니다. 이 호출은 Main이 할 일이 생기면 곧바로 돌아옵니다. 시작한 작업이 끝났을 때(결과가 함께 오고, `agent_acp_run {taskId}`처럼 확인한 것으로 표시됩니다), Worker가 권한이나 답을 요청할 때, 기다릴 것이 없을 때입니다. 그렇지 않으면 아직 실행 중인 작업을 담은 heartbeat로 돌아오고, Main은 다시 호출합니다. 호스트가 포기한 도구 호출은 답을 잃으므로, 잠드는 시간은 프론트 도어가 응대하는 호스트를 따릅니다. Codex는 270초(Codex 0.162.0이 300초에 포기하므로 많아야 280초), Claude Code는 540초, 그 밖의 호스트는 55초이며 그보다 길게 기다리지 않습니다. 호스트의 한도를 바꾼 사용자(Codex는 `~/.codex/config.toml`의 `[mcp_servers.agent-acp]` 아래 `tool_timeout_sec`)는 `agent-acp` 항목의 환경에 `ACP_GATEWAY_WAIT_LIMIT_MS`(1초~10분)를 그 한도보다 조금 작게 둡니다. 진행 상황을 요청한 호스트는 기다리는 동안 20초마다 알림을 받습니다(`ACP_GATEWAY_WAIT_PROGRESS_MS`, 100ms~5분). 호출을 취소하면 기다림만 끝납니다. Main이 이렇게 잠든 동안 AgenLynk 같은 관리 client에는 그 Main이 `active`가 아니라 `waiting_tasks`로 보입니다(`main_list`와 `main_status` 이벤트, [관리 API](management-api.md#waiting-on-tasks-and-main-status)(영어) 참고). heartbeat와 다음 기다림 사이도 마찬가지입니다. heartbeat 뒤에도 Main은 다른 호출을 하기 전까지 최대 60초 동안 `waiting_tasks`로 남습니다.
- **복구해야 하는 세션의 실행** — v1.9.0부터 먼저 복구해야 하는 세션(provider 시작, 이어서 `session/resume`, 각각 최대 30초)에 `agent_acp_run`을 호출하면 복구를 기다리지 않고 곧바로 `taskId`를 돌려주며, MCP Task를 만드는 호출도 마찬가지입니다. 이전에는 복구가 프론트 도어가 그 호출에 주는 30초를 넘길 수 있었고, 그러면 Main은 핸들 없이 오류만 받는데 실행은 그대로 진행됐습니다. 그 뒤 복구에 실패하면 그것이 그 작업의 결과가 되고(Worker의 오류와 그 `errorCode`를 담은 `ok: false`, 세션은 `unavailable`), Worker에게는 아무것도 보내지 않습니다. 프롬프트를 보내기 전에 작업을 취소하면 곧바로 취소되고 아무것도 보내지 않습니다. 자세한 내용은 [Run admission](management-api.md#run-admission)(영어)을 참고하세요.
- **scope** — `agent_acp_session {action: "list"}`와 `task_list`에 `scope: "mine"`을 주면 호출한 Main의 기록만 남깁니다. 호출자 정보를 보내지 않는 프론트 도어(1.6 이전)는 `INVALID_ARGUMENT`를 받습니다. v1.8.0부터는 `scope` 없이도 Main의 목록에 다른 Main의 기록이 나오지 않으며(아래 참고), `scope: "mine"`은 기록된 Main이 없는 기록까지 뺍니다.
- **격리** — 복구가 `maxConsecutiveRestoreFailures`번 연달아 실패하면 `prompt`·`task_prompt`·`run`·`config`는 provider에 연락하지 않고 `SESSION_QUARANTINED`로 실패합니다. `check`, `agent_acp_session_restore`(이 Main의 기존 기록을 그 자리에서 복구하며, provider가 꺼져 있어도 쓸 수 있고, 성공하면 격리가 풀림), `agent_acp_session_open`은 계속 쓸 수 있습니다.

### Main별 분리와 재시작 뒤 복구

v1.8.0부터 Control MCP로 호출하는 오케스트레이터(Main)는 자신이 연 세션과 그 작업·요청·결과, 그리고 기록된 Main이 없는 세션(1.6.0 이전에 열었거나, Main을 밝히지 않는 도구가 연 세션)에만 접근할 수 있습니다. 다른 Main의 세션은 `NOT_SESSION_OWNER`로(그 작업은 `NOT_TASK_OWNER`, 그 inbox 항목은 `NOT_INBOX_OWNER`로) 응답하고 목록에서도 빠지며, `clean`은 호출한 Main의 세션만 닫습니다. AgenLynk, `acp-gateway-admin`, installer의 health check처럼 Main을 밝히지 않는 client와 모든 observer는 여전히 Gateway 전체에 접근합니다. Main ID 단위로 세는 예산(`ACP_GATEWAY_MAX_SESSIONS_PER_ROOT`와 아래 표의 다른 `_PER_ROOT` 상한)은 그 ID를 쓰는 모든 Main이 함께 쓰며, 분리된다고 나뉘지 않습니다. 이 분리는 함께 일하는 에이전트끼리 서로의 작업을 건드리지 않게 하려는 것이며, Control token을 가진 프로세스를 막는 보안 경계는 아닙니다. 전체 계약은 [관리 API](management-api.md#per-main-isolation)(영어)에 있습니다.

Main은 CLI 세션 단위입니다. Claude Code나 Grok 세션 하나, 또는 Codex thread 하나가 Main 하나입니다. 같은 CLI 세션 안에서 프론트 도어만 다시 시작하면 세션을 그대로 유지합니다. 새 대화는 새 Main이며, 세션 id를 보내지 않는 프론트 도어(Auggie, `CLAUDE_CODE_SESSION_ID`가 없는 Claude Code, thread 정보 없이 온 Codex 호출)를 다시 시작한 경우도 새 Main입니다. 이때 이전 세션은 목록에 나오지 않습니다. 중복 세션을 새로 열지 말고 하나씩 되찾으세요.

1. 세션의 `provider`, `acpSessionId`, `cwd`를 찾습니다. `agent_acp_session_open`과 `agent_acp_session_restore` 응답에는 모두 이 값이 들어 있습니다. 없으면 AgenLynk처럼 Gateway의 모든 세션을 보여 주는 화면에서 읽거나, 공개 client로 `caller` 없이 `session {action: "list"}`를 호출하세요. `acp-gateway-admin`에는 세션 목록 기능이 없습니다.
2. 새 Main에서 이 세 값을 그대로 넣어 `agent_acp_session_restore`를 호출합니다. 세션은 이 호출로만 넘어오며, list, get, poll, 구독으로는 넘어오지 않습니다.
3. 복구가 세션을 넘겨받는 것은 이전 Main이 사라진 뒤뿐입니다. 즉 그 Main을 대신해 호출한 Control 연결이 하나도 열려 있지 않고, 그 Main의 구독도 살아 있지 않아야 합니다. 프론트 도어는 호스트가 MCP 연결(stdin)을 닫거나 신호로 멈추면 곧바로 연결을 닫고 종료합니다. v1.9.0 이전에는 호스트가 신호 없이 끝나면 프론트 도어가 연결된 채 남아, 그 프로세스를 강제로 끝낼 때까지 그 Main도 남아 있었습니다. daemon을 다시 시작하면 모든 연결이 끊깁니다. Codex 프로세스 하나는 모든 thread를 연결 하나로 처리하므로, 그 Codex 프로세스가 실행 중인 동안에는 한 thread가 다른 thread의 세션을 넘겨받을 수 없습니다. 이전 Main이 남아 있거나 `cwd`가 맞지 않으면 응답은 계속 `NOT_SESSION_OWNER`입니다.

넘겨받은 세션에는 `openedBy`(새 Main)와 `adoptedFrom`(이전 Main)이 붙습니다. 그 작업과 대기 중인 요청도 함께 넘어오고, 이전 Main이 결과를 받지 못한 완료 작업은 새 Main이 회수할 몫이 되어 `agent_acp_inbox {action: "attention"}`에 나옵니다. 같은 복구를 반복해도 문제없습니다. 넘겨받은 사실은 다음 상태 snapshot에 기록되어 약 1초 안에 디스크에 닿으므로, 그 전에 장애가 나면 세션이 이전 Main에게 돌아갈 수 있고, 그때는 같은 복구로 다시 가져오면 됩니다. 넘겨받은 세션을 닫거나 세션 보존 정리가 지울 때는 이 사실을 먼저 저장하므로, 닫은 직후 장애가 나도 그 작업과 요청이 이전 Main에게 돌아가지 않습니다. 상태 디렉터리가 새 파일을 받지 않는 등의 이유로 이 저장에 실패해도 닫기는 평소처럼 응답하고 Worker의 세션도 끝내지만, Gateway는 넘겨받은 사실을 저장할 때까지 그 세션을 닫힌 상태로 남겨 둡니다. 그동안 `agent_acp_setup`은 persistence를 unhealthy로 보고하고, 그 세션에는 더 이상 프롬프트를 보내거나 설정을 바꿀 수 없으며, 다음 유지 관리(기본 5분마다)나 닫기, clean이 그 사실을 저장하고 세션을 지웁니다. 그 전에 장애가 나면 세션이 이전 Main에게 돌아갈 수 있으며, 그때는 같은 복구로 작업과 요청까지 함께 다시 가져오면 됩니다. `agent-delegator` skill도 Main에게 같은 절차를 안내합니다.

### 내구성과 복구

Task 생성과 결과 확정은 응답을 반환하기 전에 WAL에 append + fsync합니다. 즉 Main이 받은 Task 핸들은 daemon이 죽어도 남아 있고, 재시작 후 미완 Task는 `failed`(재시작 메시지)로 확정됩니다. v1.7.0부터는 `interruption`도 함께 붙습니다(아래 참고). 나머지 전이(permission·질문 기록, 세션 등록/종료, 상태 변경)는 5ms group commit입니다. v1.7.2부터는 세션 복구 실패(실패 횟수, 격리, `lastRestore`)와 실패 연속을 끝내는 복구 성공도 응답을 반환하기 전에 fsync하므로, 장애가 나도 격리가 풀리거나 복구 성공으로 풀린 격리가 되살아나지 않습니다. 이 동기화 쓰기가 실패해도 복구 결과는 그대로지만 그 사실을 알립니다. persistence가 불건강 상태가 되고, `setup`에 `STATE_RESTORE_NOT_DURABLE` 경고가 나타나며(다음 write가 성공해도 사라지지 않음), 복구 응답에는 `durability: { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" }`가 붙습니다(복구가 실패했다면 오류의 `details.durability`에 붙음). `ACP_GATEWAY_WAL_INLINE_RESULT_BYTES`보다 큰 Task 결과는 artifact에 쓰고 WAL 레코드는 그 참조를 기록합니다. v1.8.0부터는 이 artifact를 쓰지 못하거나(artifact 할당량이나 디스크가 가득 참) 쓴 뒤 그 디렉터리를 동기화하지 못해(입출력 오류. 디렉터리 동기화를 아예 지원하지 않는 파일 시스템은 해당하지 않음) WAL에 결과의 미리보기만 남으면, 이어지는 확정 기록이 그 사실을 지우지 않고 알립니다. 결과 전체를 담은 다음 상태 snapshot이 기록될 때까지(보통 약 1초 안) persistence가 불건강 상태로 남고, `task_result`와 `agent_acp_run`은 결과 전체와 함께 `durability: { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" }`를 돌려줍니다. 그 전에 장애가 나면 Task는 미리보기만 가진 채 돌아옵니다(`resultDegraded`). macOS에서 Node는 `F_FULLFSYNC`를 노출하지 않으므로 `fsync(2)`만 사용합니다 — 프로세스 비정상 종료는 완전히 보호되고, 전원 손실은 group commit 창(기본 5ms)만 노출됩니다.

v1.8.0부터 디스크가 가득 차는 등으로 실패한 WAL append는 로그를 그대로 둡니다. 로그를 마지막 온전한 레코드까지 잘라 되돌리고 그 레코드의 순번은 다음에 기록되는 레코드가 이어받으므로, 재시작은 로그 중간에서 순번 공백이나 손상된 레코드를 만나지 않습니다. 잘라 되돌리지 못한 로그는 WAL 회전으로 교체될 때까지 레코드를 더 받지 않고 persistence도 불건강 상태로 남으며, 이 회전은 다음 상태 write가 곧바로 시작합니다. 회전은 snapshot을 먼저 쓰고 동기화한 뒤 로그를 교체합니다. 상태가 바뀌는 동안 약 1초에 한 번 쓰는 것을 포함해 모든 snapshot은 이전 snapshot을 대체하기 전에 fsync하므로, 전원이 끊겨도 로그가 replay될 기반으로 깨진 snapshot이 남지 않습니다. 상태 디렉터리는 두 번째 Gateway(`STATE_DIR_LOCKED`)와 같은 프로세스 안의 두 번째 상태 저장소를 막도록 잠그며, 죽은 Gateway가 남긴 잠금은 동시에 시작하는 두 Gateway가 함께 차지할 수 없도록 회수합니다. 다만 서로 다른 소켓의 Gateway 셋 이상이 그런 잠금을 두고 동시에 시작하면 드물게 함께 차지할 수 있습니다. 잠금 파일로는 이를 배제할 수 없고, Node에는 이를 막을 OS 파일 잠금이 없습니다. 그래서 v1.9.0부터 Gateway는 WAL 쓰기 묶음, WAL 회전, snapshot마다 그 전에 잠금이 아직 자기 것인지 확인하고, 잠금이 남아 있지 않으면(상태 디렉터리가 지워진 경우 등) 다시 만듭니다. 다른 Gateway의 잠금을 발견한 Gateway는 재시작할 때까지 상태를 더 쓰지 않습니다. persistence는 그 Gateway의 pid를 밝히는 오류(`STATE_DIR_LOCKED`)와 함께 불건강 상태로 남고, 새 Task는 `PERSISTENCE_UNHEALTHY`로 실패하며, 종료할 때를 포함해 다시는 snapshot을 대체하거나 WAL을 회전하지 않습니다. 이는 두 번째 writer를 막는 것이 아니라 알아내는 것이므로, 그 직전에 양쪽이 쓴 내용은 재시작 후 남지 않을 수 있습니다. 상태 디렉터리 하나에는 Gateway를 하나만 실행하세요.

상태 파일이 손상되면 daemon은 **빈 상태로 조용히 시작하지 않고** 중단합니다. 이때 `~/.acp-gateway/state.recovery-required`에 이유를 기록하고 exit 78로 종료하며, Control MCP 연결 실패 메시지에 그 내용이 표면화됩니다. 손상된 파일의 사본은 그 옆에 남깁니다(위의 보존 상한 참고). 복구는 명시적으로 선택합니다. v1.8.0부터는 WAL이 이어 가는 snapshot이 없어진 경우(WAL이 순번 1부터 시작하지 않는 경우)도 여기에 해당합니다. WAL 회전은 snapshot이 담은 WAL 구간을 정리하고, `state.json`은 더는 쓰지 않으므로 그 구간이 기록한 내용은 다른 어디에도 없습니다. daemon은 그 내용 없이 WAL만으로 시작하고 아무것도 알리지 않는 대신, snapshot에만 있던 레코드를 밝히며 `STATE_SNAPSHOT_CORRUPT`로 중단합니다. 백업에서 snapshot을 되돌려 놓거나 아래의 `snapshot-drop` 또는 `cold`를 선택하세요.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ACP_GATEWAY_WAL` | `on` | `off`면 WAL 없이 critical mutation마다 snapshot을 동기 기록(동일한 내구성 약속, 더 큰 쓰기 비용)하고, 그 밖의 변경은 약 50ms 뒤에 snapshot에 반영. WAL이 켜져 있으면 전체 snapshot은 많아야 약 1초에 한 번 다시 씀 |
| `ACP_GATEWAY_WAL_GROUP_COMMIT_MS` | `5` | 비임계 전이의 group commit 간격 |
| `ACP_GATEWAY_WAL_ROTATE_BYTES` / `_RECORDS` / `_INTERVAL_MS` | `4MiB` / `10000` / `15m` | WAL 회전 조건 |
| `ACP_GATEWAY_WAL_INLINE_RESULT_BYTES` | `4096` | 이 크기를 넘는 Task 결과는 artifact로 분리하고 WAL과 snapshot은 참조 + preview만 기록 |
| `ACP_GATEWAY_FSYNC` | `normal` | `off`는 테스트·임시 볼륨 전용 |
| `ACP_GATEWAY_STATE_RECOVERY` | (없음) | `truncate`: 손상 직전까지 WAL replay 후 시작 / `snapshot-drop`: snapshot을 폐기하고 WAL만으로 복구, 남은 v4 `state.json`이 있으면 그것도 사용(v1.8.0부터 이 파일은 아무도 쓰지 않으므로, 정상 종료 뒤라면 WAL에 남은 것이 없음). snapshot이 없어진 WAL로도 시작하며, `STATE_WAL_TAIL_REPLAYED` 알림이 그 snapshot과 함께 잃은 레코드를 밝힘 / `cold`: 상태를 그대로 읽을 수 없을 때(손상된 snapshot, 손상됐거나 불완전한 WAL, 손상된 v4 파일) 빈 상태로 시작. v1.8.0부터 snapshot, WAL, 회전으로 물러난 WAL 구간(`.rot`), v4 `state.json`을 각각 `<file>.cold-<time>`으로 옮겨 두고 어느 것도 replay하지 않으며, `STATE_COLD_STARTED` 알림이 그 이유와 옮긴 위치를 알림. 이전에는 `cold`여도 빈 상태 위에 WAL과 v4 파일을 replay했고, 손상된 WAL에서는 여전히 중단했음. 어느 파일도 지우기 전에 모든 파일을 복사하고 동기화하므로, 복사나 동기화에 실패하면(디스크가 가득 찬 경우 등) 아무것도 지우지 않고 중단하고, 파일을 지운 뒤 디렉터리 동기화에 실패하면 다음 파일을 지우기 전에 중단함. 지우는 도중에 끊기면 다음 시작은 남은 일부를 상태 전체로 읽지 않고 중단하며, `cold`로 다시 시작하면 마저 끝냄. 온전히 읽히는 상태는 `cold`여도 평소처럼 시작 |
| `ACP_GATEWAY_TASK_RETENTION_MS` | `24h` | Task 레코드와 결과 artifact의 디스크 생존 기간(세션 보존과 독립) |
| `ACP_GATEWAY_MAX_QUEUE_BYTES` | `4000000` | control 연결당 OS+channel 합산 쓰기 예산. HIGH는 전체, NORMAL은 7/8, LOW는 1/2까지 사용. v1.8.0부터 예산 전체보다 큰 응답 하나(`ACP_GATEWAY_MAX_FRAME_BYTES` 이하)도 기다리는 것이 없으면 연결을 닫지 않고 보내며, 그 뒤의 frame은 자기 예산을 그대로 씀. 첫 응답을 보내는 중에 그런 응답이 하나 더 오면 전처럼 연결을 닫음. `subscribe` replay는 이 예산의 절반으로 제한(관리 API 참고) |
| `ACP_GATEWAY_WRITE_TIMEOUT_MS` | `10000` | 이 시간 동안 OS가 한 바이트도 받지 않으면 해당 연결을 닫거나 프로바이더를 종료(SIGTERM을 보내고, 2초 뒤에도 실행 중이면 SIGKILL) |
| `ACP_GATEWAY_MAX_PROMPT_BYTES` | `1000000` | 초과 prompt는 턴을 만들기 전에 `PROMPT_TOO_LARGE`로 거부 |
| `ACP_GATEWAY_MAX_FILE_READ_BYTES` | `500000` | worker의 `fs/read_text_file` 응답 바이트 상한(거부 대신 절단) |
| `ACP_GATEWAY_MAX_TERMINAL_OUTPUT_BYTES` | `10000000` | terminal 출력 버퍼 상한(기존 하드코딩 값과 동일) |
| `ACP_GATEWAY_MAX_SESSIONS_PER_ROOT` | `64` | Main당 동시 세션 상한. 초과 시 `SESSION_LIMIT_EXCEEDED` |
| `ACP_GATEWAY_MAX_INBOX_ITEM_BYTES` | `65536` | worker permission/elicitation 한 건의 보관 바이트 상한 |
| `ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_SESSION` | `524288` | 세션당 pending inbox 합산 바이트 상한 |
| `ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_ROOT` | `4194304` | Main당 pending inbox 합산 바이트 상한 |
| `ACP_GATEWAY_MAX_INBOX_HISTORY_PER_ROOT` | `1000` | Main당 보관하는 처리 완료 inbox 건수. 처리될 때마다 적용(pending은 제거 대상 아님) |
| `ACP_GATEWAY_STALL_HINT_MS` | `300000` | 설정 `stallHintMs`(최소 `10000`). 실행 중인 Worker가 이 시간 동안 아무것도 보내지 않으면 세션 조회에 `stallSuspected`가 붙음. 힌트일 뿐 |
| `ACP_GATEWAY_ATTENTION_STALE_MS` | `600000` | 설정 `attentionStaleMs`(최소 `10000`). Worker 요청이 이 시간 넘게 기다리면 attention 조회와 `setup`이 stale로 표시. 표시일 뿐 |
| `ACP_GATEWAY_MAX_CONSECUTIVE_RESTORE_FAILURES` | `3` | 설정 `maxConsecutiveRestoreFailures`(최소 `1`). 복구가 이 횟수만큼 연달아 실패하면 세션을 격리(`SESSION_QUARANTINED`). provider 시작이 같은 횟수만큼 실패하면 `provider_degraded` 경고 |

persistence가 불건강해지면 **새 Task 생성만** `PERSISTENCE_UNHEALTHY`로 거부합니다(핸들 = 내구성 약속). `session_open`과 직접 `prompt`는 계속 동작하며, 실패 이후에 시작한 write가 성공하면 건강 상태가 회복됩니다. 상태 잠금을 잃은 뒤(위 참고)에는 Gateway를 재시작할 때까지 어떤 write도 성공하지 않습니다. `setup().persistence`에 `mode`, `walSeq`, `walBytes`, `snapshotEpoch`, `fsyncCount`, `lastRecovery`가 함께 보고됩니다.
