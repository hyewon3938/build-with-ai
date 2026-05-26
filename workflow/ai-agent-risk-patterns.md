# AI 에이전트와 일할 때의 위험 패턴 — 직접 마주친 3가지와 가드레일

AI 에이전트와 작업하는 환경의 본질은 단순히 "AI가 코드를 짠다"가 아니라 **AI가 빠르게 명령을 실행한다**는 점이다. 빠른 실행은 생산성을 끌어올리는 동시에, 사람이 한 줄씩 칠 때 본능적으로 멈추던 지점을 그냥 통과하게 만든다. 직접 마주친 3가지 패턴과 그 위에 세운 가드레일을 정리.

## 1. trace/dump 명령이 secrets 노출 경로가 된다

### 메커니즘

`bash -x`, `set -x` 같은 trace 옵션이 켜진 상태에서 스크립트가 `.env`를 소싱하면, 모든 환경변수가 stdout/stderr에 평문으로 찍힌다. `cat .env`, `env`, `printenv`, `docker exec <c> env`, `kubectl describe secret`, `systemctl show <service>` 같은 직접 덤프 명령도 같은 부류.

### 왜 AI 협업에서 더 잠재되나

스크립트가 조용히 죽으면 사람은 한 줄씩 추적부터 한다. AI 에이전트는 반사적으로 `bash -x`로 trace 켜고 재실행한다 — 그 한 번의 실행이 `.env` 전체를 세션 로그에 덤프한다. 에이전트 세션 로그는 원격으로 전송되기 때문에 "내 로컬이니까 괜찮다"도 성립하지 않는다.

### 가드레일

- **trace/dump 명령 카테고리를 deny 후보로 분류** — `bash -x`, `set -x`, `cat .env`, `env`/`printenv`, `docker exec env`, `kubectl describe secret`, `git log -p <secrets-file>` 등을 한 곳에 명시해 두고 실행 전 자동 점검 대상으로
- **`.env`·credentials 파일은 Read로 통째로 읽지 않는다** — 존재 여부는 `grep -c '^VAR=' .env`, 특정 변수는 `bash -c '. .env && echo "VAR=$VAR"'`로 범위를 좁힘
- **디버깅 패턴 자체를 교체** — 스크립트가 조용히 죽으면 `bash -x` 대신 ① 스크립트를 Read로 읽고 실패 후보 선정 → ② 해당 후보만 고립해서 테스트 → ③ 그래도 모르면 스크립트 사본에 `echo` 주입 (secrets 소싱 전에 출력)

## 2. `git reset --hard`가 working tree의 unstaged 변경도 같이 날린다

### 메커니즘

`git reset --hard <ref>`는 commit 이력을 되돌리는 것뿐 아니라 working tree의 modified 파일까지 reflog 없이 영구 손실시킨다. unstaged 변경분이 사라지면 복구 경로가 없다.

### 왜 AI 협업에서 더 잠재되나

브랜치 정리·되돌리기 같은 단순 요청에 AI는 `reset --hard`를 옵션으로 빠르게 제시하는 경향이 있다. working tree에 modified 파일이 있는지 사전에 점검하지 않으면 사용자도 "히스토리만 되돌리는 거구나" 하고 승인하기 쉽다.

### 가드레일

- **옵션 제시 전 `git status` 확인 의무** — working tree에 변경이 있으면 `git stash push -u`로 먼저 보존하거나 사용자에게 확인 후 진행
- **옵션 설명에 영향 범위 명시** — "이 명령은 history뿐 아니라 working tree의 unstaged 변경까지 영구 손실시킴" 한 줄을 옵션 제시에 포함
- **대안 경로 우선 검토** — 단순 브랜치 이동·정리는 `git switch -c <new>` + main만 따로 처리 등 reset 없는 경로가 가능한지 먼저 확인

## 3. history rewrite + force-push가 open PR을 자동 close시킨다

### 메커니즘

오래된 커밋 정리·큰 바이너리 제거 같은 작업에서 `git filter-repo` 등 history rewrite 도구 사용 후 force-push로 main을 갱신하면, main의 commit SHA가 바뀐다. GitHub은 open PR의 base SHA가 dangling 상태인 걸 감지하고 그 PR을 자동 close한다 — 사라지지는 않지만 머지 안 된 채 닫힌다.

### 왜 AI 협업에서 더 잠재되나

history rewrite는 합리적으로 제시되는 옵션이고, 그 직후 force-push는 한 줄이라 사용자도 빠르게 승인한다. 그 사이 open PR을 점검하는 단계가 없으면 작업 누락이 발생하고, close된 PR은 알림이 약해 늦게 발견하면 작업이 있었다는 사실 자체를 잊을 수 있다.

### 가드레일

- **force-push 전 `gh pr list --state open` 점검 의무** — 진행 중인 PR이 있는지 먼저 확인
- **있으면 처리 후 진행** — 먼저 머지하거나, 브랜치 SHA를 별도 ref로 보관한 뒤 force-push
- **force-push 후 PR 카탈로그 점검** — 의도치 않게 close된 PR이 없는지 한 번 더 확인

## 시스템화 — 한 곳에 박아두기

세 패턴 모두 글로벌 CLAUDE.md(`~/.claude/CLAUDE.md`)에 박혀 모든 프로젝트에서 자동 적용된다. 프로젝트별로 같은 규칙을 다시 쓰지 않는 게 핵심 — 한 번 학습한 가드레일이 다음 프로젝트에서 자동으로 작동해야 시스템이라 부를 수 있다.

또한 세 패턴은 공통적으로 **"파괴적/비가역 명령 실행 전 영향 범위 한 줄 정리 + 사용자 공유"**라는 메타 원칙으로 묶인다. 개별 규칙이 한 케이스를 놓치더라도 메타 원칙이 한 번 더 잡는 2단 구조.

## 메타

세 패턴은 시작점이고, AI 협업에서 발생할 수 있는 위험은 누적되는 중. 새로운 패턴이 보이면 같은 형태(메커니즘 → 왜 AI 협업에서 더 잠재되나 → 가드레일)로 이 문서에 추가한다.
