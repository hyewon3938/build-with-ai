#!/usr/bin/env node
// PreToolUse(Bash) 파괴적 명령 가드 — 실제 사고 이력이 있는 명령 4종을 차단한다.
// exit 2 = 차단, exit 0 = 통과.
//
// 앵커 설계 (적대적 검증에서 우회 11건 발견 후 보강):
// - 명령 위치 = 문자열 시작 / 공백·개행·; & | ( ` 뒤 / ssh <host> ["']? 뒤
//   (\s 포함이라 `command git`, `sudo git`, 다중행 2행+ 전부 걸린다)
// - git 전역 플래그(-C <dir>, -c k=v, --git-dir, --work-tree) 통과 후 하위명령 매칭
// - 위험 플래그는 lookahead로 위치 무관 탐지 (단 ; | & 넘어가진 않음)
// - 대소문자 무시(i) — macOS FS는 GIT도 실행된다
// - grep/echo의 "..." 인용 직후는 앵커 미충족(따옴표는 \s 아님)이라 통과하나,
//   인용 내부에 공백+패턴이 있으면 과잉 차단될 수 있다 — 안전 편향으로 수용.
import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cmd = String(input?.tool_input?.command ?? "");
if (!cmd) process.exit(0);

// 명령 위치 앵커 + git 전역 플래그 스킵
const G =
  "(?:^|[\\s;&|(`]|\\bssh\\s+\\S+\\s+[\"']?)git(?:\\s+-C\\s+\\S+|\\s+-c\\s+\\S+|\\s+--(?:git-dir|work-tree)(?:=|\\s+)\\S+)*\\s+";

const RULES = [
  {
    re: new RegExp(G + "reset\\b(?=[^\\n;|&]*\\s--hard\\b)", "i"),
    msg: "git reset --hard 차단 — working tree의 미커밋 변경까지 복구 불가로 소멸한 사고 이력. git status 확인 → 필요 시 git stash push -u → 사용자가 직접 실행.",
  },
  {
    re: new RegExp(
      G + "push\\b(?=[^\\n;|&]*(?:\\s--force(?!-with-lease)\\b|\\s-f\\b))",
      "i",
    ),
    msg: "force-push 차단 — history rewrite로 open PR이 자동 close된 사고 이력. gh pr list --state open 점검 후 --force-with-lease로, 실행은 사용자가 직접.",
  },
  {
    re: new RegExp(G + "clean\\b(?=[^\\n;|&]*\\s-[A-Za-z]*f)", "i"),
    msg: "git clean -f 차단 — untracked 파일 영구 삭제. git clean -n(드라이런)으로 대상 확인 후 사용자가 직접 실행.",
  },
  {
    re: /(?:^|[\s;&|(`]|\bssh\s+\S+\s+["']?)vercel\s+env\s+rm\b/i,
    msg: "vercel env rm 차단 — CLI 버그로 shared 변수가 전체 환경에서 삭제된 이력. Vercel 대시보드에서 삭제할 것.",
  },
];

for (const r of RULES) {
  if (r.re.test(cmd)) {
    console.error(`⛔ 파괴 명령 가드: ${r.msg}`);
    console.error(`Command: ${cmd}`);
    process.exit(2);
  }
}
process.exit(0);
