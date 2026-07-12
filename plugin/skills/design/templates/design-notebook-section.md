# design-notebook Phase 섹션 템플릿

> `docs/design-notebook/<master-slug>.md` 안의 Phase 섹션 포맷.

## 마스터 파일 전체 구조 (참고)

```markdown
# <마스터 이슈 제목>

> 마스터 이슈: #M
> 시작: YYYY-MM-DD
> 상태: 진행 중 | 완료 | 보류

## 개요

[마스터 단위 목표 1~2단락]

## 전체 Phase 흐름

- [x] Phase 1: ... (#N, YYYY-MM-DD 완료)
- [ ] Phase 2: ... (#N, 진행 중)
- [ ] Phase 3: ... (예정)

---

## Phase 1: <이름> (YYYY-MM-DD)

[Phase 섹션 — 아래 템플릿]

---

## Phase 2: <이름> (YYYY-MM-DD)

[Phase 섹션 — 아래 템플릿]
```

## Phase 섹션 템플릿

```markdown
## Phase N: <이름> (YYYY-MM-DD)

- 이슈: #N
- 관련 ADR: ADR-NNNN (해당 시)
- 관련 계획서: `.claude/plans/N-*.md`
- 상태: 설계 완료 | 구현 중 | 머지 완료

### 결정 요약

[이 Phase에서 무엇을 만들고 무엇을 안 만들기로 결정했는지 3~5줄]

### 의사결정 분기점

> "왜 A가 아닌 B를 택했는지"

- **<주제 1>**: A안 / B안 / C안 검토 → X 채택. 이유: ...
- **<주제 2>**: ...

### 포기한 안 / 미룬 항목

> "Y는 안 했는데 그 이유는"

- **<항목 1>**: Phase N+1로 미룸. 트리거: 1주 운영 후 ... 패턴 보이면 / 사용자 피드백 ... 인 경우
- **<항목 2>**: 영구 기각. 이유: ...

### 미해결·가설

> "이 부분은 자신 없는데 일단 가보는 부분"

- **<가설 1>**: 검증 시점 = 1주 운영 후. 검증 방법: ...
- **<가설 2>**: 데이터 부족으로 일단 추정. 데이터 쌓이면 재검토.

### 회고

[Phase 머지 후 채움 — 구현 중 발견한 점, 설계가 어긋난 부분, 다음 phase로의 시사점]
```

## 작성 원칙

- **마스터 단위 1파일**. phase 별 섹션 누적.
- **새 phase 시작 시** 새 섹션 append (기존 섹션 수정 X).
- 회고는 phase 머지 **후** 채움. 설계 단계에서는 비워둬도 OK.
- 의사결정 분기점/포기 항목은 인터뷰 사고 추출(`references/thought-extraction.md`)에서 자동 식별된 것을 기반으로.

## 마스터 슬러그 결정

`docs/design-notebook/<master-slug>.md`의 `<master-slug>`는:
- 마스터 이슈 제목에서 핵심 키워드 추출 (kebab-case)
- 예: "프로액티브 인사이트 v2" → `insight-engine-v2.md`
- 예: "사주 분석 개인화" → `saju-personalization.md`
