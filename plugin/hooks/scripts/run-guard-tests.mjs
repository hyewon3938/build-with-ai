#!/usr/bin/env node
// 가드 훅 회귀 테스트 — 가드 스크립트 수정 후 반드시 실행: node run-guard-tests.mjs
// 케이스를 파일에 두는 이유: Bash 명령 문자열에 금지 패턴 리터럴이 실리면
// 활성화된 가드 훅이 테스트 명령 자체를 차단한다.
// 우회 케이스 11건(개행·래퍼 접두·-C·플래그 후치·대문자)은 적대적 검증에서 실증된 것 — 제거 금지.
import { spawnSync } from "node:child_process";
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
console.log(`${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok / ${fail} miss`);
process.exit(fail === 0 ? 0 : 1);
