# chrome-live v2.1.0

## 설치 (Claude Code에 이 메시지를 그대로 붙여 넣으세요)

> chrome-live 설치해줘: PowerShell에서 아래 명령을 실행하고, 끝나면 설치 폴더의 INSTALL.md에 있는 "4. 크롬에서 직접 할 일"을 차례대로 안내해줘.
> `irm https://raw.githubusercontent.com/ryznsquareHub/chrome-live-dist/main/install.ps1 | iex`

- git·GitHub 계정·토큰 필요 없음. Node.js가 없으면 winget으로 설치합니다.
- 설치 폴더 지정(기본 `%USERPROFILE%\chrome-live`): `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryznsquareHub/chrome-live-dist/main/install.ps1))) -Dir 'D:\tools\chrome-live'`
- **업데이트도 같은 명령**입니다. 사이드 패널 설정 탭이 새 버전을 알려 주고, **업데이트** 버튼이 Claude CLI에 붙여 넣을 메시지(이 설치 폴더 포함)를 복사해 줍니다. 설정·내 정보·기억·채팅 기록은 그대로 둡니다.
- 자세한 내용: [INSTALL.md](INSTALL.md)

## chrome-live란
평소 쓰는 크롬(이미 열린 탭, 로그인 그대로)에 CDP로 붙어서 Claude Code(또는 Codex)가 **사용자가 고른 탭만** 조작하게 해 주는 Windows용 로컬 데몬 + CLI + MCP + 크롬 사이드 패널(채팅 · 내 정보 자동 기입 · 작업 기록 · 설정)입니다. 새 브라우저를 띄우는 일반 Playwright MCP와 다릅니다.

- 데몬은 `127.0.0.1`에서만 열리고 토큰이 있어야 쓸 수 있습니다. 비밀·상태는 `%LOCALAPPDATA%\chrome-live\`에 둡니다.
- 사용법(Claude용 규칙): [skill/SKILL.md](skill/SKILL.md) · Codex용: [AGENTS.md](AGENTS.md) · 사이드 패널: [extension/README.md](extension/README.md)

## 이번 버전 (v2.1.0, 2026-11-18)
- 공개 배포 저장소에서 PowerShell 한 줄로 설치·업데이트 (git·토큰 불필요, Node.js 없으면 winget으로 설치)
- 사이드 패널 설정 탭에 업데이트 확인: 새 버전과 변경 요약을 보여 주고, 업데이트 버튼은 Claude CLI에 붙여 넣을 메시지를 복사
- 업데이트 뒤 사이드 패널이 새 확장 버전을 알아채고 스스로 한 번 다시 불러옴
- 패널 채팅이 진행 중이면 업데이트가 데몬을 재시작하지 않고 멈춤

## 라이선스
All rights reserved. 개인용으로 공개한 배포본입니다(오픈소스 라이선스 없음). 재배포·수정 배포는 허락 없이 하지 마세요.
