# 변경 이력

**한국어** | [English](CHANGELOG.md)

## v1.8.0 변경 사항

Worker와 다른 로컬 프로세스가 Gateway 제어 권한에 닿지 못하게 하고, Main마다 자기 세션만 다루게 하며, 승인을 그 승인이 가리킨 작업에만 묶고, daemon이 상태가 바뀔 때마다 전체 상태를 다시 쓰지 않게 하는 릴리스입니다. API major **1**과 state schema **5**는 유지되며, 새 설정과 새 WAL 레코드 유형은 없습니다. 새 오류 코드는 `WORKER_CONTROL_DENIED`, `SOCKET_UNTRUSTED`, `SOCKET_PATH_TOO_LONG`, `DAEMON_IDENTITY_INVALID`입니다. 일부 동작은 의도적으로 바뀌었으니, 업그레이드하기 전에 **동작 변경**을 먼저 읽어 주세요.

- **agent CLI 설정에서 Control token 제거:**
  - installer는 Control MCP를 `ACP_GATEWAY_CONTROL_TOKEN`과 `ACP_GATEWAY_ROOT_ID` 없이 등록합니다. 항목에는 `install.json`이 기본 경로에 있지 않을 때만 `ACP_GATEWAY_INSTALL_STATE`가 들어갑니다. 프론트 도어는 각 값을 환경 변수에 있으면 거기서(1.8.0 이전에 등록한 항목, 격리된 배포), 없으면 `install.json`에서 읽고, 둘 다 없으면 예전처럼 처리합니다(token은 오류, root id는 `main-<ppid>`). agent CLI의 설정에도, 항목을 등록하는 `mcp add` 명령줄에도 token이 남지 않습니다.
  - installer가 자신이 등록했다고 입증할 수 있는 항목(1.7.2의 소유 규칙)은 그 자리에서, 또는 새 설치본으로 옮기면서 식별 정보 없이 다시 등록하며, 다시 쓴 항목은 즉시 `install.json`에 기록합니다. 자기 것이라고 입증할 수 없는 항목(1.7.2 이전에 등록했거나, 그 뒤 env가 바뀌었거나, 다른 Gateway 설치본을 실행하는 항목)은 경고와 함께 token을 그대로 두며, token이 든 agent 설정을 다른 사용자가 읽을 수 있으면 그 파일을 `0600`으로 바꿉니다(Grok CLI는 자기 설정을 `0644`로 씁니다). `--force`를 주면 이런 항목도 token 없이 다시 등록합니다.
  - 항목에서 token을 뺀 실행은 마지막에 `acp-gateway-bootstrap --rotate-token`을 권하는 경고를 남깁니다. agent CLI의 `*.bak` 백업처럼 그 전에 만든 사본에는 token이 그대로 남아 있기 때문입니다. installer가 알아서 교체하지는 않습니다. AgenLynk 같은 앱은 읽어 둔 식별 정보를 계속 쓰기 때문입니다.
  - `--rotate-token`은 `install.json`의 식별 정보만 바꾸고, 거기서 식별 정보를 읽는 항목은 다시 등록하지 않습니다. 항목 하나라도 갱신하지 못한 교체는 확정하지 않고 `install.json`에 이전 식별 정보를 남기며, 교체에 실패한 항목은 원래 모습 그대로 되돌립니다. 예전에는 되돌린 항목에 새 token을 넣었습니다. AgenLynk 같은 앱이 관리하는 설치처럼 installer가 관리하는 Control 항목이 없으면, 교체는 아무 항목도 등록하지 않고 dry run도 등록을 계획하지 않습니다(`--target`으로 지정한 호스트는 여전히 등록합니다). 예전에는 Codex나 처음 찾은 agent CLI에 Control 프론트 도어를 새로 등록했습니다.
  - `install.json`은 한 번에 installer 실행 하나만 바꿉니다. 이 파일을 바꾸는 실행(Control·Guide MCP나 skill을 설치하거나 업데이트하는 실행, token을 교체하는 실행, agent 업데이트 정책을 설정하는 실행. dry run과 adapter만 설치하는 실행은 해당하지 않으며, daemon의 adapter 업데이트가 바로 그런 실행입니다)은 파일을 읽기 전부터 마지막으로 쓸 때까지 그 옆의 `install.json.lock`을 잡습니다. 그동안 시작한 두 번째 실행은 소비자가 시작한 실행이라도 잠금을 잡은 실행의 pid를 밝히며 곧바로 실패하고, 비정상 종료한 실행이 남긴 잠금은 다음 실행이 넘겨받습니다. 예전에는 두 실행이 각자 자기 사본으로 파일을 통째로 다시 써서, 마지막에 쓴 쪽이 다른 실행이 등록한 항목을 installer 기록에서 빠뜨렸고, 이후 업데이트는 그 항목을 installer 자신의 것으로 보지 않았습니다.
- **daemon 식별 정보를 프로세스 환경 변수에서 제거:**
  - daemon을 자동으로 띄우는 client는 token과 root id를 daemon의 stdin으로 JSON 한 줄에 담아 넘기고, 환경 변수에는 `ACP_GATEWAY_IDENTITY_STDIN=1`만 넣습니다. OS는 프로세스가 시작할 때의 환경 변수를 같은 사용자의 모든 프로세스가 읽을 수 있게 남겨 두고(macOS의 `ps -E`, Linux의 `/proc/<pid>/environ`), daemon의 pid는 `<socket>.lock`에 적혀 있기 때문입니다. 환경 변수에 `ACP_GATEWAY_CONTROL_TOKEN`을 넣어 띄운 daemon(직접 띄우거나, supervisor나 daemon을 직접 띄우는 소비자가 띄운 경우)은 계속 거기서 읽습니다. Windows는 환경 변수를 그대로 씁니다.
  - 줄이 없거나, 늦거나(5초), 너무 길거나(16KiB), 쓸 수 없으면 daemon은 exit 78로 멈추고 recovery marker에 `DAEMON_IDENTITY_INVALID`를 남기며, client가 이를 보고합니다. 받은 줄을 오류에 다시 적지는 않습니다.
  - daemon은 시작할 때 자기 환경 변수에서 식별 정보를 지우고, daemon이 띄우는 모든 프로세스(Worker, 터미널, installer와 adapter 업데이트 명령, `git`, `ps`)는 식별 정보, `ACP_GATEWAY_SOCKET`, Main의 세션 표시가 빠진 환경 변수를 받습니다. 예전에는 자동 adapter 업데이트가 실행하는 npm·uv lifecycle script가 token을 받았습니다.
- **Worker는 Control을 받지 못함:**
  - Gateway는 자신이 띄우는 모든 Worker와 터미널에 `ACP_GATEWAY_WORKER=1`을 붙입니다. Control MCP는 이 표시가 있거나 조상 프로세스 중에 daemon이 있으면(남은 잠금 파일에 속지 않는, 깊이가 제한된 탐색) 시작을 거부하고, 식별 정보를 읽기 전에 stderr에 한 줄을 남기고 77로 종료합니다. 예전에는 `~/.codex/config.toml`을 읽은 Codex Worker가 사용자의 Control MCP를 token과 함께 띄워 `agent_acp_*` 도구를 모두 쓸 수 있었습니다.
  - daemon은 `caller.pid`가 daemon 자신이나 daemon이 띄운 provider·터미널이거나 그 아래에서 실행 중인 control 요청을 아무것도 실행하기 전에 `WORKER_CONTROL_DENIED`로 거부합니다. daemon이 pid 1인 경우(컨테이너 entrypoint)에는 프로세스 트리를 거슬러 올라가는 탐색이 pid 1에서 멈춰 daemon과 대조되지 않지만, daemon이 띄운 프로세스까지 대조하므로 이때도 Worker를 가려냅니다. 그 pid는 프로세스를 띄운 순간부터 끝날 때까지 대조 대상에 있습니다. 그사이 Gateway가 그 프로세스를 어떻게 다뤘든(시작에 실패했든, adapter 업데이트나 전송 오류 뒤 새 프로세스가 그 자리를 대신했든, SIGTERM을 무시하는 프로세스를 끝내는 중이든) 마찬가지입니다. 프로세스가 끝나면 바로 빠지므로 나중에 같은 번호를 받은 프로세스는 거부되지 않습니다. 호출자 pid를 보내지 않는 연결(관리 client)에는 영향이 없습니다.
  - macOS와 Linux에서 프로세스 정보를 전혀 읽을 수 없는 환경(`/proc`이 없고 `ps`도 없거나 막힌 경우)에서는 Worker가 Main 행세를 하지 못하도록 양쪽 모두 거부합니다. 이런 환경에서는 자기 프로세스조차 읽지 못하는 Control MCP가 Gateway Worker 안에서 실행 중인지 판단할 수 없다는 한 줄을 stderr에 남기고 77로 종료하며, daemon은 어디서 실행 중인지 확인할 수 없는 호출자를 `WORKER_CONTROL_DENIED`("ancestry cannot be verified on this host")로 거부합니다. `/proc`을 `hidepid=1`이나 `2`로 마운트한 호스트에 SSH로 로그인했을 때의 root 소유 `sshd`처럼 이 사용자가 볼 수 없는 프로세스에서 탐색이 끊기면 그 위에 daemon이 없는 것으로 보므로, 그런 Main은 정상적으로 시작합니다. daemon 잠금 파일(`<socket>.lock`)에 적힌 pid는 그 명령줄이 daemon을 실행할 때, 또는 명령줄을 읽을 수 없고 Control MCP가 자기 프로세스조차 읽지 못할 때만 daemon으로 봅니다. daemon은 같은 사용자로 실행되고 `hidepid`는 그 사용자의 프로세스를 숨기지 않으므로, 남은 잠금 파일의 pid를 그렇게 보이지 않는 프로세스가 이어받았더라도 그 Main은 거부되지 않습니다. `/proc`도 `ps`도 없는 Windows는 `ACP_GATEWAY_WORKER` 표시와, 호출자 pid가 daemon 자신이나 daemon이 띄운 프로세스인지에 기댑니다.
  - `session_open`과 `session_restore`는 env에 Control 식별 정보나 `ACP_GATEWAY_INSTALL_STATE`를 설정하거나, command·args가 Control bin을 실행하거나 Gateway의 `src/index.js`(설치된 runtime 경로 포함)로 이어지는 Worker MCP 서버도 거부합니다. filesystem 서버에 넘긴 `acp-gateway`라는 이름의 checkout처럼 bin과 이름만 같은 디렉터리는 해당하지 않습니다.
- **Main별 분리:**
  - `caller`가 있는 control 요청(프론트 도어 Main)은 그 Main의 세션과 그 작업·inbox 항목, 그리고 기록된 Main이 없는 기록에만 닿습니다. 다른 Main의 기록은 `NOT_SESSION_OWNER`, `NOT_TASK_OWNER`, `NOT_INBOX_OWNER`로 응답하고 목록, attention, setup 경고, 구독에서 빠지며, `clean`은 호출한 Main의 세션만 닫고, 호출자가 볼 수 없는 작업으로의 연결은 작업 조회에서 빠집니다. `session {action: "clean"}`은 세션을 지정하지 않으므로 `sessionId`가 필요 없고, 함께 보낸 `sessionId`는 아무것도 바꾸지 않습니다. 예전에는 `sessionId` 없이 보낸 `clean`이 실패했습니다. `caller`가 없는 요청(AgenLynk, `acp-gateway-admin`, installer health check, 1.6 이전 프론트 도어)과 observer는 root 전체에 그대로 접근합니다.
  - 새 식별 정보로 돌아온 Main(새 CLI 세션, 또는 세션 id를 보내지 않는 프론트 도어를 다시 시작한 경우)은 이전 Main에게 살아 있는 control 연결이나 구독이 남아 있지 않을 때, `provider`·`acpSessionId`·`cwd`를 지정한 `agent_acp_session_restore`를 명시적으로 호출해 이전 세션을 되찾습니다. 세션의 작업과 inbox 항목도 함께 넘어오며, 세션 응답에는 `adoptedFrom`이 붙습니다. 넘겨받은 사실은 다음 snapshot에 저장되며, 넘겨받은 세션을 닫거나 보존 정리가 지울 때는 이 사실을 먼저 저장합니다.
  - observer 접근과 마찬가지로, token을 가진 프로세스를 막는 인증 경계는 아닙니다.
- **승인은 작업을 밝히고 그 작업에만 적용:**
  - Main의 응답을 기다리는 `terminal/create`나 `fs/write_text_file`은 `Run: <command line>`과 `rawInput: {command, args, cwd, env}`, 또는 `Write <path> (<n> bytes)`와 `locations`, `rawInput: {path, bytes}`로 보입니다. `env`의 각 항목은 무엇이 실행될지를 좌우하는 변수이면 `{name, value}`이고, 나머지는 `{name}`뿐입니다. 나머지의 값은 자격 증명일 수 있기 때문입니다(대기 중인 요청은 저장됩니다). 무엇이 실행될지를 좌우하는 변수는 명령줄이 참조하는 변수(`$NAME`, `${NAME}`)와, loader·인터프리터·shell·흔한 도구가 코드를 불러오거나 실행하게 하는 변수입니다. `PATH`, `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `GCONV_PATH`, 모든 `DYLD_*`, `PYTHONPATH`·`PERL5OPT`·`RUBYOPT`·`NODE_OPTIONS`·`NODE_PATH`·`JAVA_TOOL_OPTIONS`·`CLASSPATH` 같은 인터프리터 경로와 옵션, `BASH_ENV`·`ENV`·`ZDOTDIR`·`PROMPT_COMMAND`·모든 `BASH_FUNC_*` 같은 shell 시작 파일과 hook, `HOME`과 `XDG_CONFIG_HOME`, git의 `GIT_DIR`·`GIT_SSH_COMMAND`·`GIT_CONFIG_*`와 git이 실행하는 프로그램, 그리고 `EDITOR`·`VISUAL`·`PAGER`·`LESSOPEN`이 여기에 속하며, 전체 목록은 Management API에 있습니다. 이름이나 값이 문자열이 아닌 `env` 항목은 Main에게 묻기 전에 거부합니다. 예전에는 Main에게 메서드 이름만 보였습니다.
  - Worker의 `execute` 요청을 승인하면 터미널 하나가 통과합니다. argv가 단어 하나하나까지 같고 작업 디렉터리도 같아야 하며, 환경 변수도 요청이 지정한 것과 이름과 값이 모두 같고 그 밖의 것은 없어야 합니다. 작업 디렉터리에는 Main에게 물었을 때 그곳에 있던 디렉터리가 장치·inode 번호까지 그대로 있어야 합니다. Main이 결정하는 동안을 포함해 그 뒤 그 경로에 다른 디렉터리가 놓였다면 Main에게 다시 묻고, 그때 그 경로에 디렉터리가 없었어도 마찬가지입니다. 명령줄 문자열은 평범한 단어로만 이루어진 경우에 한해 그 단어들을 argv로 삼습니다. shell 문법, 단어 전체를 감싸지 않는 따옴표, 닫히지 않은 따옴표, `#`, 공백·탭이 아닌 다른 공백 문자가 하나라도 있으면 아무것도 통과시키지 않습니다. 그래서 `sh -c` 스크립트, 로그인 shell, 리터럴 argv는 서로를 대신할 수 없고, 간접 확장이나 산술 확장(`${!NAME}`, `$((…))`)을 쓰는 명령은 승인으로 통과하지 않습니다.
  - `edit`·`delete`·`move` 요청을 승인하면 그 요청이 가리킨 파일마다(Main에게 물을 때 해석한 파일) 쓰기 한 번이 통과하는데, 그 경로에 그때 있던 일반 파일이 장치·inode 번호까지 그대로 있거나, 그때 파일이 없었다면 지금도 없을 때만입니다. 그 뒤 파일이 바뀐 경로(다른 파일에 건 하드 링크로 바뀐 경우 등)나 그 뒤 파일이 놓인 경로에 대한 쓰기는 Main에게 다시 묻습니다. 모든 쓰기는 요청이 들어왔을 때 해석한 정규 경로, 즉 Main에게 보여 준 대상에 묶입니다. Main이 결정하는 사이에 Worker가 링크를 다른 곳으로 돌리거나 파일을 바꿔 넣으면 승인된 쓰기는 거부되고, 아무것도 쓰거나 비우지 않습니다. 요청이 들어왔을 때 파일이 없던 경로에 대한 쓰기는 파일을 새로 만들기만 하므로(`O_EXCL`), 그사이 그 경로에 놓인 파일은 다른 파일에 건 하드 링크든 링크든 열지도 비우지도 않습니다. 예전에는 그런 파일에 썼습니다.
  - 터미널도 같은 방식으로 Main에게 보여 준 정규 작업 디렉터리와 그곳에 있던 디렉터리에 묶입니다. Main이 결정하는 사이에 Worker가 `cwd`의 링크를 다른 곳으로 돌리거나 그 경로에 다른 디렉터리를 넣으면 승인된 터미널은 거부되고 아무것도 실행되지 않으며, 오류에는 승인된 디렉터리만 나옵니다.
  - 시작 자체도 경로가 아니라 그 디렉터리에 묶이며, Main을 기다린 터미널이든 승인으로 통과한 터미널이든 자동 승인된 터미널이든 모두 같습니다. 그래서 Worker가 시작 직전에 디렉터리 이름을 바꾸고 그 경로에 링크를 넣어도 명령을 다른 곳으로 옮길 수 없습니다. `/proc`이 있는 Linux에서는 장치·inode 번호로 확인한 그 디렉터리의 descriptor(`/proc/self/fd/<fd>`)에서 명령을 시작하므로, 그때 디렉터리 이름이 무엇이든 그 디렉터리에서 실행됩니다. 그 밖의 환경(macOS, `/proc`이 없는 Linux)에서는 터미널을 짧은 고정 `/bin/dash` 스크립트로 시작합니다. 이 스크립트는 디렉터리로 들어간 뒤 지금 있는 디렉터리를 그 장치·inode 번호와 비교하고, 일치할 때만 명령을 exec하므로 터미널의 pid, 프로세스 그룹, 종료 상태는 명령의 것 그대로입니다. macOS에서는 이 스크립트가 sandbox 밖에서 실행되어 `sandbox-exec`를 exec합니다. 일치하지 않으면 아무것도 실행하지 않고, 승인된 디렉터리를 밝힌 한 줄을 남긴 채 상태 코드 75로 종료합니다. 이 스크립트는 다른 셸로는 실행하지 않습니다. Worker가 정한 환경 변수를 (macOS에서는 sandbox 밖에서) 읽는데, bash(macOS, Fedora, RHEL의 `/bin/sh`)는 거기서 함수(`BASH_FUNC_<name>%%`)와 `SHELLOPTS`를, 그리고 이를 통해 명령을 가져오기 때문입니다. `/proc`도 `/bin/dash`도 없는 호스트(Fedora, RHEL, Alpine처럼 dash가 기본으로 들어 있지 않은 Linux에 `/proc`도 없는 경우)는 Windows처럼 위의 확인 직후 경로로 터미널을 시작하므로, 그 확인과 시작 사이에 바꿔치기하면 여전히 명령이 다른 곳에서 실행될 수 있습니다.
  - 승인은 턴이 끝나면 사라집니다. 예전에는 어떤 승인이든 같은 종류의 다음 쓰기나 터미널을, 무엇이든 통과시켰습니다.
  - Main을 기다리는 쓰기와 터미널은 쓰지 않는 필드까지 포함해 요청 전체를 세션의 대기 입력 바이트 예산(512KiB)에 포함합니다.
- **Gateway 터미널은 보호 경로에 닿지 못함:**
  - macOS에서 Gateway가 Worker에게 열어 주는 터미널은 보호 경로의 실제 경로에 대한 읽기·쓰기·연결을 막는 profile로 `sandbox-exec` 아래에서 실행됩니다. pid, 프로세스 그룹, 종료 상태, 출력은 명령 자신의 것입니다.
  - sandbox가 없는 환경(Linux, 또는 profile을 적용할 수 없는 `sandbox-exec`)에서 `auto_approve`는 더 이상 터미널을 알아서 실행하지 않고, 하나하나 전체 명령과 함께 Main에게 보냅니다. 쓰기는 계속 자동입니다.
  - `.acp-gateway` 경로 구성 요소가 든 명령 단어가 보호 경로로 이어지지 않으면 자동으로 정하지 않고 Main에게 보냅니다(`read_only`는 여전히 거부). 보호 경로로 이어지는 단어는 예전처럼 거부합니다.
  - `outputByteLimit`이 주어졌지만 1 이상의 유한한 수가 아닌 `terminal/create`는 아무것도 띄우기 전에 거부합니다. 예전에는 숫자가 아닌 값을 주면 터미널 출력이 한없이 쌓였습니다.
  - Gateway가 provider를 멈출 때(종료, idle unload, 교체된 adapter 세대 정리)와 치명적인 전송 오류가 났을 때(frame 상한을 넘는 줄, stdin을 더 읽지 않는 provider) 모두, provider에 SIGTERM을 보내고 2초 뒤에도 실행 중이면 SIGKILL을 보냅니다. macOS와 Linux에서는 provider가 자기만의 프로세스 그룹에서 실행되고 두 신호 모두 그 그룹 전체에 가므로, `npx` 같은 launcher가 시작했고 SIGTERM과 닫힌 stdin을 무시하는 adapter처럼 provider가 시작한 프로세스도 함께 끝납니다. Windows에서는 provider 프로세스 자체에 보냅니다. 터미널도 macOS와 Linux에서는 프로세스 그룹 단위로, Windows에서는 터미널 프로세스 자체를 끝내며 같은 방식으로 SIGKILL로 마무리하고, `stop()`은 정해진 시간 안에서 이들이 모두 끝나기를 기다립니다. 예전에는 provider에 SIGTERM을 한 번만 보냈기 때문에 이를 무시하는 provider는 계속 실행됐고, provider가 시작한 프로세스에는 신호를 보내지 않았으며, `stop()`은 터미널의 명령에도 SIGTERM만 보냈습니다.
- **provider와 Worker 요청:**
  - provider가 쓰는 어떤 줄도 daemon을 멈추지 않습니다. JSON이지만 Gateway가 처리할 수 있는 JSON-RPC 메시지가 아닌 줄(객체가 아니거나, `id`가 문자열도 숫자도 아니거나, `method`가 문자열이 아니거나, `params`가 객체가 아닌 줄)은 버리고, provider 프로세스마다 처음 16개를 그 stderr 끝부분에 기록합니다(provider 시작에 실패하면 이 내용이 보고됩니다). 형식이 잘못됐어도 쓸 수 있는 `id`가 있는 요청에는 `-32600`(method)이나 `-32602`(params)로 답하며, provider는 계속 실행됩니다. 예전에는 `null` 같은 줄 하나만으로 daemon과 그 위의 모든 Main의 세션이 멈췄습니다.
  - Worker 요청의 id는 Worker가 정한 JSON 형식, 즉 문자열이나 정수를 그대로 유지합니다. 이벤트, inbox 항목, `permission_response`, `elicitation_response`는 그 id를 그대로 담고, `permission`과 `answer`는 `requestId`를 두 형식 모두로 받습니다(그 밖의 값은 `INVALID_ARGUMENT`). `"7"`로 보내도 대기 중인 요청 `7`에 답할 수 있습니다. 예전에는 Gateway가 `requestId`를 숫자로 읽었기 때문에, id가 문자열인 권한 요청이나 질문에는 답할 수 없었습니다.
  - Worker가 보낸 요청 중 아직 대기 중인 것(Gateway가 아직 처리하고 있는 요청, 또는 승인을 기다리는 쓰기와 터미널을 포함해 Main을 기다리는 요청)과 같은 id로, 또는 다른 JSON 형식으로 쓰면 그와 같은 값이 되는 id로(`7`이 대기 중일 때의 `"7"`) 보낸 요청에는 `-32600`(`Invalid Request: id is in use by a pending request`)으로 답하며, 그 id와 Main의 답은 대기 중인 요청이 그대로 가져갑니다. 예전에는 Main에게 보여 준 권한 요청과 같은 id로 보낸 터미널이나 쓰기가 그 자리를 차지해, Main이 본 것을 승인하면 다른 작업이 실행됐고, 대기 중인 터미널과 같은 id로 보낸 권한 요청은 끝없이 답을 기다렸습니다.
  - 세션의 명령 큐가 그 순간 받을 수 없는 권한 요청이나 질문(명령 32개, 그리고 Worker의 요청 몫으로 남겨 둔 2개를 넘는 것)에는 곧바로 JSON-RPC 오류(`-32000`, `Session <id> has too many queued commands`)로 답하고, inbox 항목을 만들지 않습니다. 턴의 끝과 provider의 종료는 큐가 얼마나 차 있든 넣습니다. 예전에는 그런 요청을 버렸기 때문에, Main이 답할 것이 없는데도 Worker는 계속 답을 기다렸습니다.
  - provider 프로세스가 맡고 있지 않은 세션(그 프로세스에서 열린 적이 없거나, 이미 닫혔거나 unload된 세션)에 대한 권한 요청이나 질문에는 곧바로 `-32000`(`Unknown ACP session: <id>`)으로 답하며, 세션마다 64개라는 한도에 더해 provider 프로세스 하나의 모든 세션을 합쳐 Main을 기다리는 요청(승인을 기다리는 쓰기와 터미널 포함)이 1024개를 넘게 하는 요청에도 같은 오류로 답합니다. Gateway가 세션을 정리할 때(닫기, unload, 실패한 복구)는 이미 질문과 쓰기·터미널에 답하던 것처럼, 아직 기다리는 권한 요청에도 이제 취소로 답합니다. 예전에는 이런 요청을 답할 Main도 없이 남겨 둔 채 Worker가 끝없이 기다렸고, 세션 id는 Worker가 정하므로 남겨 두는 요청 수에도 한도가 없었습니다.
  - `cancel`은 자신이 취소하는 prompt를 앞지르지 않습니다. 입력을 읽지 않는 provider 때문에 Gateway의 큐에서 아직 기다리는 prompt는 거둬들이므로 worker에게 가지 않고, 턴은 `cancelled`로 끝나며 `session/cancel`도 보내지 않습니다. 이미 보낸 prompt에는 그 뒤에 `session/cancel`을 보냅니다. 예전에는 cancel이 먼저 나가 멈출 턴을 찾지 못하고, 그 뒤에 도착한 prompt가 Main이 취소한 턴을 실행하는데도 기록에는 취소된 것으로 남을 수 있었습니다.
  - Grok sandbox profile은 `.grok` 안에 새 파일로 써서 동기화한 뒤 `sandbox.toml` 위로 이름을 바꿔 놓습니다. 그래서 `sandbox.toml`이 symbolic link든 하드 링크든 링크라면 링크 자체가 바뀌고, 링크가 가리키던 파일에는 쓰지도 비우지도 않습니다. `.grok`까지 가는 모든 디렉터리는 실제 디렉터리이거나 이 사용자의 어떤 프로세스도 만들 수 없었던 symbolic link여야 하고, sandbox 디렉터리와 `.grok`은 이 사용자의 것이어야 합니다. 그렇지 않으면 Grok은 문제가 된 구성 요소를 밝히는 오류와 함께 시작하지 않습니다. 예전에는 Worker가 `sandbox.toml`이나 `.grok`을 링크로 바꿔 두면, 다음 Grok 시작이 링크가 가리키는 곳이 `install.json`이더라도 그곳에 profile을 썼습니다.
  - maintenance와 idle unload는 어떤 provider에서 세션을 열거나 복구하는 동안 그 provider의 프로세스를 모두 그대로 둡니다. 예전에는 provider의 첫 세션을 아직 열거나 복구하고 있어 그 프로세스를 참조하는 세션이 하나도 없을 때 maintenance가 그 프로세스를 멈출 수 있었고, 그러면 그 열기나 복구가 실패했습니다.
- **Worker 파일 콜백은 확인한 descriptor로만 처리:**
  - `fs/read_text_file`과 `fs/write_text_file`은 확인한 경로를 한 번만 열고(`O_NOFOLLOW`, macOS에서는 경로 어디에도 symbolic link를 허용하지 않음), 일반 파일인지 확인하고, descriptor가 그 경로의 파일인지(Linux에서는 `/proc/self/fd`까지) 확인한 뒤 그 descriptor로만 읽고, 비우고, 씁니다. 그 사이에 Worker가 링크나 디렉터리를 바꿔 넣거나, 마지막 구성 요소가 끊긴 symbolic link여도 작업을 다른 곳으로 돌릴 수 없습니다. FIFO가 daemon 스레드를 붙잡는 일도 없어졌습니다.
  - `ln ~/.acp-gateway/install.json ./notes`처럼 보호 파일에 건 하드 링크는 읽기든 쓰기든 한 바이트도 읽거나 파일을 비우기 전에 거부합니다. descriptor를 보호 디렉터리 바로 아래의 모든 일반 파일(그곳의 symbolic link는 그것이 가리키는 파일), 그 자체가 파일인 모든 보호 경로, 그리고 Gateway가 보관하는 모든 artifact(아래 참고)와 장치·inode 번호로 대조하기 때문입니다. Gateway가 확인할 수 없는 보호 경로나 파일이 있으면 열기를 거부하며, Linux에서는 `/proc`이 없어서가 아닌 다른 이유로 `/proc/self/fd` 조회가 실패해도 거부합니다.
  - 보호 경로에는 직접 지정해 어디에 두었든 Gateway가 읽는 provider 정의(`ACP_GATEWAY_PROVIDERS`, provider를 시작할 때 그 명령을 실행)와 공식 registry cache(`ACP_GATEWAY_REGISTRY_CACHE`, 설치가 그 package를 받음)도 들어가며, `install.json`, 설정 파일, 상태 파일이 symbolic link이면 그 링크가 가리키는 파일도 정규 경로로 들어갑니다. 예전에는 그런 provider 정의 파일이 루트 안에 있는 Worker가 다음 provider 시작이 실행할 명령을 터미널 확인을 하나도 거치지 않고 바꿔 쓸 수 있었고, symbolic link인 `install.json`이 가리키는 파일이 루트 안에 있는 Worker는 식별 정보를 덮어쓸 수 있었습니다.
  - `fs/read_text_file`은 읽은 텍스트에 daemon이 받아들이는 Control token이 들어 있으면 아무것도 돌려주기 전에 거부하고, 파일에 Gateway 자격 증명이 들어 있다고만 알릴 뿐 내용은 전혀 담지 않습니다. 이름과 inode를 보는 검사로는 루트 안에 있는 `install.json`의 복사본이나, installer가 그 파일을 바꿀 때 이전 파일을 비우지 못해 남은 하드 링크(아래 참고)를 알아볼 수 없기 때문입니다.
  - 쓰기는 새 파일을 검사한 디렉터리 안에만 만듭니다. macOS에서는 열기 자체가 경로 어디에 있는 링크든 거부하고, `/proc`이 있는 Linux에서는 그 디렉터리를 열어 둔 descriptor가 검사한 디렉터리인지 `/proc`으로 확인한 뒤 그 descriptor를 거쳐 파일을 만듭니다. 이 descriptor는 디렉터리 자체에 대한 권한이 필요 없는 `O_PATH`로 열므로, daemon이 쓰고 들어갈 수는 있지만 목록은 볼 수 없는 디렉터리(`-wx`)에도 새 파일을 만들 수 있습니다. `/proc`이 없는 Linux와 다른 시스템에서는 쓰기 도중 디렉터리를 링크로 바꿔치기하면 쓰기가 거부되기 전에 그 링크가 가리키는 곳에 빈 파일이 남을 수 있지만, 그 파일에는 아무것도 쓰지 않습니다. 이름으로 지우는 일도 같은 바꿔치기로 다른 곳을 향할 수 있으므로, 거부된 쓰기는 아무것도 지우지 않습니다.
  - Gateway가 보호 디렉터리 안에서 rename으로 바꾸는 파일은, 하드 링크가 이전 파일을 아직 붙잡고 있으면 rename에 성공한 뒤 그 파일을 비웁니다. installer가 쓸 때마다 바뀌는 `install.json`, 엔진 설정과 provider 정의, 상태 snapshot이 그 대상입니다. rename은 파일이 아니라 이름을 바꾸고 link(2)에는 파일 자체에 대한 권한이 필요 없으므로, 그러지 않으면 Worker가 만든 하드 링크를 통해 token이나 상태가 보호 디렉터리 밖의 inode에 계속 남게 됩니다. 이전 파일은 rename 전에 symbolic link를 따라가지 않고 열어 두었다가, rename이 확정된 뒤에만 비웁니다. rename에 실패하면 아무것도 비우지 않으며, 다른 이름이 붙잡고 있지 않은 이전 파일은 그 전에 파일을 연 reader가 끝까지 읽을 수 있도록 그대로 둡니다. 이는 할 수 있는 만큼만 하는 일이어서, Gateway가 쓰기용으로 열 수 없는 파일과, 링크를 따라가지 않고 여는 방법이 없는 Windows의 모든 파일은 비우지 않고 바꾸기만 하며, 그런 링크를 Gateway로 읽으면 그 안의 token 때문에 여전히 거부됩니다. write-ahead log는 이 방식으로 바꾸지 않습니다. 회전은 동기화된 snapshot이 담을 때까지 이전 segment를 남겨 두었다가 지웁니다. 하드 링크가 아직 붙잡고 있는 회전한 segment는 지우기 전에 비우며, Gateway가 지우는 다른 그런 파일(보존 기간이 지난 손상된 상태 파일의 격리 사본, 비정상 종료한 writer가 남긴 임시 파일, 이전한 v4 `state.json`)도 마찬가지이므로 링크에는 아무것도 남지 않습니다.
  - 보호 디렉터리 검사가 보는 곳보다 한 단계 깊이 있는 artifact도 inode로 거부합니다. Gateway는 자신이 쓰거나 시작할 때 찾은 모든 artifact의 장치·inode 번호를 그 파일을 지울 때까지 보관하고, descriptor가 그중 하나인 읽기와 쓰기는 이름이 무엇이든 거부합니다. 하드 링크가 아직 붙잡고 있는 artifact는 지우기 전에 먼저 비우므로, 그 링크에는 아무것도 남지 않습니다.
  - Worker가 가리키는 모든 경로, 승인이 묶인 파일과 작업 디렉터리, 터미널의 작업 디렉터리, 세션 루트는 어휘적으로 먼저 정리하지 않고 곧바로 시스템 realpath로 해석합니다. 링크 뒤의 `..`는 커널이 해석하듯 링크가 가리키는 곳에서 적용되고, 대소문자를 구분하지 않는 macOS 볼륨에서는 경로가 디스크에 있는 대소문자를 따릅니다. 그래서 승인과 그 승인이 다루는 쓰기·터미널, 루트 검사는 Worker가 어떻게 썼든 같은 표기를 비교합니다. Linux에서는 끝에 슬래시가 붙은 파일 경로가 `ENOTDIR`로 실패하고, 모든 시스템에서 `cwd`가 빈 문자열인 터미널은 거부합니다.
- **socket 소유자 확인:**
  - daemon은 umask 177 아래에서 socket을 만들므로, bind한 순간부터 권한이 `0600`입니다.
  - 모든 client는 socket이 든 디렉터리를 커널처럼 link와 `..`까지 따라가 실제 경로를 구하고, 그 뒤로는 이 정규 경로만 씁니다. 연결하기 전에는 그 자리에 socket이 있다면 현재 사용자의 것인지, 그리고 파일 시스템 루트부터 socket이 든 디렉터리까지 모든 디렉터리가 그 사용자나 root의 것이고 다른 누구도 쓸 수 없는지 확인합니다(`/tmp`처럼 sticky 비트가 있는 디렉터리는 예외). 연결한 뒤에는 socket 소유자를 한 번 더 확인합니다. 하나라도 어긋나면 token을 포함해 아무것도 쓰기 전에 `SOCKET_UNTRUSTED`로 실패하고(문제가 된 디렉터리는 `details.dir`), daemon도 띄우지 않습니다. socket 소유자만 확인해서는 다른 사용자가 상위 디렉터리를 자기 socket을 가리키는 link로 바꿔치기해도 알아챌 수 없었습니다. socket이 들어갈 디렉터리 자체가 없으면 믿을 수 없는 경로로 보지 않습니다. 그 안에서 기다리는 daemon이 있을 수 없으므로, client는 아무것도 보내지 않고 socket이 없을 때처럼 daemon이 없는 것으로 봅니다.
  - daemon도 그 경로를 건드리기 전(잠금 파일, 남은 socket 확인과 삭제, bind)에 같은 디렉터리 확인을 하고, 이 모든 작업에 정규 경로를 씁니다. 확인에 실패하면(daemon은 디렉터리를 만들지 않으므로 디렉터리가 없을 때도 포함) recovery marker에 `SOCKET_UNTRUSTED`를 기록하고 78로 종료하며, 이 daemon을 자동으로 띄운 client가 이를 보고합니다.
  - 정규 경로는 Unix socket 주소에 들어가야 합니다. 그 한도는 UTF-8 기준 macOS 103바이트, Linux 107바이트이며, macOS의 임시 디렉터리 안 경로는 `/private` 아래로 풀리면서 8바이트 길어집니다. 일부 시스템은 이보다 긴 경로를 받지 않는데, 그런 곳에서 Node가 경로를 거부하지 않고 잘라 썼기 때문에(macOS 14의 Node 22, 그리고 Linux) daemon은 다른 경로에서 기다리고 client는 아무것도 찾지 못했습니다. 이제 더 긴 경로는 아무것도 보내거나 bind하기 전에 `SOCKET_PATH_TOO_LONG`(`details: {socketPath, canonicalPath, bytes, limitBytes}`)으로 실패합니다. client는 daemon을 띄우지 않고, `daemon_shutdown`과 `shutdown_if_idle`도 `alreadyStopped` 대신 이 오류를 보고하며, daemon은 recovery marker에 이 코드를 기록하고 78로 종료합니다.
  - 기본 경로는 그대로(`<tmpdir>/acp-gateway-<uid>.sock`)이며, macOS의 사용자별 임시 디렉터리와 Linux의 sticky `/tmp`에서 이 확인을 통과합니다. 다른 사용자와 함께 쓰는 Linux 호스트에서는 모든 client에 `ACP_GATEWAY_SOCKET`을 본인만 쓸 수 있는 디렉터리로 지정하세요.
- **결과와 공개 client:**
  - `resultBudgetBytes`나 `resultDelivery: "artifact"`로 읽을 때 받는 `textArtifact`는 항상 그 읽기가 돌려주는 텍스트를 담습니다. 턴이 진행 중일 때 받은 것은 그때까지의 transcript를 담고 텍스트가 더 오면 새로 쓰며, 턴이 끝나면 poll, `agent_acp_run`, Task 결과는 최종 답변을 가리킵니다. 예전에는 진행 중인 턴에서 처음 스필한 파일을 그 턴의 나머지 동안과 끝난 뒤에도 다시 내주어, 최종 답변 대신 그 파일이 나갔습니다.
  - `GatewayRpcClient`는 다시 연결한 뒤 구독을 하나씩 따로 복구합니다. 지정한 세션이 없어졌거나 더 이상 이 Main의 것이 아니어서 daemon이 다시 구독하기를 거부하거나, 제시간에 답이 오지 않은 구독은 `subscription_error` 이벤트(daemon이 준 경우 `errorCode` 포함)와 함께 끝나고, 나머지 구독은 복구됩니다. 예전에는 처음 거부된 구독 뒤의 모든 구독이 정상으로 보이는 연결 위에서 이벤트를 받지 못했고, 어떤 재연결도 이를 되살리지 못했습니다.
  - 연결하는 도중에 `close()`를 부르면 그 연결 시도도 끝납니다. 아무것도 연결하거나 보내지 않고, 그 시도가 연 socket은 없애며, 그 연결을 기다리던 호출은 `Gateway client is closed` 오류로 실패합니다. 예전에는 close 뒤에도 시도가 이어져 연결하고 호출을 보냈으며, 그 socket 때문에 프로세스가 끝나지 못할 수 있었습니다.
- **동작 변경:**
  - Worker와 그 터미널은 여전히 daemon 환경 변수의 나머지를 물려받습니다. 이 환경은 daemon을 띄운 쪽(보통 프론트 도어나 installer)에서 온 것으로, API 키, 클라우드 자격 증명, `SSH_AUTH_SOCK`도 포함합니다. 빠지는 것은 Gateway 식별 정보, socket 경로, Main의 세션 표시뿐입니다. allowlist는 없으므로, 환경 변수로 로그인하는 provider는 계속 동작합니다.
  - Main마다 자기 세션만 봅니다. 새 대화의 Main에게는 이전 세션이 넘겨받기 전까지 목록에 나오지 않습니다. 절차는 `agent-delegator` skill과 운영 가이드에 있습니다. `_PER_ROOT` 예산(세션 64개, 대기 inbox 바이트, inbox 이력)은 여전히 이 기기의 모든 Main이 함께 씁니다.
  - Worker 자신의 CLI가 `agent-acp` MCP 서버를 시작하지 못했다고(exit 77) 보고할 수 있습니다. 거부가 제대로 동작한 결과입니다.
  - macOS의 Gateway 터미널에서는 `ps`, `top` 같은 setuid 프로그램을 실행할 수 없고, 시작하지 못한 명령은 상태 코드 71(`sandbox-exec: execvp() of '<command>' failed`)로 끝납니다. 예전에는 없는 명령이면 프로세스 생성 자체가 실패했습니다.
  - macOS와, `/bin/dash`가 있고 `/proc`은 없는 Linux에서는 Gateway 터미널이 작업 디렉터리를 확인한 뒤 명령을 exec하는 짧은 `/bin/dash` 스크립트를 거쳐 시작합니다. 명령은 터미널의 환경 변수를 받되, 내보낸 bash 함수(`BASH_FUNC_<name>%%`)처럼 이름이 셸 변수 이름이 아닌 변수는 빠지고 `PWD`와 `OLDPWD`는 설정된 채로 받습니다. 시작하는 순간 디렉터리가 바꿔치기된 터미널은 실행되지 않고, 한 줄을 남긴 채 상태 코드 75로 종료합니다. sandbox 밖에서(보호할 경로가 없거나, profile을 적용할 수 없는 `sandbox-exec`) 찾을 수 없는 명령은 상태 코드 127과 셸의 `not found` 줄로, 실행할 수 없는 명령은 126으로 끝납니다. 예전에는 두 경우 모두 프로세스 생성 자체가 실패했습니다.
  - Linux의 `auto_approve` 세션은 Gateway 터미널마다 Main에게 묻습니다. 짧은 명령을 많이 실행하는 Worker라면 그만큼 요청이 생깁니다. 모든 OS에서 `grep -rn ".acp-gateway" src`처럼 `.acp-gateway`를 언급하는 명령은 `auto_approve`에서도 Main에게 묻습니다.
  - execute 승인은 그 승인이 가리킨 argv, 작업 디렉터리, 환경 변수와 정확히 같은 터미널만 통과시킵니다. 같은 명령이라도 다른 형태(argv 대신 shell 스크립트, 로그인 shell, shell 문법이 든 명령줄 문자열)로, 다른 디렉터리에서, 또는 환경 변수를 하나라도 더하거나 빼거나 바꿔 다시 보내면 Main에게 다시 묻고, Main에게 물은 뒤 작업 디렉터리가 같은 경로의 다른 디렉터리로 바뀐 경우도 마찬가지입니다. edit 승인 역시 Main에게 물었을 때 그 경로에 있던 파일에 대한 쓰기만, 그때 파일이 없었다면 파일을 새로 만드는 쓰기만 통과시킵니다.
  - Main을 기다리는 Gateway 터미널은 프로그램이 코드를 불러오거나 실행하게 하는 변수(`PATH`, `PYTHONPATH`, `GIT_SSH_COMMAND`와 위의 나머지)와 명령줄이 참조하는 변수를 이름뿐 아니라 값까지 Main에게 보여 주고, Main에게 보여 준 작업 디렉터리에서만 실행됩니다. 기다리는 사이에 그 디렉터리가 다른 곳을 가리키게 되거나 바뀌면 터미널은 거부되며, Worker가 다시 보내야 합니다. env에 문자열이 아닌 값이 든 `terminal/create`는 거부합니다.
  - 쓰기 요청이 들어왔을 때 파일이 없던 경로에 대한 Worker의 쓰기는 승인을 거쳤든 아니든 파일을 새로 만들기만 합니다(`O_EXCL`). 쓰기가 파일을 열 때 그 경로에 파일이 있으면 쓰기는 실패하며(`Write target changed since it was approved`), Worker가 다시 보내야 합니다.
  - Worker가 `fs/read_text_file`로 Control token이 든 파일(`install.json`의 복사본 등)을 읽으면 루트 안에 있더라도 실패하고, provider 정의와 registry cache, 그리고 symbolic link인 `install.json`, 설정 파일, 상태 파일이 가리키는 파일을 읽거나 쓰는 것도 어디에 있든 실패합니다.
  - `install.json`, 엔진 설정, provider 정의, 상태 snapshot에 건 하드 링크는 installer나 Gateway가 그 파일을 바꾸고 나면 비어 있고(Windows이거나 이전 파일을 쓰기용으로 열 수 없을 때는 예외), artifact에 건 하드 링크는 Gateway가 그 artifact를 지우고 나면 비어 있습니다. Worker가 `fs/read_text_file`이나 `fs/write_text_file`로 artifact를 읽거나 쓰려 하면 이름이 무엇이든 실패합니다.
  - Worker가 가리키는 경로는 커널이 해석하는 대로 해석합니다. `root/link/../x`는 `root/x`가 아니라 `link`가 가리키는 디렉터리의 상위 디렉터리에 있는 `x`입니다. `cwd`가 빈 문자열인 터미널은 daemon의 작업 디렉터리를 기준으로 해석하지 않고 거부하며, Linux에서는 끝에 슬래시가 붙은 파일 경로가 `ENOTDIR`로 실패합니다. 대소문자를 구분하지 않는 macOS 볼륨에서는 Worker가 대소문자를 어떻게 썼든 승인은 자신이 가리킨 쓰기나 터미널을 통과시키고, 세션 루트와 대소문자가 다르게 쓰인 경로도 루트 검사를 통과합니다.
  - macOS와 Linux에서 provider를 끝내면 그 프로세스 그룹에 남은 모든 프로세스도 끝나므로, provider가 시작한 보조 프로세스가 provider보다 오래 남지 않습니다.
  - 세션의 명령 큐가 받을 수 있는 것보다 많은 권한 요청이나 질문을 한꺼번에 보낸 Worker는 넘친 요청마다 곧바로 JSON-RPC 오류(`-32000`)를 받고, id가 있지만 형식이 잘못된 요청에는 `-32600`이나 `-32602`를 받습니다. provider 프로세스가 맡고 있지 않은 세션에 대한 권한 요청이나 질문, 그리고 그 프로세스 전체에서 Main을 기다리는 요청이 1024개를 넘게 하는 권한 요청이나 질문도 곧바로 `-32000`을 받고, 아직 대기 중인 요청과 같은 id로 보낸 요청은 `-32600`을 받습니다.
  - sandbox profile까지 가는 디렉터리 중에 이 사용자가 만들 수 있었던 링크가 있거나 sandbox 디렉터리나 `.grok`이 이 사용자의 것이 아니면 Grok은 시작하지 않으며, 오류에 문제가 된 구성 요소가 나옵니다.
  - `/proc`도 제대로 동작하는 `ps`도 없는 macOS·Linux 호스트에서는 Control MCP가 시작하지 않고, daemon은 pid를 보내는 호출자를 모두 거부합니다. AgenLynk 같은 관리 client는 계속 동작합니다.
  - WAL이 이어 가는 snapshot이 없어진 daemon은 시작을 거부합니다(`STATE_SNAPSHOT_CORRUPT`, exit 78). snapshot을 되돌려 놓거나 `ACP_GATEWAY_STATE_RECOVERY=snapshot-drop`이나 `cold`를 선택하세요. 이제 `cold`는 읽을 수 없는 상태를 WAL까지 모두 버리고, 그 파일은 `<file>.cold-<time>`으로 남겨 둡니다.
  - `ACP_GATEWAY_SOCKET`을 직접 지정했다면 그 경로의 디렉터리가 모두 본인이나 root의 것이고 다른 누구도 쓸 수 없어야 합니다(`/tmp` 같은 sticky 디렉터리는 예외). 그렇지 않으면 client는 `SOCKET_UNTRUSTED`로 실패하고 daemon은 시작을 거부합니다(exit 78). socket이 들어갈 디렉터리 자체가 없으면 `daemon_shutdown`과 `shutdown_if_idle`에는 예전처럼 멈춘 Gateway로 보이고, 그곳에 daemon을 띄우는 호출은 이제 socket이 없다는 오류 대신 daemon이 시작을 거부한 이유(`SOCKET_UNTRUSTED`)를 보고합니다. 그 정규 경로는 macOS에서 103바이트, Linux에서 107바이트를 넘지 않아야 합니다. 이보다 길면 모든 client가 `SOCKET_PATH_TOO_LONG`으로 실패하고 daemon은 그 경로로는 시작을 거부합니다(exit 78). 예전에는 일부 시스템이 그런 경로를 잘라 써서 client가 daemon을 찾지 못했습니다.
  - `install.json`을 바꾸는 installer 실행은 다른 그런 실행이 `install.json.lock`을 잡고 있으면 그 실행의 pid를 밝히며 곧바로 실패합니다. 그 실행이 끝난 뒤 다시 실행하세요.
  - 1.8.0으로 처음 설치하거나 업데이트한 뒤에는 installer가 권하는 대로 token을 교체하세요. 한가할 때 Gateway를 멈추고(`acp-gateway-admin shutdown_if_idle`), `acp-gateway-bootstrap --rotate-token`을 실행한 다음, 호스트 세션과 AgenLynk처럼 식별 정보를 보관하는 앱을 다시 연결합니다. daemon은 시작할 때 받은 식별 정보만 받아들이므로, daemon이 실행 중일 때 교체하면 health check가 `CONTROL_ACCESS_DENIED`로 실패합니다. 이때는 `<socket>.lock`에 적힌 pid에 SIGTERM을 보내 그 daemon을 끝내세요.
- **영속성:**
  - v4 `state.json`은 더 이상 기록하지 않습니다. 남아 있는 파일은 시작할 때 계속 읽어 이전하고, 동기화된 v5 snapshot이 그 내용을 담은 뒤 지웁니다.
  - WAL 회전은 snapshot이 담은 WAL 구간을 정리하고, `state.json`은 더는 쓰지 않으므로 그 구간이 기록한 내용은 다른 어디에도 없습니다. 그래서 WAL이 이어 가는 snapshot이 없어지면(WAL이 순번 1부터 시작하지 않으면) daemon은 그 내용 없이 WAL만으로 시작하지 않고, snapshot에만 있던 레코드를 밝히며 `STATE_SNAPSHOT_CORRUPT`로 중단합니다. 백업에서 snapshot을 되돌려 놓거나, WAL을 있는 그대로 replay하고 snapshot과 함께 잃은 레코드를 `STATE_WAL_TAIL_REPLAYED` 경고로 밝히는 `ACP_GATEWAY_STATE_RECOVERY=snapshot-drop`으로, 또는 `cold`로 시작하세요.
  - `ACP_GATEWAY_STATE_RECOVERY=cold`는 상태를 그대로 읽을 수 없을 때(손상된 snapshot, 손상됐거나 불완전한 WAL, 손상된 v4 파일) 빈 상태로 시작합니다. snapshot, WAL, 회전으로 물러난 WAL 구간(`.rot`), v4 `state.json`은 각각 `<file>.cold-<time>`으로 옮겨 두고 손상된 상태 파일의 격리 사본처럼 보존하며(아래 참고), 어느 것도 replay하지 않습니다. `STATE_COLD_STARTED` 경고가 그 이유와 옮긴 위치를 알립니다. 온전히 읽히는 상태는 `cold`여도 평소처럼 시작합니다. 예전에는 `cold`가 손상된 snapshot만 옮겨 두고 빈 상태 위에 WAL과 v4 파일을 그대로 replay해서 버려야 할 내용이 되살아났고, 손상된 WAL에서는 여전히 시작을 중단했습니다.
  - `ACP_GATEWAY_WAL_INLINE_RESULT_BYTES`보다 큰 Task 결과는 WAL에서처럼 snapshot에도 참조(artifact 포인터와 미리보기)로 남기며, 복구도 같은 방식으로 되살립니다.
  - WAL이 켜져 있으면 상태가 바뀌는 동안 전체 snapshot은 많아야 약 1초에 한 번, 그리고 WAL 회전과 종료 때 다시 씁니다. WAL을 끄면 50ms 경로를 그대로 씁니다. WAL이 보장하던 것은 하나도 바뀌지 않습니다. 어느 경로에서든 모든 snapshot은 이전 snapshot을 대체하기 전에 fsync하고, 이름을 바꾼 뒤 그 디렉터리도 fsync합니다(쓸 때마다 fsync 두 번). 예전에는 회전 사이에 쓰는 snapshot을 fsync하지 않았기 때문에, 전원이 끊기면 회전으로 이미 잘린 로그의 유일한 기반으로 깨진 snapshot이 남을 수 있었습니다.
  - 실패한 snapshot 쓰기는 성공할 때까지 해야 할 일로 남습니다. 다음 쓰기는 종료 때의 마지막 쓰기를 포함해 새로 시도하며, 종료는 그 시도가 성공했는지와 관계없이 상태 파일을 닫습니다. 예전에는 이런 실패 뒤 아무것도 바뀌지 않은 채 종료하면 다시 쓰지 않고 같은 실패를 돌려주며 상태 파일을 닫기 전에 멈춰서, snapshot에만 담기는 변경이 저장되지 않았습니다.
  - 디스크가 가득 차는 등으로 실패한 WAL append는 로그를 그대로 둡니다. 로그를 마지막 온전한 레코드까지 잘라 되돌리고 그 레코드의 순번은 다음에 기록되는 레코드가 이어받으므로, 재시작은 로그 중간에서 순번 공백이나 손상된 레코드를 만나지 않습니다. 잘라 되돌리지 못한 로그는 회전으로 교체될 때까지 레코드를 더 받지 않고 persistence도 불건강 상태로 남으며, 이 회전은 다음 상태 write가 곧바로 시작합니다. 예전에는 실패한 append가 로그에 반쪽 레코드나 건너뛴 순번을 남겨도 다음 append가 그 뒤에 이어졌고, 다음 시작은 그 로그를 손상된 것으로 보고 거부했습니다.
  - 죽은 Gateway가 남긴 상태 잠금은 동시에 시작하는 두 Gateway가 함께 차지할 수 없도록 회수하고, 같은 프로세스 안에서 한 디렉터리에 두 번째 상태 저장소를 열면 `STATE_DIR_LOCKED`로 거부합니다. 예전에는 같은 낡은 잠금을 동시에 발견한 두 Gateway가 모두 상태를 쓸 수 있었고, 한 프로세스 안의 두 저장소가 서로의 잠금을 덮어쓸 수 있었습니다.
  - 큰 Task 결과의 artifact를 쓰지 못하거나(artifact 할당량이나 디스크가 가득 참), 쓴 뒤 그 디렉터리를 동기화하지 못해(입출력 오류. 디렉터리 동기화를 아예 지원하지 않는 파일 시스템은 해당하지 않음) WAL에 결과의 미리보기만 남으면, 결과 전체를 담은 다음 snapshot이 기록될 때까지(보통 약 1초 안) persistence가 불건강 상태로 남고 `task_result`와 `agent_acp_run`은 결과 전체와 함께 `durability: {persisted: false, errorCode: "PERSISTENCE_UNHEALTHY"}`를 돌려줍니다. 그 전에 장애가 나면 Task는 미리보기만 가진 채 돌아옵니다(`resultDegraded`). 예전에는 미리보기의 확정 기록이 persistence를 건강하다고 보고했고, 실패한 디렉터리 동기화는 무시했습니다. 그래서 WAL은 그 artifact의 이름이 디스크에 확실히 남은 것처럼 기록했고, 전원이 끊기면 파일 없이 그 참조만 남아 Task가 미리보기만 가진 채 돌아올 수 있었습니다.
  - 손상된 상태 파일의 격리 사본은 파일과 이유별로 최신 3개만 남기고 7일이 지나면 지웁니다. 비정상 종료한 writer가 상태, snapshot, 설정, install 파일 옆에 남긴 임시 파일은 시작할 때 지웁니다.
  - snapshot 작업 폴더에는 `owner.json`이 들어갑니다. 이 상태가 표시한 고아 폴더는 시작과 maintenance 때 회수하고, 실패한 삭제는 다시 시도하며, 살아 있는 복사본 전체가 4GiB 예산을 함께 쓰고 `session_open`에서 확인합니다(`WORKSPACE_ERROR`, `details: {bytes, usedBytes, limitBytes}`).
  - snapshot 작업 폴더는 `cwd`를 baseline으로 한 번만 읽고, Worker의 작업 트리는 그 baseline에서 복사합니다. 예전에는 `cwd`를 두 번 복사해서, 두 복사 사이에 `cwd`가 바뀌면 그 변경이 한쪽에만 들어가 `workspace_diff`에 Worker가 한 편집처럼 거꾸로 나타났습니다.
  - 닫힌 pin 세션은 다른 세션처럼 보존 기간이 지나면 정리되고, 처리 완료 inbox 이력 상한(root당 1000건)은 항목이 처리될 때마다 적용됩니다.
  - 넘겨받은 세션을 닫거나 보존 정리가 지울 때는 넘겨받은 사실을 담은 snapshot을 먼저 쓰고 동기화한 뒤에 닫기를 기록합니다. 이 쓰기에 실패하면 닫기를 기록하지 않고, maintenance나 닫기, clean이 그 사실을 저장할 수 있을 때까지 레코드를 닫힌 상태로 남겨 둡니다. 그동안 persistence는 unhealthy로 보고되며, 그 사이에 장애가 나도 넘겨받은 Main이 작업·inbox 항목과 함께 세션을 다시 가져올 수 있습니다. 명시적인 닫기는 여전히 평소처럼 응답하고 worker 세션을 끝내며, 남겨 둔 레코드에는 더 이상 프롬프트를 보내거나 설정을 바꾸거나 Worker 요청에 답할 수 없습니다.
- **성능과 자원 상한**(1.7.2와 1.8.0을 Apple M4 Pro에서 같은 측정 도구로 측정):
  - 상태 쓰기: 승인 40건, 약 20KB 결과의 20턴 세션에서 snapshot에 쓴 바이트가 연달아 실행할 때 2.4MB에서 0.25MB로, 단계마다 Main이 100ms 생각할 때 13.6MB에서 0.65MB로 줄었습니다. 마지막 snapshot 크기는 442KB에서 126KB로 줄었습니다.
  - 텍스트 버퍼는 밀려난 chunk를 바로 놓고 큰 backing store를 붙잡지 않습니다. 64KiB chunk를 받는 1MB 터미널 출력은 약 65MB를 붙잡던 것이 1MB만 붙잡고, 1바이트 append 300,000번은 heap을 34MB 늘리던 것이 0.08MB만 늘립니다. 돌려주는 텍스트는 그대로입니다.
  - 연결의 큐 예산 4MB보다 큰 응답 하나(frame 상한 32MB 이하)는 다른 것이 기다리고 있지 않으면 `TRANSPORT_CONGESTED`로 연결을 닫는 대신 그대로 보냅니다. `subscribe` replay는 이 예산의 절반으로 제한하고, 최신 이벤트부터 채우며, 잘린 경우 `cursorTruncated`와 함께 `budgetTruncated`, `omittedEvents`, `omittedBefore`로 알립니다.
  - poll은 각 부분을 한 번만 직렬화해 poll당 직렬화 작업이 약 절반으로 줄었습니다. 요청이 취소되거나 연결이 닫힌 긴 poll은 `WAIT_ABORTED`로 waiter와 timer를 바로 정리합니다.
  - installer가 실행하는 모든 명령(자동 adapter 업데이트 포함)에는 10분 기한이 있고, 출력은 스트림마다 처음과 마지막 512KB까지만 남깁니다. 종료할 때는 adapter 업데이트를 최대 5초만 기다린 뒤 중단합니다. 스스로 끝난 명령은 기한이 늦게 와도 자기 종료 상태를 유지합니다.
  - Gateway 밖으로 나간 적 없는 대체된 `tool_call_update` payload 파일은 바로 지우고, 내구성 있는 Task 결과는 artifact 한도의 마지막 1/8(64MB)을 따로 확보합니다.
- **테스트:** 38개 파일의 테스트 557개에서 46개 파일의 826개로 늘었습니다. 식별 정보 넘겨주기, Worker 감지, Main별 분리와 넘겨받기, 터미널 승인과 sandbox profile, 확인한 파일 handle, socket 소유자, 저장소 정리, 런타임 상한을 새 테스트로 다룹니다.
- **호환성:**
  - 그대로인 것: API major 1, state schema 5, 설정, WAL 레코드 유형, 기본 socket 경로, `install.json` 형식. AgenLynk 같은 관리 소비자에게는 `GatewayRpcClient`, `install.json`의 `identity.{token,rootId}`, bootstrap 플래그, `caller` 없는 요청의 root 전체 접근, `agent-acp` 항목 이름으로 프론트 도어를 찾는 방식이 그대로입니다.
  - additive: 위의 오류 코드 네 개, 세션 응답의 `adoptedFrom`, 잘린 replay의 `budgetTruncated`·`omittedEvents`·`omittedBefore`, 작업 폴더 예산 오류의 `details`, 결과 전체가 아직 내구성 있게 저장되지 않은 동안 `task_result`와 `agent_acp_run`에 붙는 `durability`(영속성 참고), `STATE_WAL_TAIL_REPLAYED`·`STATE_COLD_STARTED` 경고(영속성 참고), daemon이 거부한 재구독의 `subscription_error` 이벤트에 붙는 `errorCode`, installer MCP action의 `removedEnv`(교체로 빠지는 식별 정보 변수 이름).
  - 의도적으로 바뀐 것: Main을 기다리는 Gateway 터미널·쓰기 요청의 `toolCall`(위 참고). `title`을 메서드 이름과 비교하던 소비자는 `kind`를 읽어야 합니다. 프론트 도어 Main의 조회와 목록이 돌려주는 범위(분리). Worker 요청의 `requestId`: `permission`과 `answer`는 이제 문자열이나 정수로 받고, `permission_response`와 `elicitation_response` 이벤트는 숫자로 바꾸지 않고 Worker가 준 그대로 담으므로, 정수라고 가정하던 소비자는 문자열도 받아야 합니다. socket 경로나 그 위의 디렉터리를 믿을 수 없으면 `daemon_shutdown`과 `shutdown_if_idle`이 `alreadyStopped` 대신 `SOCKET_UNTRUSTED`를, 경로가 socket에 쓰기에 너무 길면 `SOCKET_PATH_TOO_LONG`을 보고하는 것(socket이 들어갈 디렉터리 자체가 없는 경우는 어느 쪽에도 해당하지 않으며, 여전히 `alreadyStopped`로 답합니다). `ACP_GATEWAY_STATE_RECOVERY=cold`로 시작하면 `STATE_SNAPSHOT_DROPPED` 대신 `STATE_COLD_STARTED` 경고를 띄우고, 옮겨 둔 상태는 하나도 replay하지 않는 것. 다른 실행이 `install.json`을 바꾸는 동안 이 파일을 바꾸려는 installer 실행이 곧바로 실패하는 것. installer를 실행하는 소비자는 다른 실행이 끝난 뒤 다시 실행해야 합니다.
- **다운그레이드:**
  - 1.4~1.7 Gateway도 1.8.0이 쓴 상태를 읽지만, 참조로 남긴 큰 Task 결과는 미리보기(`resultDegraded`)로만 돌아오고, Main별 분리와 넘겨받기는 함께 사라집니다. 1.4보다 오래된 Gateway는 `state.json`을 찾지 못하고 빈 상태로 시작하며, 지워진 v4 파일은 되살릴 수 없습니다.
  - 1.7.x 프론트 도어는 token을 항목의 환경 변수에서만 읽으므로, 1.8.0이 옮긴 항목으로는 시작할 수 없습니다. 되돌린 뒤에는 이전 installer로 Control MCP를 다시 등록하세요: `acp-gateway-bootstrap --install-control --target <프론트 도어> --force`. 이전 installer의 `--update`는 식별 정보 없는 항목을 그대로 둡니다.
- **업그레이드:** npm 설치본은 `npm install -g acp-gateway-daemon@latest`를 실행한 뒤 `acp-gateway-bootstrap --update`를 실행하세요. installer가 등록한 Control 항목에서 token을 빼고 daemon도 다시 시작합니다. 소스 checkout은 `acp-gateway-bootstrap --update`로 업데이트하고, 앱이 관리하는 runtime은 그 앱이 업데이트합니다. 그다음 호스트 세션을 다시 연결해 1.8.0 프론트 도어를 띄우고, 바뀐 `agent-delegator` 안내는 `acp-gateway-bootstrap --update-skill`로 받으세요. installer 경고에서 token을 그대로 둔 항목이 있는지 확인하고, 위에서 설명한 대로 token을 교체하세요. 직접 지정해 둔 `ACP_GATEWAY_SOCKET`이 있다면 본인만 쓸 수 있는 디렉터리에 있는지, 실제 경로로 풀었을 때 macOS에서 103바이트, Linux에서 107바이트를 넘지 않는지 확인하고, 다른 사용자와 함께 쓰는 Linux 호스트에서는 모든 client에 그런 경로를 지정하세요.

## v1.7.2 변경 사항

1.7.0에서 도입한 복구 관련 사실이 업그레이드와 장애 뒤에도 정확하게 유지되도록 고치고, installer가 자신이 썼다고 입증할 수 없는 MCP 항목은 다시 등록하지 않게 하며, npm 12에서도 검증된 의존성 트리를 Claude Code 바이너리 없이 설치하게 하고, npm 게시를 trusted publishing으로 바꾸고, README에서 Worker와 Gateway 제어 권한에 대해 설명한 내용을 바로잡는 패치 릴리스입니다. API major **1**과 state schema **5**는 유지되며, 새 설정·오류 코드는 없습니다. 새로 공개되는 것은 복구 결과를 디스크에 확실히 기록하지 못했을 때만 복구 응답에 붙는 `durability` 필드와 setup 경고 `STATE_RESTORE_NOT_DURABLE`뿐입니다.

- **중단 결과 판정(1.7.0 버그):**
  - 1.7.0과 1.7.1은 dispatch 기록이 없는 중단 작업을 모두 `executionOutcome: "not_started"`로 보고했습니다. v1.6.0은 이 기록을 남기지 않았기 때문에, 업그레이드 재시작으로 끊긴 v1.6.0 작업이 `not_started`로 보고됐습니다. Worker가 이미 prompt를 받아 움직였을 수도 있는데 다시 실행해도 안전하다고 알린 셈입니다.
  - 이제 작업에 dispatch 추적 표시를 내부적으로 남깁니다(API로는 나오지 않음). 중단 판정이 `not_started`가 되는 것은 이 표시가 있으면서 dispatch 기록이 없는 작업뿐입니다. 그 밖의 작업은 1.7.2 이전에 만든 작업을 포함해 모두 `unknown`으로 판정하며, snapshot 세션이라면 `next`에 `workspace_diff`가 들어갑니다.
  - 1.7.0과 1.7.1이 이미 기록한 `not_started` 판정도 복구할 때 바로잡습니다. 이 표시가 없는 작업(1.6.0 작업 전부와 1.7.0·1.7.1이 만든 작업)에 저장된 `executionOutcome: "not_started"`는 이제 `task_get`·`task_list`와 결과 envelope에서 `unknown`으로 읽히고, 결과 envelope의 `next`도 다시 만들어집니다. snapshot 세션이면 `workspace_diff`가 들어가고, `decide_rerun`은 다시 실행하면 부작용이 반복될 수 있다고 안내합니다.
  - 중단된 작업의 결과를 replay가 미리보기로만 되살릴 수 있는 경우(artifact가 사라진 경우)에도 결과에 `interruption`과 `next`가 다시 붙습니다. 1.7.0이나 1.7.1이 이 둘 없이 저장해 둔 결과도 1.7.2가 읽어 들일 때 바로잡습니다.
- **복구 실패와 격리가 장애 뒤에도 유지됨:**
  - 복구에 실패하면 세션의 실패 횟수, 격리 상태, `lastRestore`를 WAL에 쓰고 fsync한 뒤에 오류를 돌려줍니다. 실패 연속을 끝내거나 격리를 푸는 복구 성공도 마찬가지입니다. 예전에는 이 값들이 이후의 상태 snapshot에서야 디스크에 기록됐기 때문에, 세션을 격리한 실패 직후에 장애가 나면 격리가 풀리거나, 복구 성공으로 풀린 격리가 되살아날 수 있었습니다.
  - 복구 결과(복구 실패, 또는 실패 연속을 끝내거나 격리를 푸는 복구 성공)를 기록하는 동기화 쓰기가 실패해도 결과는 그대로지만, 더 이상 조용히 넘어가지 않습니다. persistence 상태가 unhealthy로 보고되고, `agent_acp_setup`에 `STATE_RESTORE_NOT_DURABLE` 경고가 나타나며, 성공한 복구 응답에는 `durability: { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" }`가, 실패한 복구의 오류에는 같은 값이 `details.durability`로 붙습니다. 이미 진행 중이던 백그라운드 상태 쓰기가 그 사이에 기록된 실패를 지우는 일도 없으며, 오류 메시지가 이전 실패와 같아도 마찬가지입니다.
  - 호출자가 지정한 복구 방법(`resume` 또는 `load`)을 provider가 광고하지 않으면 아무 일도 일어나기 전에 거부합니다. 복구 이벤트도, 상태 변경도, 실패 횟수 증가도 없습니다. 예전에는 세션이 `restoring`을 거치고 복구 실패로 세어졌습니다. `session/resume`도 `session/load`도 광고하지 않는 provider에서의 자동 복구는 지금도 실패한 복구로 세어 격리 횟수에 포함하며, `lastRestore`에는 `method: null`, `errorCode: INVALID_ARGUMENT`가 기록됩니다.
  - 명시적 `agent_acp_session_restore`는 그 세션에서 진행 중인 유일한 복구입니다. 그동안 (예컨대 prompt 때문에) 시작된 자동 복구는 이 복구에 합류하고, 자동 복구 도중에 들어온 명시적 복구는 그 결과를 기다린 뒤 다시 판단합니다. 그래서 Worker가 복구 요청을 두 번 받는 일이 없습니다.
  - provider를 끄면(`set_enabled`, `enabled: false`) 관리 API 계약에 적힌 대로 새 등록만 막습니다. 이 Main이 가진 등록 세션은 Off 상태에서도 `agent_acp_session_restore`로 복구할 수 있으며, 격리된 세션에는 이것이 유일한 복구 경로입니다. 아직 등록되지 않은 세션은 provider가 꺼져 있는 동안 여전히 복구할 수 없습니다.
- **installer와 MCP 항목:**
  - `--update`와 `--install-all`은 관리 중인 `agent-acp`·`agent-acp-guide` 항목이 이 installer가 등록한 바로 그 항목임이 입증될 때만 다시 등록합니다. 이제 등록할 때마다 그 실행 정보(command와 args, 환경 변수는 이름만 기록하고 값은 기록하지 않음)를 설치 상태에 남기며, 항목이 여전히 정확히 그것을, 정확히 그 환경 변수들과 설치 상태에 있는 Control token·Main ID로 실행해야 합니다. 그 뒤 env가 바뀐 항목(사용자가 `HTTP_PROXY`나 `NODE_OPTIONS` 같은 변수를 추가했거나, 변수를 지웠거나, token이나 Main ID가 다른 경우)은 교체하면 그 변경이 사라지므로 경고와 함께 그대로 둡니다. 1.7.2 이전에 등록한 항목에는 실행 정보 기록이 없고, 사용자가 직접 가리켜 둔 이전 Gateway 설치본과 구별할 방법도 없으므로 자동으로는 절대 옮기지 않습니다. 이미 이 설치본을 실행하는 항목이 아니면, 소유 기록 이전의 항목이라는 경고와 함께 그대로 두며, `--force`로 한 번 다시 실행하면 다시 등록하고 실행 정보를 기록합니다. 그 뒤로는 업데이트가 알아서 옮깁니다. 이 확인을 통과하지 못한 항목은 모두 경고와 함께 그대로 두고, `--force`를 주면 교체합니다. 예전에는 스크립트가 사라진 관리 항목을 무조건 다시 등록했고, 사용자나 다른 앱이 같은 형태로 바꿔 둔 항목도 예외가 아니었습니다.
  - 경로가 symlink를 거치는 항목은 링크가 끊겼거나 스크립트가 없는 곳을 가리켜도 경고만 남기고 그대로 둡니다. 그 링크를 관리하는 앱이 고칠 일입니다. 확인할 수 없는 경로(예: `EACCES`)는 사라진 것으로 간주하지 않고 unknown으로 보고한 뒤 그대로 둡니다.
  - agent CLI에는 원자적인 교체 명령이 없으므로, installer는 항목을 지우기 전에 그 command·args·env를 agent CLI에서 읽어 둡니다. 그 뒤 새 항목 추가에 실패하면 이전 항목을 원래의 command·args·env 그대로 되돌리고, 그 사실을 오류에 적습니다. 유일한 예외는 이전 token을 폐기하는 `--rotate-token`입니다. 이때 이 installer가 쓴 실행 정보(이 설치본의 node와 스크립트, 또는 설치 상태에 기록된 실행 정보)는 원래 env 위에 새 Control token과 Main ID를 얹어 되돌리며, 다른 항목에는 절대 이 값을 넣지 않습니다. 정확히 되돌릴 수 없는 항목은 업데이트가 지우지 않고 경고와 함께 그대로 둡니다. 예를 들어 CLI가 항목의 env를 알려 주지 않거나, 항목에 CLI의 `mcp add`로는 다시 설정할 수 없는 `cwd`나 `env_vars`가 있는 경우입니다. `--force`나 `--rotate-token`을 주면 이런 항목도 교체하며, 교체에 실패하면 정확히 복원하지 못했다고 알립니다. 예전에는 이 설치본을 실행하지 않던 항목을 되돌릴 때 환경 변수를 빼고 복원했습니다.
  - installer가 보고하는 MCP 등록 내용(dry run 포함)에는 Control token뿐 아니라 Main ID도 `<redacted>`로 나옵니다. 오류에서도 이 둘과 복원하는 항목의 env 값을 가리며, agent CLI가 출력에 그 값을 그대로 찍은 경우도 마찬가지입니다. 예전에는 이런 곳에 Main ID가 그대로 나왔습니다.
- **npm 12 설치(1.7.0 버그):** npm 12는 게시된 패키지 안의 것을 포함해 `npm-shrinkwrap.json`을 더 이상 읽지 않습니다. 그래서 npm 12에서 1.7.0·1.7.1을 설치하면 검증된 트리 대신 새로 해석한 의존성과 현재 플랫폼의 Claude Code 바이너리까지 받아, 약 48MB가 아니라 약 310MB가 설치됐습니다.
  - 수정: 1.7.2는 의존성 트리를 패키지 안에 함께 담습니다(`bundleDependencies`). npm 10·11·12 모두 검증된 버전을 그대로 설치하고, registry에서 다른 것은 받지 않으며, Claude Code 바이너리도 설치하지 않습니다. 내려받는 크기는 약 6.1MB(기존 0.3MB), 설치 크기는 1.7.1을 npm 10·11로 설치했을 때와 같은 약 48MB입니다. Claude Agent SDK가 `@anthropic-ai/sdk`를 peer로 요구하는데 npm은 peer 전용 패키지를 번들하지 않으므로, 이미 쓰던 버전 그대로 직접 의존성에 추가했습니다.
  - maintainer용: lockfile은 다시 `package-lock.json`이며, `node scripts/omit-claude-binary.js`도 이제 이 파일에서 Claude 플랫폼 바이너리를 뺍니다. 패키지는 `npm ci --omit=optional` 다음 `node scripts/pack-release.js --pack-destination <dir>`로만 만듭니다. 이 스크립트는 `prepack` 스크립트이기도 하며, `node_modules`가 잠긴 production 트리와 정확히 같지 않거나 Claude 플랫폼 패키지가 들어 있으면 pack을 거부합니다. `npm run smoke:npm`은 tarball을 npm 10·11·12로 각각 설치해 보고, 설치 중에 패키지 자신 말고 다른 것을 registry에 요청하면 실패합니다.
- **trusted publishing으로 npm 게시:**
  - `Publish npm` workflow는 npm trusted publishing(OIDC)으로 게시합니다. 저장소에 npm 토큰을 두지 않고 workflow도 토큰을 쓰지 않으며, 토큰으로 대신 게시하는 경로도 없습니다. 1.7.0은 secret `NPM_TOKEN`을 썼습니다.
  - workflow는 릴리스 태그 `refs/tags/v<version>`에서 실행해야 하며, checkout한 커밋이 태그의 커밋이자 실행을 요청한 커밋이어야 합니다. 그래서 실행 후 태그를 옮기면 거부됩니다(`scripts/check-npm-release.js`).
  - 첫 번째 job은 게시 권한 없이 `npm ci --omit=optional`, `npm run ci`, `npm run smoke:npm`을 실행한 뒤 `scripts/pack-release.js`로 tarball을 만들고, 그 sha256이 smoke test가 설치한 tarball과 같은지 확인합니다. GitHub OIDC 토큰을 요청할 수 있는 유일한 job인 두 번째 job은 저장소 코드를 실행하지 않고, tarball의 checksum과 이름·버전을 확인한 뒤 바로 그 tarball을 npm 11로 provenance와 함께 게시합니다. npm 쪽 설정은 [운영 가이드](docs/operations.ko.md#npm-배포-maintainer용)에 있습니다.
- **Control MCP의 `agent_acp_run` attach:** Control MCP를 통한 attach(`{taskId}`)는 이제 호출자가 보낸 인자를 Gateway에 그대로 전달합니다. 그래서 `prompt`·`sessionId`·`parentTaskId`·`inputTaskIds`를 함께 보낸 attach는 socket으로 호출할 때와 같이 `INVALID_ARGUMENT`로 실패합니다. 예전에는 프론트 도어가 이 인자를 버리고, 보내지 않은 것처럼 attach했습니다.
- **문서 정정(보안):** README는 Worker에 Gateway 제어 권한을 전달하지 않는다고 설명했습니다. Gateway는 Worker 환경에서 자신의 토큰, socket, Main 식별자를 지우지만, 자기 도구로 Gateway를 거치지 않고 파일을 읽는 Worker(Codex는 `read_only`에서도 그렇게 읽는 것을 확인했습니다)는 프론트 도어의 MCP 설정에 저장된 Control token을 읽어 Main처럼 행동할 수 있습니다. README와 운영 가이드에 이 사실을 적고, 이런 Worker에게 신뢰할 수 없는 자료를 맡기지 말라고 안내했습니다. 1.7.2에서 이 동작 자체는 바뀌지 않으며, 더 강한 격리를 계획하고 있습니다.
- **테스트:** Gateway가 종료 중일 때의 실패는 복구 실패로 세지 않는다는 것, 명시적 복구가 snapshot 세션을 복사해 온 원본 디렉터리로도 지정할 수 있다는 것, 작업을 취소해도 확인한 것으로 표시되지 않는다는 것을 새 테스트로 고정했습니다.
- **호환성:** API, state schema, 설정은 바뀌지 않았습니다. 기본·compact poll 응답과 일반 작업·run의 조회 응답·결과 envelope는 바이트 단위까지 같습니다. 바뀐 것은 다음과 같습니다. 1.7.2 이전에 만든 작업은 앞으로 중단되면 `unknown`으로 판정하고(1.7.0·1.7.1은 `not_started`로 판정할 수 있었습니다), 그런 작업에 1.7.0·1.7.1이 이미 기록한 `not_started`도 `unknown`으로 읽힙니다. 시작용 인자를 함께 보낸 attach는 조용히 인자가 잘리는 대신 실패합니다. 호출자가 지정했지만 provider가 광고하지 않은 복구 방법은 더 이상 실패로 세지 않습니다. provider가 꺼져 있어도 Main이 자기 세션을 복구할 수 있습니다. 복구 결과를 디스크에 확실히 기록하지 못하면 그때만 붙는 `durability` 필드로 알립니다. installer는 자신이 썼다고 입증할 수 없는 MCP 항목을 그대로 둡니다. 1.7.2 이전에 등록했고 아직 이 설치본을 실행하지 않는 항목도 모두 여기에 해당하며, `--force`로 한 번 다시 등록할 때까지 그대로 둡니다. 1.7.2가 쓴 state는 1.7.0과 1.7.1에서도 읽을 수 있습니다. 복구 결과는 기존 `session.registered` 레코드로 기록하고, 새 WAL 레코드 유형은 없으며, 이전 daemon은 작업에 새로 붙은 표시를 무시하고, 바로잡은 판정은 이전 버전도 쓰던 값인 `unknown`입니다. 설치 상태(`install.json`)는 관리 중인 MCP 항목마다 `launch` 기록이 추가될 뿐 형식 버전은 그대로이므로 1.7.0과 1.7.1도 읽을 수 있습니다. 이전 installer가 항목을 다시 등록하면 그 항목의 `launch`가 사라지고, 1.7.2는 그 항목을 1.7.2 이전에 등록한 항목으로 다룹니다.
- **업그레이드:** npm 설치본은 `npm install -g acp-gateway-daemon@latest`를 실행한 뒤 `acp-gateway-bootstrap --update`를 실행하세요. daemon 재시작까지 해 줍니다. npm 12로 1.7.0·1.7.1을 설치했다면 `npm install -g acp-gateway-daemon@latest`가 그 트리를 Claude Code 바이너리까지 통째로 교체합니다. 소스 checkout은 `acp-gateway-bootstrap --update`로 업데이트하고, 앱이 관리하는 runtime은 그 앱이 업데이트합니다. 그다음 호스트 세션을 다시 연결해야 호스트가 attach 수정이 들어간 새 Control MCP 프론트 도어를 띄웁니다. `--update`는 1.7.2 이전에 등록한 MCP 항목을 옮기지 않고 그대로 두었다고 경고합니다. 그 항목이 무엇을 실행하는지 확인한 뒤 `--force`로 한 번 다시 실행해 다시 등록하세요(등록 뒤 항목에 가한 env 변경은 사라집니다). 그다음부터는 업데이트가 알아서 옮깁니다. `--update`가 그대로 두었다고 경고한 다른 항목도 같은 방법으로 처리하세요.

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

### 1.5.x·1.6.0·1.7.0·1.7.1·1.7.2 runtime 빌드

1.5.x(`v1.5.0`~`v1.5.2`), `v1.6.0`, `v1.7.0`, `v1.7.1`, `v1.7.2` builder는 tag와 별도로 검토한 전체 source SHA를 요구합니다. tag가 해당 SHA와 다르면 빌드와 검증을 거부하며, 새 runtime의 엔진과 public client는 모두 같은 source commit에서 추출합니다. 기존 1.4.0 태그의 고정 SHA 검증은 유지합니다.

```bash
npm run release:runtime -- --source-tag v1.7.2 --source-commit FULL_REVIEWED_SOURCE_SHA --output-dir dist
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
