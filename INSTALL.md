# chrome-live 설치 (Windows · git 없이 · 토큰 없이)

설치본은 **공개** GitHub 저장소 `ryznsquareHub/chrome-live-dist`(브랜치 `main`)에 있습니다. git도 GitHub 로그인도 토큰도 필요 없습니다. PowerShell 한 줄이 zip을 받아 설치합니다. 같은 한 줄을 다시 실행하면 **업데이트**입니다.

---

## 0. 이렇게 하세요 (요약)

1. Claude Code에 **이렇게 말합니다**(그대로 복사):

> chrome-live 설치해줘: PowerShell에서 아래 명령을 실행하고, 끝나면 설치 폴더의 INSTALL.md에 있는 "4. 크롬에서 직접 할 일"을 차례대로 안내해줘.
> `irm https://raw.githubusercontent.com/ryznsquareHub/chrome-live-dist/main/install.ps1 | iex`

   설치 폴더를 정하려면(기본 `%USERPROFILE%\chrome-live`) 명령을 이렇게 바꾸라고 말하세요:
   `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryznsquareHub/chrome-live-dist/main/install.ps1))) -Dir 'D:\tools\chrome-live'`

   Claude 없이 직접 하려면 PowerShell 창에 위 한 줄을 붙여 넣으면 됩니다.

2. 끝나면 **4절(크롬에서 직접 할 일)**: 원격 디버깅 허용 켜기 → 확장 프로그램 로드 → 처음 연결 때 "허용".

Node.js가 없으면 스크립트가 `winget`으로 Node.js LTS를 설치합니다(권한 창이 뜰 수 있음). winget이 없으면 https://nodejs.org 에서 LTS를 설치하고 **PowerShell을 새로 연 뒤** 다시 실행합니다.

---

## 1. 준비물
| 무엇 | 확인 | 없으면 |
|---|---|---|
| Windows 10/11 | — | — |
| Google Chrome (최신) | `chrome://version` | 설치 |
| Node.js 18 이상 (LTS 권장) | `node -v` | install이 `winget install OpenJS.NodeJS.LTS`로 설치(또는 직접 설치 후 **새 터미널**) |
| Claude Code (선택이지만 보통 씀) | `claude --version` | MCP·스킬 등록만 건너뜀. 나중에 설치하고 install을 한 번 더 실행 |
| Codex CLI (선택) | `codex --version` | 패널 채팅의 Codex 엔진만 비활성 |
| git · GitHub 계정 · 토큰 | **필요 없음** | — |

인터넷: `raw.githubusercontent.com`(스크립트·버전 확인), `codeload.github.com`(zip), `registry.npmjs.org`(`npm ci`).

## 2. install.ps1이 하는 일
1. Node.js 18+ / `npm.cmd` 확인(없으면 winget으로 Node.js LTS 설치 시도, `-NoNodeInstall`이면 안내만)
2. 설치 폴더 결정: `-Dir` > 기존 자동 시작(`시작프로그램\chrome-live.vbs`)이 가리키는 폴더(= 업데이트) > `%USERPROFILE%\chrome-live`. git 저장소 폴더(`.git` 있음)면 거부(`-Force`로만)
3. 그 폴더에서 데몬이 돌고 있으면 **사이드 패널 채팅이 진행 중인지** 확인 — 진행 중이면 **아무것도 바꾸지 않고 멈춤**(재시작하면 그 채팅이 끊기므로). 끝난 뒤 다시 실행
4. `https://codeload.github.com/ryznsquareHub/chrome-live-dist/zip/refs/heads/main`(공개 zip, 인증 없음)을 `%TEMP%`에 받아 풀기
5. 데몬이 돌고 있었으면 멈춤 → 설치 폴더로 복사(robocopy, **지우는 것 없음**, `config.json`·`node_modules`는 건너뜀)
6. `AGENTS.md`의 예시 폴더(`C:\path\to\chrome-live`)를 실제 설치 폴더로 바꿈(Codex용)
7. `npm ci`(package-lock.json이 바뀌었거나 node_modules가 없을 때만)
8. `skill\sync-skill.cmd` → `%USERPROFILE%\.claude\skills\chrome-live\SKILL.md`(문서의 폴더를 실제 설치 폴더로 바꿔서 복사)
9. 시작프로그램에 `chrome-live.vbs`(로그온 때 `start-hidden.vbs` = 창 없는 `node server.js`)
10. 데몬 시작 → `node cli.js status` 응답 확인. 첫 시작 때 `%LOCALAPPDATA%\chrome-live\auth.json`(토큰)이 생김
11. Claude Code가 있으면 MCP 서버 등록: `chrome-live` = `http://127.0.0.1:18931/mcp`, 헤더 `Authorization: Bearer <auth.json의 token>`(user 범위, 이미 같으면 건너뜀, 토큰은 출력 안 함)

옵션: `-Dir <폴더>` `-ZipUrl <주소|zip 파일>` `-NoStart` `-NoAutostart` `-NoSkill` `-NoMcp` `-NoNodeInstall` `-Force`. 옵션은 `& ([scriptblock]::Create((irm <install.ps1 주소>))) -Dir 'D:\tools\chrome-live' -NoMcp`처럼 뒤에 붙입니다(`| iex` 형식은 옵션을 못 받음).

**설치 폴더 위치**: 어디든 됩니다(`start-hidden.vbs`·`cli.js`는 자기 위치 기준, 확장 프로그램 id는 manifest `key`로 고정, MCP는 URL만). 문서(SKILL·AGENTS)의 `C:\path\to\chrome-live`는 예시 경로 → **설치 폴더로 바꿔 읽으면** 됩니다(스킬 사본과 AGENTS.md는 install이 바꿔 줌). 공백 없는 경로를 권장합니다.

## 3. 손으로 설치 (스크립트 없이, 같은 결과)
```powershell
$dir = "$env:USERPROFILE\chrome-live"; $tmp = Join-Path $env:TEMP "chrome-live-dl"; New-Item -ItemType Directory -Force $tmp, $dir | Out-Null
Invoke-WebRequest -UseBasicParsing -OutFile "$tmp\src.zip" 'https://codeload.github.com/ryznsquareHub/chrome-live-dist/zip/refs/heads/main'
Expand-Archive "$tmp\src.zip" "$tmp\x" -Force
$top = (Get-ChildItem -Directory "$tmp\x")[0].FullName          # chrome-live-dist-main 한 겹 벗기기
robocopy $top $dir /E /XD node_modules .git /XF config.json
Remove-Item -Recurse -Force $tmp
cd $dir; npm.cmd ci
skill\sync-skill.cmd                                              # Claude 스킬 복사(경로 자동 치환)
Set-Content -Encoding ASCII "$([Environment]::GetFolderPath('Startup'))\chrome-live.vbs" "CreateObject(""WScript.Shell"").Run ""wscript.exe //nologo """"$dir\start-hidden.vbs"""""", 0, False"
wscript.exe //nologo "$dir\start-hidden.vbs"; Start-Sleep 3; node cli.js status
```
MCP 등록(Claude Code): 토큰을 화면에 내지 않고 바로 넘깁니다.
```powershell
$t = (Get-Content -Raw "$env:LOCALAPPDATA\chrome-live\auth.json" | ConvertFrom-Json).token
claude mcp add --transport http -s user chrome-live http://127.0.0.1:18931/mcp --header "Authorization: Bearer $t" *> $null; $t = $null
```

## 4. 크롬에서 직접 할 일 (자동화 불가 — 직접 클릭)
1. **원격 디버깅 허용**: 크롬 주소창에 `chrome://inspect/#remote-debugging` → **Allow remote debugging for this browser instance** 켜기(한 번, 계속 켜 둠).
2. **확장 프로그램(사이드 패널)** — 패널을 쓸 **프로필마다**: `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드합니다** → `<설치 폴더>\extension` 선택 → id가 `nlplpaojofgjdmpmhalpednknlnjkmih`인지 확인. 패널은 툴바의 사이드 패널 아이콘에서 엽니다.
   - 확장 폴더의 `panel-token.json`은 데몬이 시작할 때 만듭니다(데몬보다 확장을 먼저 열어 "인증 실패"가 뜨면 확장의 ↻ 새로고침).
3. **처음 연결**: Claude에게 "크롬 탭 목록 보여줘"(또는 `node <설치 폴더>\cli.js tabs`) → 크롬에 **"원격 디버깅 허용"** 창이 뜨면 **허용**. 데몬 연결이 유지되는 동안은 다시 안 뜹니다(데몬 재시작·크롬 재시작 때 1번).
4. **Claude Code 재시작**(MCP `chrome-live`와 스킬 `chrome-live`를 불러오게). 확인: `claude mcp list`에 `chrome-live … Connected`.
5. (선택) **내 정보**: 금고(`%LOCALAPPDATA%\chrome-live\vault.dat`)는 Windows DPAPI로 **이 PC·이 계정에서만** 풀립니다. 다른 PC로 복사해도 안 열립니다 → 패널의 내 정보 탭에서 넣거나, 옛 PC 패널 ⋯ → 내보내기(JSON, **암호화 안 됨** — 옮긴 뒤 바로 지우기) → 새 PC ⋯ → 가져오기.
6. (선택) 설정 파일: `<설치 폴더>\config.json`은 없으면 기본값으로 동작합니다. 바꿀 값은 패널 설정 탭에서(예시 `config.example.json`).

## 5. 업데이트
- 사이드 패널이 새 버전을 알려 줍니다(설정 탭 **업데이트** 구역, 새 버전이면 위쪽 배너). 데몬이 공개 저장소의 `version.json`을 확인합니다(6시간마다, **확인** 버튼으로 바로; 오프라인이면 조용히 넘어감). 데몬이 스스로 업데이트하지는 않습니다.
- **업데이트** 버튼 → Claude CLI에 붙여 넣을 메시지가 복사됩니다("Claude CLI에 붙여 넣으세요"). 그 메시지에는 이 설치 폴더(`-Dir`)가 들어 있어서 Claude가 같은 한 줄로 이 폴더를 업데이트합니다. 직접 해도 됩니다: 0절의 한 줄(기존 자동 시작 폴더를 찾아 덮어씀).
- **패널 채팅이 진행 중이면** install은 아무것도 바꾸지 않고 멈춥니다 → 채팅이 끝난 뒤 다시 실행.
- 데몬이 돌고 있었으면 멈췄다가 다시 시작 → 다음 크롬 작업 때 크롬에 **허용 창이 한 번** 뜹니다.
- 확장 프로그램: 패널이 데몬에게서 새 확장 버전을 보면 **스스로 한 번 다시 불러옵니다**(사이드 패널이 닫히면 다시 열기). 안 되면 프로필마다 `chrome://extensions`에서 chrome-live의 **↻(새로고침)**. (이 자동 새로고침은 v2.1부터 — 그 전 버전에서 올릴 때는 한 번 직접 ↻.)
- **보존되는 것(손대지 않음)**: `%LOCALAPPDATA%\chrome-live\` 전체 — `auth.json`(토큰), `vault.dat`(+`.prev`), `profile-memory.json`, `recipes\`, `traces\`, `chat-mcp.json`, `paused.json` 등. 설치 폴더의 `config.json`, `server.log`, `events.jsonl`, `chat\threads\`, `chat\work\`, `extension\panel-token.json`, `node_modules\`(락 파일이 같으면) — zip에 들어 있지 않고 복사는 지우지 않으므로 그대로입니다.
- 새 버전에서 지워진 파일은 설치 폴더에 남을 수 있습니다(무해). 깨끗이 하려면 `config.json`만 따로 두고 폴더를 지운 뒤 다시 설치.
- `auth.json` 토큰은 그대로라 MCP를 다시 등록할 필요 없음(install이 같으면 건너뜀).

## 6. 문제 해결
| 증상 | 해결 |
|---|---|
| `node`를 못 찾음 | Node 설치 후 **새 터미널**(PATH 갱신) |
| `download failed` | 인터넷/프록시 확인 후 다시 실행 |
| `npm ci` 실패 | 인터넷/프록시 확인 후 다시 실행 |
| `A side-panel chat … is running` | 패널 채팅이 끝난 뒤 다시 실행(아무것도 안 바뀌었음) |
| `daemon not running` | `wscript //nologo <설치 폴더>\start-hidden.vbs`, 로그 `<설치 폴더>\server.log` |
| `API listen error (another daemon running?)` | 다른 chrome-live 데몬이 18932 포트를 씀(옛 설치 폴더) → 그 node 프로세스 종료 |
| 패널 "인증 실패" | 데몬 시작 후 확장 ↻ |
| `tabs`가 연결 안 됨 | 4-1 토글 확인, 크롬의 허용 창 확인 |

## 7. 제거
시작프로그램의 `chrome-live.vbs` 삭제 → `node <설치 폴더>\cli.js status`의 `pid`로 `taskkill /PID <pid> /T /F` → `claude mcp remove chrome-live -s user` → `%USERPROFILE%\.claude\skills\chrome-live` 삭제 → 확장 프로그램 삭제(프로필마다) → 설치 폴더 삭제. 내 정보·기억까지 지우려면 `%LOCALAPPDATA%\chrome-live`도 삭제(되돌릴 수 없음).
