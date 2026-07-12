# 스킬 흐름 시각화 — `/design` · `/build` · `/init-project`

Claude Code 기반 개인 작업에서 가장 자주 쓰는 세 스킬의 단계 흐름을 다이어그램으로 정리한 문서. 각 스킬이 무엇을 입력으로 받아 어떤 산출물을 남기는지 한눈에 보기 위해 만들었다.

세 스킬의 상세 단계 정의는 글로벌 스킬 파일에 있다:

- `/design` → `~/.claude/skills/design/SKILL.md`
- `/build` → `~/.claude/skills/build/SKILL.md`
- `/init-project` → `~/.claude/skills/init-project/SKILL.md`

설계 사상(왜 이렇게 나눴는지, 5문서 아키텍처, progressive disclosure)은 [design-build-skills.md](design-build-skills.md)에 따로 정리.

## 세 스킬의 관계

새 프로젝트는 `/init-project`로 기반(컨벤션·라벨·5-doc 문서 체계 등)을 깔고, 그 위에서 기능 단위 작업은 `/design`이 계획서를 만들고 `/build`가 구현·리뷰·PR·머지 후 마무리까지 끌고 간다.

```mermaid
graph LR
    NP([새 프로젝트]) -->|/init-project| IP[프로젝트 기반<br/>conventions · CLAUDE.md<br/>5-doc 체계 · 라벨]
    IP --> RQ([기능 요청])
    RQ -->|/design| PL[(계획서<br/>.claude/plans/)]
    PL -->|/compact + /build| BD[구현 + 리뷰 + PR]
    BD --> MW[머지 후 마무리<br/>CI·배포 확인<br/>계획서 아카이브]
    MW --> RQ2([다음 기능])
    RQ2 -.-> PL

    classDef io fill:#f3f4f6,stroke:#6b7280,color:#111827
    classDef skill fill:#ecfdf5,stroke:#10b981,color:#065f46
    classDef artifact fill:#fff7ed,stroke:#f97316,color:#9a3412

    class NP,RQ,RQ2 io
    class IP,BD,MW skill
    class PL artifact
```

## /design

요청을 받아 인터뷰 → 계획서 작성 → 사고 흐름 추출까지. 핵심은 **계획서 하나만 떨어뜨리지 않는다**는 점 — 마스터 단위 서사(design-notebook), 되돌리기 어려운 결정(ADR), 도메인 명세 골격(domains/), 비공개 회고(drafts), 포폴 어필 후보(portfolio-candidates)를 각자의 owner와 수명에 맞춰 동시에 갱신한다.

```mermaid
graph LR
    Q([요청]) --> CC[마스터 cross-check<br/>ADR · 핵심 원칙<br/>+ 직전 phase 기록 회수]
    CC --> I[인터뷰<br/>핵심·맥락 묶어 질문<br/>핵심 결정 체크포인트]
    I --> S{규모 판단}
    S -->|소규모| D[직접 처리 → 커밋]
    S -->|중규모+| GH[이슈 + 브랜치<br/>공개 텍스트 보안]
    GH --> EX[코드베이스 탐색<br/>scout 병렬 위임]
    EX --> P[(계획서<br/>.claude/plans/)]
    P --> ADR[(ADR<br/>해당 시)]
    P --> DN[(design-notebook<br/>phase 섹션)]
    P --> DOM[(domains<br/>phase 골격)]
    P --> TE[사고 추출<br/>분기점·포기·회고]
    TE --> PC[(portfolio-candidates<br/>비공개)]
    TE --> DD[(design-drafts<br/>비공개)]
    P --> CF([확인 → /build])

    classDef io fill:#f3f4f6,stroke:#6b7280,color:#111827
    classDef judge fill:#fff7ed,stroke:#f97316,color:#9a3412
    classDef public fill:#ecfdf5,stroke:#10b981,color:#065f46
    classDef private fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a

    class Q,CF,D io
    class CC,I,S,TE,EX judge
    class P,ADR,DN,DOM,GH public
    class PC,DD private
```

**핵심 분기점**

- *규모 판단* — 소규모(파일 1\~2개)는 직접 처리하고 커밋. 중규모+는 이슈+브랜치 경유.
- *마스터 cross-check* — 마스터 phase 진입이면 ADR / 핵심 원칙 / 이전 결정을 먼저 점검. 여기에 **직전 phase의 project-history·features 기록 누락 회수**가 붙어 있어, 스킬 밖에서 close된 작업의 문서 누락을 다음 진입 때 주워 온다. 이걸 빼면 핵심 원칙과 충돌하는 안을 무의식적으로 제안하는 사고가 난다 (2026-05-16 인터뷰에서 실제 발생).
- *인터뷰 체크포인트* — 질문은 핵심·맥락을 묶어 한 번에 던지고, 설계의 뼈대가 되는 결정만 개념·흐름 수준으로 정리해 명시적으로 확인받는다. 디테일은 위임, 핵심은 사용자가 직접 검증.
- *사고 추출* — 의사결정 분기점·포기한 안·회고를 추출해 design-notebook(공개)에 통합. 감정·솔직 회고는 design-drafts(비공개)로.

## /build

계획서를 로드해 구현 → 코드 리뷰 → 정적 검사·테스트 → PR → 머지 후 마무리. 구현 단계가 단순한 "코드만 짜기"가 아니라 **ADR 본문 채우기 · 도메인 문서 본문 채우기 · features 카탈로그 갱신 · 폐기 처리 시 카탈로그 정리**까지 같이 묶이는 게 핵심. 코드만 머지되고 문서가 비어 있으면 다음 phase에서 같은 작업이 반복된다 (2026-05-17 인사이트 v2 Phase 3 사례).

```mermaid
graph LR
    L([계획서 로드]) --> CK[브랜치 확인]
    CK --> IMP[구현<br/>독립 단위 worker 병렬]
    IMP --> ADRB[ADR 본문<br/>해당 시]
    IMP --> DOMB[domains 본문<br/>TODO → 본문]
    IMP --> FT[features 갱신<br/>신규 기능 시]
    IMP --> RM[폐기 정리<br/>features · domains · README]
    ADRB --> C[커밋]
    DOMB --> C
    FT --> C
    RM --> C
    IMP --> C
    C --> R[코드 리뷰<br/>변경 파일 Read<br/>보안 + 품질]
    R --> T[정적 검사<br/>+ 테스트]
    T --> PR([PR 생성<br/>Closes #N])
    PR --> CI[CI 확인<br/>gh pr checks --watch]
    CI --> HI[(history<br/>마일스톤급만)]
    CI --> MC[마스터 마감<br/>notebook 결과<br/>+ 메모리 정리]
    CI -->|사용자 머지 뒤| MW[머지 후 마무리<br/>배포·프로덕션 검증<br/>계획서 _archive · history 재점검]

    classDef io fill:#f3f4f6,stroke:#6b7280,color:#111827
    classDef code fill:#ecfdf5,stroke:#10b981,color:#065f46
    classDef check fill:#fff7ed,stroke:#f97316,color:#9a3412
    classDef doc fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a

    class L,PR io
    class IMP,C,CK code
    class R,T,CI,MW check
    class ADRB,DOMB,RM,FT,HI,MC doc
```

**핵심 분기점**

- *코드 리뷰* — 체크리스트 나열이 아니라 **변경된 모든 파일을 Read로 다시 읽은 뒤** 보안+품질 점검. 강제하지 않으면 리뷰가 형식이 된다.
- *카탈로그 갱신* — 신규 기능은 features.md에 항목 추가(3-4), 기능 제거 PR은 폐기 키워드 grep으로 features.md · domains · README 잔존 흔적 정리(3-3). 추가·제거가 대칭이라 한쪽만 반영하면 카탈로그가 조용히 뒤처진다 (2026-05-17 dev-report 폐기 잔존 / 2026-07 사주 통합 기능군 누락 사례).
- *CI 확인* — PR 생성 직후 `gh pr checks --watch`로 CI 통과를 확인하고서야 완료로 넘어간다. "될 것이다"로 보고하지 않는다.
- *마스터 마감* — 마스터 이슈의 마지막 phase이거나 마스터 close 시 design-notebook 결과 섹션 + 마스터 단위 메모리 정리까지 한 사이클로.
- *머지 후 마무리* — 사용자가 머지하면 CI·배포 확인 → 프로덕션 검증 → 계획서 `_archive/` 이동(close된 잔존 계획서 일괄) → project-history 재점검. 아카이브 담당 단계가 없으면 plans 휘발 정책이 죽는다.

## /init-project

새 프로젝트 한 번만 쓰는 스킬. 인터뷰 → 규모 판단 → 컨벤션 → CLAUDE.md → 5-doc 초기화 → Docker → 스킬 확인 → 원격 반영(라벨·이슈) 순서로 깐다. 진행은 매 단계 확인이 아니라 **체크포인트 3개**(인터뷰 요약 / 생성 계획 일괄 승인 / 원격·비가역 작업 직전)로만 끊는다. `/design`·`/build`가 돌아갈 수 있는 기반을 만드는 단계.

```mermaid
graph LR
    Q([프로젝트 기획]) --> IN[인터뷰<br/>목적 · 스택 · 규모]
    IN --> CP1{{"체크포인트 1<br/>인터뷰 요약 확인"}}
    CP1 --> AN[분석<br/>스택 근거<br/>오버엔지니어링 점검]
    AN --> DS[문서 세트 규모 판단<br/>실험 / 지속개발 / 도메인분리]
    DS --> CP2{{"체크포인트 2<br/>생성 계획 일괄 승인"}}
    CP2 --> CV[(conventions.md<br/>네이밍 · 커밋 · 보안<br/>+ 리팩토링 기준)]
    CV --> CM[(CLAUDE.md)]
    CM --> DOCS[(5-doc 초기화<br/>features · design-notebook<br/>adr · history · _personal)]
    DOCS --> DK[Docker<br/>해당 시]
    DK --> SK[스킬 확인<br/>design · build<br/>review-code · orchestrate]
    SK --> CP3{{"체크포인트 3<br/>원격·비가역 작업 직전"}}
    CP3 --> RMT[브랜치·main default<br/>라벨 · 초기 이슈<br/>원격 반영]
    RMT --> O([워크플로우 안내])

    classDef io fill:#f3f4f6,stroke:#6b7280,color:#111827
    classDef interview fill:#fff7ed,stroke:#f97316,color:#9a3412
    classDef doc fill:#ecfdf5,stroke:#10b981,color:#065f46
    classDef external fill:#fef2f2,stroke:#ef4444,color:#991b1b

    class Q,O io
    class IN,AN,DS,CP1,CP2,CP3 interview
    class CV,CM,DOCS doc
    class DK,SK,RMT external
```

**핵심 산출물**

- 문서 세트 규모 판단 — 실험·일회성이면 최소 세트(`CLAUDE.md` + `conventions.md`), 지속 개발이면 5-doc 전체, 도메인 분리가 뚜렷하면 `docs/domains/`까지. 오버엔지니어링 경계.
- `docs/conventions.md` — 네이밍·커밋·보안·테스트 원칙 + 리팩토링 기준
- `CLAUDE.md` — Claude 작업 규칙 (커밋 단위, 보안, 테스트 등)
- 5-doc 초기화 — `features.md` 골격 · `design-notebook/` · `docs/adr/`(README·template·0001) · `project-history.md` · `docs/_personal/`(+`.gitignore`) · `.claude/plans/_archive/`
- GitHub 라벨 + default branch 설정 — 이후 `/design`이 만드는 이슈/PR이 일관성을 가짐

> 리뷰는 `/build`에 내장돼 있고, 단독 실행용 `/review-code`도 따로 있다 — `/init-project`는 둘 다 인식만 확인한다.

## 색상 범례

| 색 | 의미 |
|----|------|
| 회색 | 입력/출력 (사용자 요청, 완료 지점) |
| 주황 | 의사결정·판단·인터뷰 단계 |
| 초록 | 공개 산출물 (코드, 이슈, ADR, design-notebook, domains, features 등) |
| 파랑 | 비공개 산출물 (portfolio-candidates, design-drafts) |
| 빨강 | 외부 시스템 연동 (GitHub, Docker 등) |
