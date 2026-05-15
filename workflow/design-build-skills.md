# design/build 스킬 — 사고가 사라지지 않는 작업 흐름

> Claude Code 기반 개인 작업 환경에서 `/design`·`/build` 스킬을 어떻게 다듬어왔는지 기록.

## 문제

기능 하나를 설계할 때, AI와 인터뷰하면서 의사결정 분기점이 여러 개 나온다.
- A안 / B안 / C안 중 뭐가 나을까
- 이건 지금 하지 말고 Phase 4로 미루자
- 이 부분은 자신 없는데 일단 가보자

그런데 인터뷰가 끝나고 구현에 들어가면, 이 사고 흐름이 거의 다 휘발된다. 코드와 커밋 메시지만 남는다. 6개월 뒤에 코드를 다시 보면 "이거 왜 이렇게 했지"의 절반밖에 답이 안 나온다.

ADR(Architecture Decision Records)이 있긴 하다. 하지만 ADR은 결정만 다룬다. **결정에 이르기까지의 분기점, 포기한 안, 회고**는 ADR의 형식에 잘 안 맞는다.

`.claude/plans/`라는 휘발성 메모 디렉터리도 만들어두긴 했지만, 작업 끝나면 다시 안 열어본다. plans는 살아있는 문서가 아니라 일회용이었다.

## 4문서 아키텍처

같은 작업의 사고를 네 군데에 다른 목적으로 나눠 담는다.

| 문서 | 역할 | 수명 | 비유 |
|------|------|------|------|
| `.claude/plans/` | 설계 직전 메모, 구현 체크리스트 | 휘발 (작업 끝나면 `_archive/`) | 회의록 |
| `docs/design-notebook/` | 마스터 단위 서사 — 분기점·포기·회고 | 영구, 누적 | 연구노트 |
| `docs/adr/` | 되돌리기 어려운 결정 (Michael Nygard 포맷) | 영구, 불변 | 판례 |
| `docs/features.md` | 현재 어떤 기능이 있는지 한눈에 | 현황 | 카탈로그 |

각 문서의 역할이 명확히 다르다.

- **plans**는 "지금 이걸 어떻게 만들지"의 메모. 코드 PR이 머지되면 가치가 거의 사라진다. 그래서 `_archive/`로 옮긴다.
- **design-notebook**은 "왜 그렇게 만들어졌는지"의 서사. 마스터 이슈 하나에 1파일, Phase 별 섹션으로 누적. 결정뿐 아니라 그 결정에 이르게 된 분기점·포기·회고까지 함께 담는다.
- **ADR**은 "이 결정은 되돌리기 어렵다"의 기록. 불변이며, 판단이 바뀌면 새 ADR을 만든다.
- **features**는 "지금 뭐가 되는지"의 카탈로그. 신규 합류자나 미래의 나에게 onboarding 자료.

이렇게 나누면 plans가 죽은 문서가 되는 문제도 해결된다. plans는 휘발해도 되는 메모로 자리잡고, 살려야 할 사고는 design-notebook으로 이주한다.

## 스킬 개편 — Progressive Disclosure

4문서 아키텍처를 도입하면서 `/design` 스킬 자체도 같이 손봤다.

### 기존 구조의 문제

`SKILL.md` 한 파일에 흐름·템플릿·체크리스트·예시가 다 들어가 있어 길어졌다 (5436 bytes). Claude Code의 Skill 시스템은 스킬이 호출되면 `SKILL.md` 전체를 컨텍스트로 로드한다. 즉 매번 토큰을 풀로 쓰고, 흐름만 빠르게 보고 싶을 때 가독성도 떨어졌다.

### 적용한 패턴

```
design/
├── SKILL.md                          # 짧게 (3872 bytes) — 흐름 + 단계별 1~2줄
├── references/                       # 단계별 판단 기준
│   ├── scale-judgment.md             # 소규모/중규모 판단
│   ├── adr-criteria.md               # ADR 작성 기준 + Michael Nygard 포맷
│   └── thought-extraction.md         # 인터뷰 사고 추출 기준
└── templates/                        # 산출물 템플릿
    ├── plan-template.md              # .claude/plans/ 계획서 포맷
    └── design-notebook-section.md    # design-notebook phase 섹션 포맷
```

스킬이 호출되면 `SKILL.md`만 자동 로드. 단계 진행 중 필요한 보조 파일만 그때그때 추가로 읽는다. 예를 들어 5-2 단계에서 design-notebook 갱신을 결정할 때만 `templates/design-notebook-section.md`를 로드한다.

### 결과

| 항목 | Before | After |
|------|--------|-------|
| 스킬 호출 시 로드되는 SKILL.md | 5436 bytes | 3872 bytes (~29% ↓) |
| 보조 파일 | 0 | 5개 (참조 시에만 로드) |
| 신규 단계 추가 방식 | SKILL.md에 통째로 append | SKILL.md엔 한 줄, 세부는 references/templates에 |

스킬 호출 시 매번 들어오는 컨텍스트가 줄어들고, 세부 가이드는 필요할 때만 읽힌다. 새 단계를 붙일 때도 흐름 문서를 짧게 유지하기 쉬워졌다.

### 새로 붙은 단계

- **5-2**: design-notebook 작성 여부 판단. 마스터 단위 첫 진입이거나 새 Phase 시작이면 design-notebook 섹션 갱신.
- **6-1**: 인터뷰 사고 추출. 의사결정 분기점·포기·회고를 자동 식별 (고정 개수 아니라 기준 기반).
- **6-2**: design-drafts 트리거. 구현 직전 "솔직 회고나 비공개로 남길 거 있어?" 질문 — 비공개 노트 저장 옵션.

## 비공개 드래프트 — design-drafts

설계 사고 중 일부는 공개 영역에 어울리지 않는다. 비공개 맥락, 감정 섞인 메모, 아직 정리되지 않은 가설 같은 것들.

- 경로: `docs/_personal/design-drafts/` (`.gitignore` 등록)
- 백업: iCloud 디렉터리에 실제 파일 두고, 프로젝트 안엔 symlink만. iCloud가 자동 백업.
- 트리거: `/design` 마지막 단계에서 "비공개로 남길 거 있어?" 명시적 질문.

design-notebook이 정리된 서사라면, design-drafts는 그 이전 단계의 raw 메모에 가깝다.

## 메타 — 이 글을 어디 둘 것인가

이 글 자체도 분류가 필요했다.

- 프로젝트(`slack-ai-agents`)의 design-notebook? — 아니다. 이 사고는 특정 프로젝트에 묶이지 않는다.
- 프로젝트의 ADR? — 아니다. 프로젝트 아키텍처 결정이 아니라 작업 방식 자체에 대한 결정이다.

그래서 별도의 메타 repo(이 repo)를 만들었다. 작업 방식이 자산이 되는 경우, 머무를 공간이 따로 필요했다.
