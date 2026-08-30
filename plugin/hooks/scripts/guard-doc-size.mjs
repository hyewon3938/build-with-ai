#!/usr/bin/env node
// PreToolUse(Bash) 지시서 크기 가드 — 세션마다 컨텍스트에 통째로 들어가는 문서가
// 작업 기록으로 부풀어 오르는 것을 커밋 시점에 막는다. exit 2 = 차단, exit 0 = 통과.
//
// 배경 (2026-08-30, random-ai-companion): CLAUDE.md가 8일 만에 8,693자에서 52,380자가 됐다.
// 세션마다 완료한 작업의 본문을 상태 절에 덧붙인 결과다(08-29 하루에만 커밋 34건).
// 08-29에 60,947자를 27,559자로 줄인 적이 있으나 같은 날 다시 약 49,000자로 돌아왔다.
// 규칙 문장만으로는 되돌아오므로 커밋 시점에 강제한다.
//
// 판정 범위: 이번 커밋에 실리는 파일만 본다. 상한을 넘겨도 이번 커밋과 무관한 파일이면
// 통과시킨다 — 크기는 그 파일을 커밋할 때만 늘어나므로 이 범위로 충분하고,
// 관계없는 작업이 지시서 정리에 막히지 않는다.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DEFAULT_LIMITS = { "CLAUDE.md": 20000 };
const CONFIG_PATH = ".claude/doc-size.json";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cmd = String(input?.tool_input?.command ?? "");
if (!cmd) process.exit(0);

// git commit 만 대상. 전역 플래그(-C/-c/--git-dir/--work-tree) 뒤의 하위명령까지 잡는다.
const COMMIT_RE =
  /(?:^|[\s;&|(`])git(?:\s+-C\s+\S+|\s+-c\s+\S+|\s+--(?:git-dir|work-tree)(?:=|\s+)\S+)*\s+commit\b/i;
if (!COMMIT_RE.test(cmd)) process.exit(0);

const cwd = String(input?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const git = (...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const top = git("rev-parse", "--show-toplevel");
if (top.status !== 0) process.exit(0);
const root = top.stdout.trim();
if (!root) process.exit(0);

// 이번 커밋에 실리는 파일: staged + (-a/--all 이면 tracked 변경분)
const names = new Set();
const add = (r) => {
  if (r.status === 0)
    r.stdout.split("\n").forEach((l) => l.trim() && names.add(l.trim()));
};
add(git("diff", "--cached", "--name-only"));
if (/\s-[A-Za-z]*a|\s--all\b/.test(cmd)) add(git("diff", "--name-only"));
if (names.size === 0) process.exit(0);

let limits = DEFAULT_LIMITS;
const configFile = join(root, CONFIG_PATH);
if (existsSync(configFile)) {
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8"));
    if (parsed && typeof parsed === "object") limits = parsed;
  } catch {
    // 설정이 깨졌으면 기본값으로 간다 — 가드가 조용히 꺼지는 쪽이 더 나쁘다.
  }
}

const over = [];
for (const [rel, max] of Object.entries(limits)) {
  if (!names.has(rel)) continue;
  if (typeof max !== "number" || !(max > 0)) continue;
  const path = join(root, rel);
  if (!existsSync(path)) continue;
  let size;
  try {
    size = [...readFileSync(path, "utf8")].length;
  } catch {
    continue;
  }
  if (size > max) over.push({ rel, size, max });
}
if (over.length === 0) process.exit(0);

const n = (v) => v.toLocaleString("en-US");
for (const o of over)
  console.error(`⛔ 지시서 크기 가드: ${o.rel} ${n(o.size)}자 (상한 ${n(o.max)}자)`);
console.error(
  "세션마다 컨텍스트에 통째로 들어가는 파일이라 크기가 그대로 비용이 된다.",
);
console.error(
  "완료 항목은 제목·날짜·이슈 번호 한 줄로 줄이고, 무엇을 왜 그렇게 했는지는 이슈·PR 본문에 남긴다.",
);
console.error(
  `상한을 바꾸려면 ${CONFIG_PATH}에 {"<파일>": <자수>} 형태로 적는다.`,
);
process.exit(2);
