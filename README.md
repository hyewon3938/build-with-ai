# build-with-ai

> Claude Code 기반 1인 개발에서 AI와 함께 일하는 방식 자체를 모아두는 공간.

특정 프로젝트가 아니라 **작업 방식**에서 쌓이는 사고·도구·결정·회고를 누적한다. 프로젝트 repo 안에 두면 다음 작업에서 다시 꺼내 쓰기 어려워서, 메타 repo로 따로 분리했다.

## 무엇이 있나

### workflow/

특정 프로젝트가 아닌 "작업 방식 자체"에 적용되는 흐름·아키텍처·도구.

- [skills-overview.md](workflow/skills-overview.md) — `/design`·`/build`·`/init-project` 스킬의 단계 흐름을 Mermaid로 시각화. 세 스킬이 무엇을 입력받아 어떤 산출물을 남기는지 한눈에.
- [design-build-skills.md](workflow/design-build-skills.md) — 사고가 휘발되지 않도록 5문서로 나눠 담는 아키텍처(plans · design-notebook · ADR · features · domains)와 스킬을 progressive disclosure로 쪼갠 이유.
- [ai-agent-risk-patterns.md](workflow/ai-agent-risk-patterns.md) — AI 에이전트와 일할 때 직접 마주친 3가지 위험 패턴(trace/dump 노출, `reset --hard` 손실, force-push로 PR 자동 close)과 그 위에 세운 가드레일.

### 향후 확장 후보

`tools/`(직접 만든 스킬·훅), `decisions/`(작업 방식 ADR), `experiments/`(시도해본 패턴), `retros/`(회고) 등 — 자산이 충분히 쌓이면 분리.

## 적용 사례

이 작업 방식이 실제 동작하는 프로젝트:

- [hyewon3938/slack-ai-agents](https://github.com/hyewon3938/slack-ai-agents) — Claude + Slack 기반 자가 운영 LLM 에이전트. 2026-03 시작 후 매일 사용·운영 중. ADR · design-notebook · domains 문서가 실제로 운영되는 곳.

## 왜 따로 있나

작업 방식에 대한 사고는 특정 프로젝트의 ADR이나 design-notebook에 두기엔 범용성이 어울리지 않는다. 그렇다고 프로젝트 repo 바깥에 흘려두면 다음 작업에서 잊힌다. 그래서 "AI와 일하는 방식"만 따로 모이는 공간이 필요했다.

이 분리 자체에 대한 상세 — [design-build-skills.md > 메타 — 이 글을 어디 둘 것인가](workflow/design-build-skills.md#메타--이-글을-어디-둘-것인가)
