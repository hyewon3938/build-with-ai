---
description: 프로젝트 초기 세팅 - 인터뷰부터 문서 체계·GitHub·워크플로우 연결까지
disable-model-invocation: true
---

# /init-project - 프로젝트 초기 세팅 스킬

새 프로젝트의 개발 환경, 컨벤션, 문서 체계를 한번에 세팅한다.
사용자가 프로젝트 기획을 설명하면 그에 맞는 기반을 생성하고, `/design` → `/build` 워크플로우에 바로 연결한다.

## 입력

$ARGUMENTS

위 내용을 인터뷰의 출발점으로 사용한다. 비어있으면 "어떤 프로젝트를 만들고 싶어?"부터 시작한다.

## 진행 방식 — 체크포인트 3개

단계마다 확인받지 않는다. 멈추는 지점은 셋뿐이다:

1. **인터뷰 요약 확인** — 인터뷰 종료 시 정리한 내용을 확인받는다
2. **생성 계획 일괄 승인** — 만들 파일 목록 + 원격 작업 목록을 한 번에 보여주고 승인받는다
3. **원격·비가역 작업 직전** — `git push`, `gh repo edit`, `gh label create`, `gh issue create` 등 원격 상태를 바꾸는 명령은 실행 직전 개별 확인

나머지 로컬 파일 생성은 승인된 계획대로 진행한다.

## 실행 흐름

### 1. 프로젝트 인터뷰

사용자의 초기 설명을 듣고, 프로젝트 설계에 필요한 정보를 대화로 파악한다.

- 한 번에 2\~3개씩 질문 (너무 많으면 부담). 선택지가 뚜렷하면 AskUserQuestion 활용 — 옵션 라벨은 아라비아 숫자(1, 2, 3) 또는 알파벳(a, b, c)만
- 질문 영역: 목적/도메인, 기술 스택, 규모/팀, 배포/인프라, 특수 요구사항(보안·성능), **공개 여부(public repo인지)**
- 설계에 충분한 정보가 모이면 "인터뷰 끝! 정리하면..." 으로 요약 후 확인 (체크포인트 1). 사용자가 "됐어"로 끊으면 즉시 마무리

### 2. 프로젝트 분석

- 인터뷰 내용 기반으로 기술 스택 선택의 합리적 근거를 정리한다
- 각 선택의 장단점과 발생 가능한 리스크도 함께 설명한다
- "이 시점에 필요한 건지, 오버엔지니어링인지" 판단 기준을 제시한다

### 3. 문서 세트 결정 (규모 판단)

프로젝트 성격에 따라 만들 문서 세트를 정한다. 지금 필요한 것만 — 오버엔지니어링 경계.

| 프로젝트 성격 | 문서 세트 |
|------|------|
| 실험·일회성 (수명 몇 주) | 최소 세트: `CLAUDE.md` + `docs/conventions.md` |
| 지속 개발 (기능 누적, 수개월+) | 5-doc 전체: + `docs/features.md`, `docs/design-notebook/`, `docs/adr/`, `docs/project-history.md` |
| 도메인 분리가 뚜렷 (여러 하위 도메인) | + `docs/domains/<domain>.md` |

> `/design`·`/build`는 없는 문서를 만나면 해당 단계를 건너뛰도록 설계되어 있다 — 최소 세트로 시작해도 워크플로우는 동작하고, 나중에 문서를 추가하면 그때부터 자동으로 채워진다.

결정 후 **생성 계획 일괄 승인** (체크포인트 2): 파일 목록 + 원격 작업 목록 제시.

### 4. 코드 컨벤션 생성 → `docs/conventions.md`

프로젝트 성격과 팀 규모에 맞는 컨벤션을 생성한다.

- **핵심 원칙** (잘 안 바뀌는 것): 네이밍 규칙, 커밋 메시지 컨벤션(Conventional Commits 기반), 보안 규칙(env·credentials·API 키 관리), 테스트 원칙, 가독성 원칙
- **프로젝트 적응 규칙** (진행하면서 바뀔 수 있는 것): 디렉토리 구조, 추상화 수준 기준, import 정렬, 에러 핸들링 패턴, 프로젝트 특화 패턴
- **리팩토링 기준** (하단): 트리거 조건(중복 N회, 함수 길이, 복잡도), 우선순위, "지금 vs 나중에" 판단 가이드, 규모 변화 시 재검토 기준

각 섹션에 "왜 이 규칙인지" 근거를 한 줄씩 포함한다.

### 5. 브랜치 전략 수립

- 브랜치 네이밍 (feature/, fix/, refactor/ 등), main/dev 전략 또는 trunk-based 등 프로젝트에 맞는 전략 선택, PR 규칙 (1 Issue = 1 PR 등) — 근거 포함
- **main 브랜치 + GitHub default branch 정렬** (원격 작업 — 실행 직전 확인):

```bash
git branch -M main
git push -u origin main
gh repo edit --default-branch main
```

**근거:** GitHub의 default branch가 컨벤션의 base 브랜치와 다르면 `gh pr create` 시 의도치 않은 브랜치가 PR base로 설정된다.

### 6. GitHub 이슈 라벨 체계

- 프로젝트에 맞는 라벨 목록 설계 (feat, bug, refactor, docs, chore 등) + 색상 코드
- `gh label create`로 실제 생성 (원격 작업 — 실행 직전 확인)
- 라벨 사용 가이드는 `docs/conventions.md`에 포함

### 7. CLAUDE.md 생성

프로젝트 루트에 생성. 포함 내용:

- 프로젝트 개요 (아키텍처, 기술 스택), 디렉토리 구조
- 개발 규칙 요약 (핵심만, 상세는 `docs/conventions.md` 참조)
- Claude 작업 규칙: 커밋 3\~5개 쌓이거나 주제가 바뀌면 커밋/브랜치/PR 제안, 변경 전 기존 코드 읽기, 기능 추가 시 테스트 작성+실행
- 보안 규칙 — **public repo면 반드시 포함**: 민감 정보 하드코딩 금지 + **공개 텍스트 규칙** (커밋 메시지·이슈·PR은 포트폴리오용 공개 문서로 취급, 개인 상황·재정·인프라 정보 노출 금지)

### 8. 문서 체계 초기화 (3단계 결정에 따라)

5-doc 아키텍처(plans·design-notebook·adr·features·domains) + 부속 타임라인(project-history)을 골격까지 만들어 둔다. `/design`·`/build`가 이 구조를 전제로 동작한다.

| 문서 | 역할 | owner |
|------|------|-------|
| `.claude/plans/` (+`_archive/`) | 구현 직전 메모 (휘발) | `/design` 생성, `/build` 아카이브 |
| `docs/design-notebook/` | 마스터 단위 서사 (Phase 별 누적) | `/design` + `/build` |
| `docs/adr/` | 되돌리기 어려운 결정 (불변) | `/design` |
| `docs/features.md` | 현재 기능 카탈로그 | `/build` |
| `docs/domains/<domain>.md` | 도메인 상세 (스키마·API·로직) | `/design` 골격 + `/build` 본문 |
| `docs/project-history.md` | 포트폴리오 timeline (마일스톤급만) | `/build` |

생성 항목:

- `docs/project-history.md` — 프로젝트 시작 배경, 초기 설계 결정, 마일스톤 기록 형식 템플릿
- `docs/adr/` — `README.md`(인덱스 + 판단 기준 + Michael Nygard 포맷 설명), `template.md`, `0001-<초기-주요-판단>.md`(2단계에서 정리된 것 중 ADR 가치가 있는 것). 판단 기준: 되돌리기 어려움 / 대안 존재 / 장기 영향 / 온보딩 관련 / 비자명한 근거 — 2개 이상이면 작성
- `docs/features.md` — 빈 카탈로그 골격 (기능 표 + "신규 기능 머지 시 `/build`가 갱신" 주석)
- `docs/design-notebook/` — 디렉터리 + `README.md` 한 줄 (마스터 단위 1파일, phase 섹션 누적 방식 설명)
- `docs/domains/` — 해당 시. 도메인 문서 템플릿 1개
- `docs/_personal/` — **public repo면 필수**. `.gitignore`에 등록하고 비공개 문서 자리(`design-drafts/`, `portfolio-candidates.md`)를 만든다. 공개하면 안 되는 회고·개인 맥락의 단일 저장소
- `.claude/plans/` + `.claude/plans/_archive/` — 계획서 저장소. `.gitignore` 등록 여부는 프로젝트 공개 정책에 따라 결정

**ADR과 project-history의 역할 분담**: ADR = 판단의 근거와 트레이드오프 (왜), project-history = 기능 완성의 타임라인 (언제, 무엇을).

### 9. Docker 설정 (해당 시)

- Dockerfile, docker-compose.yml 기본 구조 + .dockerignore, 프로젝트 스택에 맞는 최적화

### 10. 개발 워크플로우 스킬 확인

아래 스킬은 **사용자 레벨**(`~/.claude/skills/`)에 설치되어 있으므로 프로젝트별로 생성할 필요 없다. 정상 인식되는지만 확인한다.

> 원본은 `build-with-ai` repo의 `plugin/skills/`이고 `~/.claude/skills/`는 그 심링크다 — 스킬 수정은 repo에서 하고 커밋한다. 외부 공유는 같은 repo의 플러그인 마켓플레이스로 설치 가능.

```
~/.claude/skills/
├── design/SKILL.md        # 설계 (인터뷰 → 계획서 + 문서 갱신)
├── build/SKILL.md         # 구현 (계획서 → 코드 + 내장 리뷰 + PR + 머지 후 마무리)
├── review-code/SKILL.md   # 코드 리뷰 단독 실행용
├── orchestrate/SKILL.md   # 대규모 탐색·감사용 멀티에이전트 플레이북
└── init-project/SKILL.md  # 이 스킬
```

연결 구조:

```
/init-project (1회) → /design → .claude/plans/ → /compact → /build → PR → 머지 후 마무리
                         ↑                                              │
                         └────────────── 다음 기능 ←────────────────────┘
```

스킬이 인식되지 않으면 `~/.claude/skills/` 디렉토리 존재 여부를 확인하도록 안내한다.

### 11. 초기 이슈 등록

- 프로젝트 설계에서 나온 기능 목록을 GitHub Issues로 등록 (원격 작업 — 실행 직전 확인)
- 6단계 라벨 체계에 맞춰 라벨링, 우선순위 기반 마일스톤 설정
- **이슈 본문은 공개 문서** — 기술적 개선 관점으로만 작성, 개인 상황·민감 정보 금지

### 12. 최종 확인

- 생성된 모든 파일 목록 + 각 파일의 역할 요약 출력
- 개발 워크플로우 안내:

```
기능 개발: /design → /compact → /build
소규모 수정: /design이 자동 판단하여 직접 처리
코드 리뷰만: /review-code
대규모 탐색·감사: /orchestrate
```

## 주의사항

- 모든 결정에 "왜?"를 설명한다. 기술 선택에 합리적 근거가 없으면 안 된다
- 오버엔지니어링 경계: 현재 규모에 맞는 수준으로 설정하되, 확장 포인트는 명시한다
- .env, credentials 등 민감 정보는 절대 파일에 하드코딩하지 않는다
- public repo 프로젝트는 이슈·커밋·PR 등 모든 공개 텍스트를 포트폴리오 공개 문서로 전제하고 작성한다
