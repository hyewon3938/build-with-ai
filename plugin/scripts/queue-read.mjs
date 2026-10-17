#!/usr/bin/env node
// 대기열 파일(LOCAL-SESSIONS.md)에서 필요한 부분만 뽑아 출력한다.
//
// 대기열 파일은 「지금」 절에 지난 보고가 쌓여 수십 KB를 넘기 쉽다. /next, /build, 지휘 세션이
// 파일을 통째로 읽으면 그 내용이 세션 맥락에 남아 호출마다 다시 읽히므로, 절 목록과 줄 범위를
// 먼저 보고 필요한 행과 줄만 읽게 한다.
//
// 쓰는 법: node queue-read.mjs [--file <경로>] <명령>
//   --outline          절마다 줄 범위와 크기, 「지금」·「남은 작업」은 불릿마다 첫머리와 줄 범위
//   --section <제목>   `## 제목` 절 전체
//   --lines <a-b>      줄 범위
//   --auto             「지금」의 자율 진행 불릿 첫 줄과 첫 하위 불릿 전체, 나머지 하위 불릿은 첫머리와 줄 범위
//   --rows             대기열 표의 행을 순서·세션·이슈·모델·선행·날짜·상태 칸만 줄여 한 줄씩
//   --row <세션>       대기열·배포 대기 표에서 세션 칸이 같은 행을 `칸: 값` 줄로
//   --next             대기열에서 상태가 대기인 첫 행 전체, 뒤 순서 대기 행의 선행·날짜·파일, 진행 중·머지 전 확인 행의 상태
// --file이 없으면 `git worktree list --porcelain`의 첫 worktree(메인 체크아웃)에서 LOCAL-SESSIONS.md를 찾는다.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const HEAD_LEN = 100;
const QUEUE = "대기열";
const DEPLOY = "배포 대기";
const NOW = "지금";
const REST = "남은 작업";

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { file: null, cmd: null, arg: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") opts.file = argv[++i];
    else if (["--outline", "--auto", "--rows", "--next"].includes(a))
      opts.cmd = a;
    else if (["--section", "--lines", "--row"].includes(a)) {
      opts.cmd = a;
      opts.arg = argv[++i];
      if (!opts.arg) fail(`${a} 뒤에 값이 필요하다`);
    } else fail(`모르는 인자: ${a}`);
  }
  if (!opts.cmd)
    fail(
      "명령이 없다. --outline, --section, --lines, --auto, --rows, --row, --next 가운데 하나를 준다",
    );
  return opts;
}

function findFile(given) {
  if (given) return given;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.startsWith("worktree "));
    if (line) {
      const p = join(line.slice("worktree ".length), "LOCAL-SESSIONS.md");
      if (existsSync(p)) return p;
    }
  } catch {
    // git 저장소가 아니면 현재 폴더에서 찾는다
  }
  return "LOCAL-SESSIONS.md";
}

const chars = (s) => [...s].length;
const head = (s, n = HEAD_LEN) => {
  const t = s.replace(/\*\*/g, "").trim();
  return chars(t) > n ? `${[...t].slice(0, n).join("")}…` : t;
};
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const size = (lines) => Buffer.byteLength(lines.join("\n"), "utf8");

// 절: `## 제목`부터 다음 `#`/`##` 제목 전까지. start·end는 1부터 센 줄 번호.
function sections(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (/^#{1,2} /.test(l)) {
      if (out.length && out[out.length - 1].end === null)
        out[out.length - 1].end = i;
      if (l.startsWith("## "))
        out.push({ title: l.slice(3).trim(), start: i + 1, end: null });
    }
  });
  if (out.length && out[out.length - 1].end === null)
    out[out.length - 1].end = lines.length;
  return out;
}

function sectionOf(lines, secs, title) {
  const s = secs.find((x) => x.title === title);
  return s ? { ...s, body: lines.slice(s.start - 1, s.end) } : null;
}

// 들여쓰기가 indent인 `- ` 줄마다 다음 같은 깊이 불릿 전까지를 한 덩어리로 묶는다.
function bullets(lines, from, to, indent) {
  const re = new RegExp(`^ {${indent}}- `);
  const out = [];
  for (let i = from; i <= to; i++) {
    const l = lines[i - 1];
    if (re.test(l)) out.push({ start: i, end: i });
    else if (out.length) {
      const ind = l.match(/^ */)[0].length;
      if (l.trim() === "" || ind > indent) out[out.length - 1].end = i;
      else break;
    }
  }
  for (const b of out) {
    while (b.end > b.start && lines[b.end - 1].trim() === "") b.end--;
    b.lines = lines.slice(b.start - 1, b.end);
  }
  return out;
}

function splitRow(l) {
  const cells = l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/);
  return cells.map((c) => c.trim());
}

function table(lines, sec) {
  if (!sec) return null;
  const rows = [];
  let header = null;
  for (let i = sec.start; i <= sec.end; i++) {
    const l = lines[i - 1];
    if (!l.trim().startsWith("|")) continue;
    const cells = splitRow(l);
    if (!header) header = cells;
    else if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    else rows.push({ line: i, cells });
  }
  return header ? { header, rows } : null;
}

const col = (t, name) => t.header.indexOf(name);
const cell = (t, r, name) =>
  col(t, name) >= 0 ? (r.cells[col(t, name)] ?? "") : "";

function printRow(t, r, label) {
  console.log(`[${label} ${r.line}줄]`);
  t.header.forEach((h, i) => console.log(`${h}: ${r.cells[i] ?? ""}`));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = findFile(opts.file);
  if (!existsSync(file)) fail(`대기열 파일이 없다: ${file}`);
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const secs = sections(lines);

  switch (opts.cmd) {
    case "--outline": {
      console.log(`${file} (${lines.length}줄, ${kb(size(lines))})`);
      for (const s of secs) {
        const body = lines.slice(s.start - 1, s.end);
        console.log(`## ${s.title}  ${s.start}-${s.end}줄 ${kb(size(body))}`);
        if (s.title === NOW || s.title === REST) {
          for (const b of bullets(lines, s.start + 1, s.end, 0)) {
            console.log(
              `  ${b.start}-${b.end}줄 ${kb(size(b.lines))} ${head(b.lines[0].slice(2))}`,
            );
          }
        }
        const t = table(lines, s);
        if (t && (s.title === QUEUE || s.title === DEPLOY))
          console.log(`  표 ${t.rows.length}행`);
      }
      break;
    }
    case "--section": {
      const s = sectionOf(lines, secs, opts.arg);
      if (!s)
        fail(
          `절이 없다: ## ${opts.arg}. 있는 절: ${secs.map((x) => x.title).join(", ")}`,
        );
      console.log(s.body.join("\n"));
      break;
    }
    case "--lines": {
      const m = opts.arg.match(/^(\d+)-(\d+)$/);
      if (!m) fail("--lines는 a-b 꼴로 준다");
      const a = Math.max(1, Number(m[1]));
      const b = Math.min(lines.length, Number(m[2]));
      console.log(lines.slice(a - 1, b).join("\n"));
      break;
    }
    case "--auto": {
      const s = sectionOf(lines, secs, NOW);
      const top = s
        ? bullets(lines, s.start + 1, s.end, 0).find((b) =>
            b.lines[0].startsWith("- **자율 진행.**"),
          )
        : null;
      if (!top) {
        console.log("자율 진행 불릿이 없다. 자율 진행은 꺼져 있다");
        break;
      }
      console.log(
        `[자율 진행 불릿 ${top.start}-${top.end}줄 ${kb(size(top.lines))}]`,
      );
      console.log(top.lines[0]);
      const subs = bullets(lines, top.start + 1, top.end, 2);
      subs.forEach((b, i) => {
        if (i === 0) console.log(b.lines.join("\n"));
        else
          console.log(
            `  [${b.start}-${b.end}줄 ${kb(size(b.lines))}] ${head(b.lines[0].replace(/^ {2}- /, ""))}`,
          );
      });
      break;
    }
    case "--rows": {
      const t = table(lines, sectionOf(lines, secs, QUEUE));
      if (!t) fail("대기열 표가 없다");
      for (const r of t.rows) {
        const parts = [
          `${cell(t, r, "순서")}. ${cell(t, r, "세션")}`,
          `이슈 ${head(cell(t, r, "이슈"), 20) || "-"}`,
          `모델 ${cell(t, r, "모델") || "-"}`,
          `선행 ${head(cell(t, r, "선행 세션"), 40) || "-"}`,
          `날짜 ${head(cell(t, r, "여는 날짜와 이유"), 40) || "-"}`,
          `상태 ${head(cell(t, r, "상태"), 40) || "-"}`,
        ];
        console.log(`${r.line}줄 ${parts.join(" | ")}`);
      }
      break;
    }
    case "--row": {
      const want = opts.arg.replace(/`/g, "").trim();
      let found = 0;
      for (const title of [QUEUE, DEPLOY]) {
        const t = table(lines, sectionOf(lines, secs, title));
        if (!t) continue;
        for (const r of t.rows) {
          if (cell(t, r, "세션").replace(/`/g, "").trim() === want) {
            printRow(t, r, title);
            found++;
          }
        }
      }
      if (!found)
        fail(`세션 칸이 「${want}」인 행이 대기열과 배포 대기 표에 없다`);
      break;
    }
    case "--next": {
      const t = table(lines, sectionOf(lines, secs, QUEUE));
      if (!t) fail("대기열 표가 없다");
      const waiting = t.rows.filter((r) => cell(t, r, "상태").startsWith("대기"));
      if (waiting.length) printRow(t, waiting[0], QUEUE);
      else console.log("상태가 대기인 행이 없다");
      if (waiting.length > 1) {
        console.log("[뒤 순서의 대기 행]");
        for (const r of waiting.slice(1)) {
          console.log(
            `${r.line}줄 ${cell(t, r, "순서")}. ${cell(t, r, "세션")} | 선행 ${head(cell(t, r, "선행 세션"), 60) || "-"} | 날짜 ${head(cell(t, r, "여는 날짜와 이유"), 60) || "-"} | 파일 ${head(cell(t, r, "손댈 파일"), 80) || "-"}`,
          );
        }
      }
      const busy = t.rows.filter((r) =>
        /^(진행 중|머지 전 확인)/.test(cell(t, r, "상태")),
      );
      if (busy.length) {
        console.log("[진행 중이거나 머지 전 확인인 행]");
        for (const r of busy)
          console.log(`${cell(t, r, "세션")}: ${head(cell(t, r, "상태"), 60)}`);
      }
      break;
    }
    default:
      fail(`모르는 명령: ${opts.cmd}`);
  }
}

main();
