# worktree 준비

커밋하는 세션은 `.claude/worktrees/` 아래 이름 붙인 worktree에서 한다. 메인 체크아웃은 base 브랜치에 두고 기획, 배포, 확인처럼 커밋하지 않는 일에 쓴다.

## 들어가기

- 세션이 이미 `.claude/worktrees/` 안에서 시작했으면 그 worktree를 쓴다.
- 머지 전 확인에서 이어가는 세션이면 `git worktree list`에서 그 브랜치의 worktree를 찾아 EnterWorktree에 `path`로 들어간다.
- 새로 만들 때는 EnterWorktree에 `name`으로 `<이슈번호>-<영문 요약>`을 준다. 이슈가 없으면 `<영문 요약>`만 준다. 이름 없는 worktree는 변경이 없으면 세션을 닫을 때 지워질 수 있고, gitignored 파일만 고친 경우도 변경 없음으로 판정되므로 이름을 꼭 준다.

## 브랜치 이름

EnterWorktree가 만든 브랜치를 프로젝트 규칙의 이름으로 바꾼다. 규칙이 없으면 `<타입>/<이슈번호>-<영문 요약>`을 쓴다.

```bash
git branch -m <새 브랜치 이름>
git branch --show-current
```

## gitignored 파일

1. `.env` 같은 설정 파일은 프로젝트에 `.worktreeinclude`가 있으면 EnterWorktree가 거기 적힌 파일을 복사한다. 없으면 메인 체크아웃에서 복사하고, 내용은 출력하지 않는다.

   ```bash
   test -f <메인>/.env && cp <메인>/.env .env
   ```

2. LOCAL 문서와 docs의 gitignored 문서는 메인 체크아웃 원본에 심링크한다. 링크한 파일은 worktree를 지워도 고친 내용이 메인 체크아웃에 남는다.

   ```bash
   node <이 스킬 폴더>/scripts/worktree-links.mjs
   ```

   스크립트는 `LOCAL-*.md`, `docs`, `.claude/plans`에서 메인 체크아웃이 무시하는 항목을 링크한다. 폴더 전체가 무시되면 폴더를, 추적 파일과 섞인 폴더면 파일마다 링크해서 추적 중인 문서가 삭제로 잡히지 않게 한다. 다른 경로가 필요하면 인자로 준다. 종료 코드 1이면 만든 링크가 `git status`에 추적 안 된 파일로 나온 것이라, 출력된 경로를 exclude 파일에 넣고 `git status --short`로 다시 확인한다. worktree의 `.git`은 파일이라서 exclude 파일 경로는 `git rev-parse --git-path info/exclude`로 얻는다.

## 설치와 확인

락 파일에 맞는 설치 명령을 돌린다. `yarn.lock`이면 `yarn`, `package-lock.json`이면 `npm ci`, `pnpm-lock.yaml`이면 `pnpm install --frozen-lockfile`이다. 프로젝트 CLAUDE.md가 새 작업 디렉터리에서 돌리라고 한 명령이 있으면 함께 돌린다.

```bash
git status --short
```

출력이 비어 있어야 구현을 시작한다. 무언가 나오면 원인부터 찾는다.
