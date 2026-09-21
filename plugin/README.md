# build-with-ai plugin

이 저장소의 `workflow/` 글들이 설명하는 작업 시스템의 실물. 스킬 10종 + 에이전트 3종 + 가드 훅 2종을 Claude Code 플러그인으로 묶었다.

## 구성

| 종류 | 이름 | 역할 |
|------|------|------|
| 스킬 | `design` | 기획과 대기열 — 인터뷰 → 설계 문서 → 이슈 → 세션 나누기 → 대기열 파일 `LOCAL-SESSIONS.md`에 행 추가 |
| 스킬 | `build` | 세션 구현 — 대기열 행 → worktree → 구현 → 내장 리뷰 → PR·CI → 머지 후 대기열·확인 목록 갱신 |
| 스킬 | `next` | 다음 세션 시작 — 대기열 맨 앞 세션의 시작 전 확인 → `build` 연결 |
| 스킬 | `deploy` | 배포 — 머지된 변경을 운영에 올리고 배포 기록·확인 목록·배포 대기 표에 기록 |
| 스킬 | `track` | 배포 뒤 확인 목록 처리 — 조회로 판정할 항목은 닫고 대화로 볼 항목·기한 지난 항목을 모아서 질문 |
| 스킬 | `slack-feedback` | 슬랙 피드백 반영 — 새 피드백 행을 원인별로 묶어 대기열·세부 문서·확인 목록에 합치고 반영한 행 번호 기록 |
| 스킬 | `init-project` | 새 프로젝트 초기 세팅 — 컨벤션·문서 체계·대기열 파일 자리·GitHub 연결 |
| 스킬 | `review-code` | 단독 코드 리뷰 — 보안 감사 + 품질 + 컨벤션 |
| 스킬 | `orchestrate` | 멀티에이전트 플레이북 — 정찰→분해→병렬→검증→종합 |
| 스킬 | `writing` | 한국어 산문 문체 — AI 말투·번역투 금지 패턴과 교정 예시, 쓴 뒤 셀프 체크 |
| 에이전트 | `scout` / `worker` / `verifier` | 읽기 정찰 / 범위 한정 구현 / 적대적 검증 |
| 훅 | `guard-secrets` | secrets 노출 명령(트레이스 실행, .env 덤프·소싱 등) 차단 |
| 훅 | `guard-destructive` | 파괴적 명령(reset --hard, force-push, clean -f 등) 차단 |

## 설치 (외부 사용자)

```
/plugin marketplace add hyewon3938/build-with-ai
/plugin install build-with-ai@build-with-ai
```

플러그인 스킬은 네임스페이스가 붙는다: `/build-with-ai:design` 처럼 호출. 훅은 플러그인 활성화 시 자동 등록된다 (`node`가 PATH에 필요).

Claude Code에는 `/design`이라는 번들 스킬이 따로 있다. 아래처럼 심링크로 개인 스킬에 둔 `/design`은 같은 이름의 번들 스킬을 대체한다.

## 작성자 로컬 사용 방식 (bare 이름 유지)

작성자는 매일 치는 `/design` `/build` 이름을 유지하기 위해 플러그인 설치 대신 심링크를 쓴다 — 이 디렉터리가 원본이고 `~/.claude/`가 심링크:

```
~/.claude/skills/design      → <repo>/plugin/skills/design
~/.claude/agents/scout.md    → <repo>/plugin/agents/scout.md
...
```

스킬·에이전트 수정은 이 repo에서 하고 커밋한다. 훅 스크립트는 `~/.claude/settings.json`이 절대 경로로 직접 참조한다.

## 가드 훅 수정 시

패턴을 바꾸면 반드시 회귀 테스트를 돌린다:

```
node plugin/hooks/scripts/run-guard-tests.mjs
```

테스트 케이스를 파일에 두는 이유: Bash 명령 문자열에 금지 패턴 리터럴이 실리면 활성화된 가드가 테스트 명령 자체를 차단한다.
