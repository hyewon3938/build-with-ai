#!/usr/bin/env node
// worktree에 메인 체크아웃의 gitignored 문서를 심링크한다.
//
// 사용: node <build 스킬 폴더>/scripts/worktree-links.mjs [경로...]
// worktree 안에서 실행한다. 경로를 주지 않으면 LOCAL-*.md, docs, .claude/plans를 본다. 메인 체크아웃에서
// gitignored로 잡히는 항목을 git이 알려 주는 단위대로 링크한다. 폴더 전체가 무시되면 폴더 하나를, 추적
// 파일과 섞인 폴더면 파일마다 링크한다. 추적 파일이 있는 폴더를 통째로 링크하면 worktree에서 그 파일들이
// 삭제로 잡히기 때문이다. worktree에 이미 있는 경로는 건드리지 않는다.
// 종료 코드는 성공 0, 만든 링크가 추적 안 된 파일로 잡히면 1, 메인 체크아웃에서 실행했거나 git 명령이
// 실패하면 2다.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_PATHSPECS = ["LOCAL-*.md", "docs", ".claude/plans"];
const SKIP_NAMES = new Set([".DS_Store"]);

const args = process.argv.slice(2);
const pathspecs = args.length > 0 ? args : DEFAULT_PATHSPECS;

const git = (gitArgs, cwd) =>
  execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const fail = (err) => {
  // stderr에 경로가 섞일 수 있어 종료 코드만 알린다.
  console.error(`git 명령이 실패했다: ${err?.status ?? "unknown"}`);
  process.exit(2);
};

let top;
let main;
let listing;
try {
  top = git(["rev-parse", "--show-toplevel"]).trim();
  main = git(["worktree", "list", "--porcelain"])
    .split("\n")
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!main) throw new Error("no main worktree");
  if (realpathSync(top) === realpathSync(main)) {
    console.error("메인 체크아웃에서 실행했다. worktree 안에서 실행한다.");
    process.exit(2);
  }
  listing = git(
    [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "--",
      ...pathspecs,
    ],
    main,
  );
} catch (err) {
  fail(err);
}

const made = [];
let kept = 0;
for (const entry of listing.split("\0")) {
  const rel = entry.replace(/\/$/, "");
  if (!rel || SKIP_NAMES.has(basename(rel))) continue;
  const link = join(top, rel);
  if (exists(link)) {
    kept++;
    continue;
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(main, rel), link);
  made.push(rel);
}
console.log(
  `링크 ${made.length}개를 만들고, 이미 있던 경로 ${kept}개는 두었다.`,
);

// 끝에 /가 붙은 무시 패턴은 폴더에만 걸려서, 같은 이름의 링크는 추적 안 된 파일로 잡힌다.
if (made.length > 0) {
  let status;
  try {
    status = git(
      ["--literal-pathspecs", "status", "--porcelain", "-z", "--", ...made],
      top,
    );
  } catch (err) {
    fail(err);
  }
  const untracked = status
    .split("\0")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
  if (untracked.length > 0) {
    console.error(
      `링크 ${untracked.length}개가 추적 안 된 파일로 잡힌다. 커밋에 섞이지 않게 git rev-parse --git-path info/exclude가 알려 주는 파일에 넣는다.`,
    );
    for (const path of untracked) console.error(`  ${path}`);
    process.exit(1);
  }
}
