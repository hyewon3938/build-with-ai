# build-with-ai

> Claude Code 기반 1인 개발에서 AI와 함께 일하는 방식 자체를 모아두는 공간.

특정 프로젝트가 아니라 **작업 방식**에서 쌓이는 사고·도구·결정·회고를 누적한다. 프로젝트 repo 안에 두면 다음 작업에서 다시 꺼내 쓰기 어려워서, 메타 repo로 따로 분리했다.

## 무엇이 있나

### workflow/

특정 프로젝트가 아닌 "작업 방식 자체"에 적용되는 흐름·아키텍처·도구.

- [system-map.md](workflow/system-map.md) — **시스템 전체 지도**: 무엇이 언제 로드되고(상주·호출 시·스폰 시), 어디서 강제되고(문장<단계<훅), 사람은 어디서만 개입하는가. 전체 구성은 이 글부터.
- [skills-overview.md](workflow/skills-overview.md) — `/init-project`·`/design`·`/next`·`/build`·`/deploy`·`/track`·`/slack-feedback` 스킬의 단계 흐름을 Mermaid로 시각화. 기획한 일이 대기열 행이 되고, 구현과 머지를 거쳐 배포와 배포 뒤 확인까지 가는 길을 한눈에.
- [design-build-skills.md](workflow/design-build-skills.md) — 사고가 휘발되지 않도록 커밋하는 문서 5종과 커밋하지 않는 대기열·확인 목록 파일에 나눠 담고 문서마다 owner를 정한 구조, 스킬을 progressive disclosure로 쪼갠 이유, 어떤 문서를 커밋하고 어떤 문서를 커밋하지 않는 폴더에 둘지 정한 공개 범위 기준.
- [ai-agent-risk-patterns.md](workflow/ai-agent-risk-patterns.md) — AI 에이전트와 일할 때 직접 마주친 4가지 위험 패턴(trace/dump 노출, `reset --hard` 손실, force-push로 PR 자동 close, 컨테이너 재생성 배포로 로그 소실)과 그 위에 세운 가드레일.
- [charters-as-shared-vocabulary.md](workflow/charters-as-shared-vocabulary.md) — 명시된 설계 헌장이 단방향(AI 일관성) 장치가 아니라 양방향(사용자 조향) 도구라는 것. 사용자가 원칙으로 AI를 교정할 때 AI는 포기가 아니라 화해로 답해야 한다.
- [multi-agent-orchestration.md](workflow/multi-agent-orchestration.md) — 상위 모델에서 관찰한 오케스트레이션 습관 5가지를 설정 3종(전역 정책 · 커스텀 에이전트 · 스킬)으로 이식한 기록. 행동은 이식되고 판단은 이식되지 않는다.
- [skill-audit-2026-07.md](workflow/skill-audit-2026-07.md) — 스킬이 약속한 산출물을 실측해 워크플로우에서 안 지켜진 항목 3개를 찾아 고친 기록. owner가 표에만 있는 문서는 갱신이 멈춘다 — 역할 선언을 실행 단계로 승격.
- [de-ai-writing-patterns.md](workflow/de-ai-writing-patterns.md) — AI와 쓴 한국어 문서에서 반복되는 AI 문체·번역투 패턴 카탈로그. 문체 피드백을 트랜스크립트에서 추출해 스킬로 바꿔, 같은 지적을 초안 단계에서 걸러낸 방법.
- [instruction-sheet-vs-watch-ledger.md](workflow/instruction-sheet-vs-watch-ledger.md) — 세션마다 통째로 읽히는 지시서와 배포 뒤 확인할 것을 쌓는 장부를 나누는 기준. 크기 상한은 부피를 막지만 무엇을 뺄지는 안 알려준다.
- [worktree-session-cleanup.md](workflow/worktree-session-cleanup.md) — worktree 안에서 도는 세션이 머지 뒤 정리를 사용자에게 넘기면 세션이 끝난 뒤 worktree가 하나씩 남는 문제. 막힌 원인이 세션의 위치에 있으면 worktree를 먼저 나오도록 순서를 바꾸고, 사람이 다시 요청해서 풀린 방법을 절차에 적는다.
- [queue-based-session-flow.md](workflow/queue-based-session-flow.md) — 이슈마다 계획서 파일을 만들던 방식을 대기열 파일 하나로 바꾼 기록. 세션 사이의 순서, 여는 날짜, 배포 묶음, 배포 뒤 확인을 세션 행에 적고 `/design`부터 `/track`까지 스킬 5개가 같은 행을 이어받는 흐름과 9/14~9/19 실제 사용 사례.

### 향후 확장 후보

`tools/`(직접 만든 스킬·훅), `decisions/`(작업 방식 ADR), `experiments/`(시도해본 패턴), `retros/`(회고) 등 — 자산이 충분히 쌓이면 분리.

## 플러그인으로 설치

`workflow/`가 설명하는 시스템의 실물이 [`plugin/`](plugin/)에 Claude Code 플러그인으로 들어 있다 — 스킬 10종(기획·세션 구현·다음 세션 시작·배포·배포 뒤 확인·피드백 반영·초기 세팅·리뷰·오케스트레이션·문체) + 에이전트 3종(scout·worker·verifier) + 보안 가드 훅 2종:

```
/plugin marketplace add hyewon3938/build-with-ai
/plugin install build-with-ai@build-with-ai
```

구성과 사용법은 [plugin/README.md](plugin/README.md) 참조.

## 적용 사례

이 작업 방식이 실제 동작하는 프로젝트:

- [hyewon3938/slack-ai-agents](https://github.com/hyewon3938/slack-ai-agents) — Claude + Slack 기반 자가 운영 LLM 에이전트. 2026-03 시작 후 매일 사용·운영 중. ADR · design-notebook · domains 문서가 실제로 운영되는 곳.

## 왜 따로 있나

작업 방식에 대한 사고는 특정 프로젝트의 ADR이나 design-notebook에 두기엔 범용성이 어울리지 않는다. 그렇다고 프로젝트 repo 바깥에 흘려두면 다음 작업에서 잊힌다. 그래서 "AI와 일하는 방식"만 따로 모이는 공간이 필요했다.

이 분리 자체에 대한 상세 — [design-build-skills.md > 메타 — 이 글을 어디 둘 것인가](workflow/design-build-skills.md#메타--이-글을-어디-둘-것인가)
