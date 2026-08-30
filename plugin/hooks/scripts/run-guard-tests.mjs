#!/usr/bin/env node
// 가드 훅 회귀 테스트 — 가드 스크립트 수정 후 반드시 실행: node run-guard-tests.mjs
// 케이스를 파일에 두는 이유: Bash 명령 문자열에 금지 패턴 리터럴이 실리면
// 활성화된 가드 훅이 테스트 명령 자체를 차단한다.
// 우회 케이스 11건(개행·래퍼 접두·-C·플래그 후치·대문자)은 적대적 검증에서 실증된 것 — 제거 금지.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const CASES = {
  "guard-secrets.mjs": {
    block: [
      "bash -x deploy.sh",
      "sh -ex run.sh",
      "source .env && echo hi",
      ". ./prod/.env",
      "docker exec app env",
      "kubectl exec pod -- printenv",
      "eval $(cat ./x/.env)",
      "cat /srv/app/.env",
      "tail -n5 ../.env.production",
      "set -x; ./run.sh",
      // 구간 판정 도입 후에도 같은 구간의 덤프+참조는 계속 차단되는지 확인
      "cat .env | grep KEY",
      "head -2 ./prod/.env.local && echo done",
    ],
    allow: [
      "cat .env.example",
      "grep -c '^KEY=' .env",
      "cat notes.envelope",
      "yarn test",
      "npx tsc --noEmit",
      "git log --oneline",
      // 2026-07-27 실증 오탐: jq 필터의 .env 필드 참조가 파이프라인의 다른 구간에 있는 경우
      "cat ~/.claude/settings.json | jq '.env'",
      "cat settings.json | jq '.env | keys'",
      "head -c 200000 session.jsonl | jq -r '.env.CLAUDE_CODE_EFFORT_LEVEL // empty'",
    ],
  },
  "guard-destructive.mjs": {
    block: [
      // 정규형
      "git reset --hard origin/main",
      "cd x && git reset --hard HEAD~1",
      "git push --force origin main",
      "git push -f",
      "git clean -fd",
      "vercel env rm FOO production",
      'ssh prod-host "git reset --hard origin/main"',
      // 적대적 검증에서 실증된 우회형 (앵커 보강 후 차단 유지 확인용)
      "echo x\ngit reset --hard origin/main",
      "printf x\ngit push -f",
      "git -C /tmp/x reset --hard",
      "git -C /tmp/x push --force",
      "command git reset --hard",
      "command git push --force",
      "sudo git clean -fd",
      "nohup git push --force",
      "git reset HEAD~1 --hard",
      "git clean -d -f",
      "GIT reset --hard",
      "git push origin main --force",
      // 인용 내부라도 공백+패턴이면 과잉 차단 — 안전 편향으로 의도된 동작
      'echo "run git push --force now"',
    ],
    allow: [
      "git push --force-with-lease origin feat",
      "git reset --soft HEAD~1",
      "git reset HEAD file.ts",
      "git clean -n",
      "git push origin main",
      'rg "git reset --hard" docs/',
      'git commit -m "fix: force 옵션 설명"',
      "git push origin main && git status --short",
    ],
  },
};

// 파일 크기 가드는 명령 문자열만으로 판정할 수 없다 — 이번 커밋에 실리는 파일과 그 크기를
// 함께 보므로 임시 git 저장소를 만들어 확인한다.
function docSizeCases() {
  const repo = mkdtempSync(join(tmpdir(), "guard-doc-size-"));
  const bare = mkdtempSync(join(tmpdir(), "guard-doc-size-nogit-"));
  const git = (...args) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  const write = (n) =>
    writeFileSync(join(repo, "CLAUDE.md"), "가".repeat(n), "utf8");
  const hook = (command, cwd = repo) =>
    spawnSync("node", [join(here, "guard-doc-size.mjs")], {
      input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
      encoding: "utf8",
    }).status;
  const commit = 'git commit -m "docs: 상태 절 기록"';
  const out = [];

  write(100);
  git("add", "CLAUDE.md");
  git("commit", "-qm", "init");

  write(20001);
  git("add", "CLAUDE.md");
  out.push(["상한 초과 + 스테이지됨", hook(commit), 2]);
  out.push(["커밋이 아닌 명령", hook("git status --short"), 0]);
  out.push(["래퍼 접두 + 개행", hook('echo x\nsudo git commit -m "x"'), 2]);
  out.push(["git -C 뒤 commit", hook("git -C . commit -m x"), 2]);

  write(19999);
  git("add", "CLAUDE.md");
  out.push(["상한 이하", hook(commit), 0]);

  // 초과이지만 이번 커밋에 안 실리는 경우
  git("reset", "-q");
  write(20001);
  writeFileSync(join(repo, "other.ts"), "x", "utf8");
  git("add", "other.ts");
  out.push(["초과이나 다른 파일만 스테이지", hook(commit), 0]);
  out.push(["-am 은 추적 중 변경분까지", hook('git commit -am "x"'), 2]);

  // 프로젝트가 상한을 다시 정한 경우
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude/doc-size.json"),
    JSON.stringify({ "CLAUDE.md": 30000 }),
    "utf8",
  );
  git("add", "CLAUDE.md");
  out.push(["설정으로 상한 상향", hook(commit), 0]);
  writeFileSync(join(repo, ".claude/doc-size.json"), "{ 깨진 json", "utf8");
  out.push(["설정이 깨졌으면 기본 상한", hook(commit), 2]);

  out.push(["git 저장소 밖", hook(commit, bare), 0]);

  rmSync(repo, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  return out;
}

let pass = 0;
let fail = 0;
for (const [script, { block, allow }] of Object.entries(CASES)) {
  for (const [cases, want] of [
    [block, 2],
    [allow, 0],
  ]) {
    for (const command of cases) {
      const r = spawnSync("node", [join(here, script)], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
      });
      if (r.status === want) {
        pass++;
      } else {
        fail++;
        console.error(
          `MISS [${script}] want=${want} got=${r.status} :: ${JSON.stringify(command)}\n  stderr: ${r.stderr.split("\n")[0] ?? ""}`,
        );
      }
    }
  }
}
for (const [name, got, want] of docSizeCases()) {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.error(`MISS [guard-doc-size.mjs] want=${want} got=${got} :: ${name}`);
  }
}
console.log(`${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok / ${fail} miss`);
process.exit(fail === 0 ? 0 : 1);
