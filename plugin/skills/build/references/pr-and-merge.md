# 커밋, 리뷰, PR, 머지

## 커밋

- 커밋 메시지는 프로젝트 컨벤션을 따르고, 커밋 하나에 논리 단위 하나를 담는다.
- 커밋 메시지의 `(#번호)`는 링크만 건다. 이슈는 PR 본문의 `Closes #번호`로 닫는다.
- 커밋 훅이 막으면 원인을 고친 뒤 다시 커밋한다.

## 리뷰

`git diff origin/<base>...HEAD --stat`으로 범위를 보고, 바뀐 파일을 다시 읽으며 점검한다. 보안 감사는 내장 리뷰를 썼더라도 항상 직접 한다.

| 점검 항목 | 심각도 |
|----------|--------|
| 크리덴셜 하드코딩 | CRITICAL |
| 환경변수 파일이 커밋에 포함됨 | CRITICAL |
| raw query의 SQL Injection 가능성 | HIGH |
| 외부 입력 미검증 | HIGH |
| 민감 정보 로그 출력 | MEDIUM |
| 에러 메시지의 내부 정보 노출 | LOW |

CRITICAL과 HIGH는 머지 전에 고친다. 환경에 내장 `/code-review`가 있으면 중규모 이상 PR에서 먼저 돌려 새 맥락의 리뷰를 받고, 그 결과를 합친다.

sonnet 세션이 opus 서브에이전트에 리뷰를 맡길 때는 지시서에 base 브랜치, 리뷰할 브랜치, review-code SKILL.md 경로, 반환 형식, 파일 수정 금지를 적는다. 반환 형식은 보안 감사 결과, 품질 경고, 지금 고칠 것과 나중에 고칠 것을 파일과 줄 번호로 적은 목록이다.

## PR

```bash
git push -u origin <브랜치>
gh pr create --base <base> --title "<커밋 컨벤션 제목>" --body-file <본문 파일>
```

본문 형식은 아래와 같다. 이슈를 쓰지 않는 repo는 관련 이슈 절을 뺀다.

```markdown
## 관련 이슈
Closes #N

## 변경 내용
- ...

## 코드 리뷰 결과
- 고친 것: ...
- 안 고친 것과 까닭: ...

## 테스트
- ...
```

- 프로젝트 CLAUDE.md가 특정 파일을 고친 PR에 라벨을 붙이라고 하면 붙인다.
- 제목과 본문은 공개 텍스트라서 writing 스킬 규칙으로 쓰고 보안 규칙을 지킨다.

## CI

```bash
gh pr checks <N> --watch
```

실패하면 원인을 고치고 다시 푸시해 통과를 확인한다. 체크가 없는 repo는 없다고 보고한다.

## 머지

머지 방식은 프로젝트 CLAUDE.md를 따르고, 정한 것이 없으면 `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`에서 허용된 방식을 확인하고, 둘 이상이면 `git log --oneline -10 origin/<base>`에서 최근 PR이 들어온 방식을 따른다. worktree 안에서 `--delete-branch`를 붙이면 gh가 base 브랜치를 체크아웃하려다 메인 체크아웃이 그 브랜치를 쓰고 있어 실패하므로, 아래 명령으로 머지만 하고 브랜치는 마무리 단계에서 지운다.

```bash
gh pr merge <N> --<방식>
gh pr view <N> --json state,mergedAt,mergeCommit
```

state가 MERGED인지 확인한 뒤 base 브랜치 CI를 본다. 실행 중이면 `gh run watch <run-id>`로 끝까지 본다.

```bash
gh run list --branch <base> --limit 3
```
