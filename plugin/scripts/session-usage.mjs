#!/usr/bin/env node
// Claude Code 세션 기록(.jsonl)에서 토큰을 어디에 썼는지 숫자로만 뽑아 출력한다.
//
// 세션이 끝난 뒤 모델 호출 수, 호출마다 다시 읽힌 앞부분 크기, 캐시가 끊겨 다시 쓴 호출, 도구별 호출 수와
// 결과 크기, 서브에이전트별 토큰을 세어 어디서 토큰이 많이 나갔는지 보이게 한다. 기록의 본문은
// 출력하지 않고 도구 이름과 숫자만 낸다. 세션 기록에는 도구 결과가 그대로 들어 있어서 본문을
// 찍으면 secrets가 섞일 수 있다.
//
// 쓰는 법: node session-usage.mjs [대상] [옵션]
//   대상이 없으면     현재 폴더(--cwd)의 가장 최근 세션
//   <파일.jsonl> ...  그 세션 기록
//   --since <일>      ~/.claude/projects 전체에서 그 일수 안에 바뀐 세션을 한 줄씩, 끝에 도구·MCP·모델 합계
//   --match <문자열>  --since와 함께, 프로젝트 폴더 이름에 이 문자열이 든 것만
// 옵션:
//   --cwd <경로>      대상이 없을 때 세션을 찾을 폴더 (기본: 현재 폴더)
//   --top <n>         도구 목록을 몇 개까지 보일지 (기본 10)
//   --log <파일>      세션 한 줄 요약을 TSV로 덧붙인다. 파일이 없으면 머리글부터 쓴다
//   --weekly <값>     --log 줄에 함께 적을 주간 사용량 (예: "41→44")
//   --label <글>      --log 줄에 함께 적을 메모 (예: 세션 이름)
//
// 가중 합은 API 단가 비율(새 입력 1, 1시간 캐시 쓰기 2, 캐시 읽기 0.1, 출력 5)로 센 추정값이다.
// 구독 플랜의 주간 사용량이 같은 비율로 세는지는 공개돼 있지 않아서, 주간 사용량 변화와 나란히 적어 두고 비교한다.

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const W = { input: 1, create: 2, read: 0.1, output: 5 };
// 앞 호출까지 캐시에 있던 양보다 캐시 읽기가 이 비율 아래로 떨어지면 캐시가 끊겨 뒷부분을 다시 쓴 호출로 센다.
// 캐시 쓰기가 큰데 읽기가 줄지 않은 호출은 새 도구 결과가 붙은 것이라 세지 않는다.
const BREAK_RATIO = 0.9;
const BREAK_MIN = 20000;
const TTL_MIN = 60;

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { files: [], top: 10, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) fail(`${k} 뒤에 값이 필요합니다`);
      return argv[++i];
    };
    if (k === "--since") a.since = Number(v());
    else if (k === "--match") a.match = v();
    else if (k === "--cwd") a.cwd = v();
    else if (k === "--top") a.top = Number(v());
    else if (k === "--log") a.log = v();
    else if (k === "--weekly") a.weekly = v();
    else if (k === "--label") a.label = v();
    else if (k.startsWith("--")) fail(`모르는 옵션: ${k}`);
    else a.files.push(k);
  }
  return a;
}

function projectDirFor(cwd) {
  return join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

function latestIn(dir) {
  if (!existsSync(dir)) fail(`세션 폴더가 없습니다: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((x, y) => y.t - x.t);
  if (!files.length) fail(`세션 기록이 없습니다: ${dir}`);
  return files[0].f;
}

function readLines(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 쓰는 도중의 마지막 줄은 건너뛴다
    }
  }
  return out;
}

function inc(map, key, n = 1) {
  map.set(key, (map.get(key) ?? 0) + n);
}

function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === "text") n += c.text?.length ?? 0;
    else if (c?.type === "image") n += 2000; // 이미지는 길이 대신 대략값
  }
  return n;
}

// 기록 하나(메인 세션이나 서브에이전트)를 센다
function analyze(file) {
  const recs = readLines(file);
  const calls = new Map(); // message.id → {usage, model, ts, effort}
  const toolName = new Map(); // tool_use id → 이름
  const tools = new Map();
  const resultSize = new Map();
  let costUSD = null;
  let compacts = 0;
  const compactTs = [];
  for (const o of recs) {
    if (o.type === "assistant" && o.message?.id) {
      const prev = calls.get(o.message.id);
      calls.set(o.message.id, {
        usage: o.message.usage ?? prev?.usage ?? {},
        model: o.message.model ?? prev?.model,
        ts: prev?.ts ?? Date.parse(o.timestamp),
        effort: o.effort ?? prev?.effort,
      });
      for (const c of o.message.content ?? []) {
        if (c?.type === "tool_use") {
          toolName.set(c.id, c.name);
          inc(tools, c.name);
        }
      }
    } else if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type === "tool_result")
          inc(
            resultSize,
            toolName.get(c.tool_use_id) ?? "?",
            resultChars(c.content),
          );
      }
    } else if (o.type === "cost-state" && typeof o.totalCostUSD === "number") {
      costUSD = o.totalCostUSD;
    } else if (o.type === "system" && /compact/.test(String(o.subtype))) {
      compacts++;
      compactTs.push(Date.parse(o.timestamp));
    }
  }
  const list = [...calls.values()].sort((x, y) => x.ts - y.ts);
  const sum = { input: 0, create: 0, read: 0, output: 0 };
  const models = new Map();
  const efforts = new Map();
  let rebuilds = 0;
  let rebuildTokens = 0;
  let rebuildsAfterGap = 0;
  let rebuildsAfterCompact = 0;
  const breakAt = new Map(); // 끊긴 뒤 캐시 읽기가 남은 길이별 횟수. 같은 길이가 반복되면 그 자리 뒤가 매번 바뀐 것이다
  let prevTotal = 0;
  list.forEach((c, i) => {
    const u = c.usage;
    const cr = u.cache_creation_input_tokens ?? 0;
    sum.input += u.input_tokens ?? 0;
    sum.create += cr;
    sum.read += u.cache_read_input_tokens ?? 0;
    sum.output += u.output_tokens ?? 0;
    if (c.model) inc(models, c.model);
    if (c.effort) inc(efforts, c.effort);
    const rd = u.cache_read_input_tokens ?? 0;
    if (i > 0 && cr > BREAK_MIN && rd < prevTotal * BREAK_RATIO) {
      rebuilds++;
      rebuildTokens += cr;
      inc(breakAt, rd);
      if (c.ts - list[i - 1].ts > TTL_MIN * 60000) rebuildsAfterGap++;
      else if (compactTs.some((t) => t > list[i - 1].ts && t <= c.ts))
        rebuildsAfterCompact++;
    }
    prevTotal = rd + cr;
  });
  const ctx = (u) =>
    (u?.input_tokens ?? 0) +
    (u?.cache_creation_input_tokens ?? 0) +
    (u?.cache_read_input_tokens ?? 0);
  return {
    file,
    calls: list.length,
    sum,
    weighted:
      sum.input * W.input +
      sum.create * W.create +
      sum.read * W.read +
      sum.output * W.output,
    prefix: ctx(list[0]?.usage),
    lastCtx: ctx(list.at(-1)?.usage),
    rebuilds,
    rebuildTokens,
    rebuildsAfterGap,
    rebuildsAfterCompact,
    breakAt,
    models,
    efforts,
    tools,
    resultSize,
    costUSD,
    compacts,
    start: list[0]?.ts,
    end: list.at(-1)?.ts,
  };
}

function subagentsOf(file) {
  const dir = join(file.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const metaPath = join(dir, f.replace(/\.jsonl$/, ".meta.json"));
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch {
        // meta가 없으면 종류를 모르는 채로 센다
      }
      return { meta, r: analyze(join(dir, f)) };
    });
}

const k = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}K`
      : String(Math.round(n));
const top = (map, n) =>
  [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
const mapStr = (map) =>
  top(map, 5)
    .map(([a, b]) => `${a} ${b}`)
    .join(", ") || "-";
const mcpServer = (name) =>
  name.startsWith("mcp__") ? name.split("__")[1] : null;

function report(file, a) {
  const r = analyze(file);
  const subs = subagentsOf(file);
  const subW = subs.reduce((s, x) => s + x.r.weighted, 0);
  const mins = r.start && r.end ? Math.round((r.end - r.start) / 60000) : 0;
  const L = [];
  L.push(
    `세션 ${basename(file, ".jsonl")}  (${basename(file.replace(/\/[^/]+$/, ""))})`,
  );
  L.push(
    `  모델 ${mapStr(r.models)} / effort ${mapStr(r.efforts)} / ${mins}분 / compact ${r.compacts}번`,
  );
  L.push(
    `  호출 ${r.calls}번  출력 ${k(r.sum.output)}  캐시 읽기 ${k(r.sum.read)}  캐시 쓰기 ${k(r.sum.create)}  새 입력 ${k(r.sum.input)}`,
  );
  L.push(
    `  앞부분(첫 호출) ${k(r.prefix)}  마지막 호출 맥락 ${k(r.lastCtx)}  → 앞부분 × 호출 수 = 캐시 읽기의 약 ${r.sum.read ? Math.round((r.prefix * r.calls * 100) / r.sum.read) : 0}%`,
  );
  L.push(
    `  캐시 끊긴 호출 ${r.rebuilds}번 (다시 쓴 양 ${k(r.rebuildTokens)}, 그중 ${TTL_MIN}분 넘게 쉰 뒤 ${r.rebuildsAfterGap}번, compact 직후 ${r.rebuildsAfterCompact}번)` +
      (r.rebuilds
        ? `  끊긴 뒤 남은 캐시 길이: ${top(r.breakAt, 3)
            .map(([a, b]) => `${k(a)}×${b}`)
            .join(", ")}`
        : ""),
  );
  L.push(
    `  가중 합(추정) 메인 ${k(r.weighted)} + 서브에이전트 ${k(subW)}` +
      (r.costUSD != null ? `  / 기록의 API 환산 ${r.costUSD.toFixed(2)}` : ""),
  );
  if (subs.length) {
    const byType = new Map();
    for (const s of subs) {
      const key = `${s.meta.agentType ?? "?"}/${s.meta.model ?? top(s.r.models, 1)[0]?.[0] ?? "?"}`;
      const cur = byType.get(key) ?? { n: 0, calls: 0, w: 0 };
      byType.set(key, {
        n: cur.n + 1,
        calls: cur.calls + s.r.calls,
        w: cur.w + s.r.weighted,
      });
    }
    L.push(
      `  서브에이전트 ${subs.length}개: ` +
        [...byType.entries()]
          .map(([t, v]) => `${t} ${v.n}개 호출 ${v.calls} 가중 ${k(v.w)}`)
          .join(" | "),
    );
  }
  L.push(
    `  도구 호출 상위: ` +
      top(r.tools, a.top)
        .map(([t, n]) => `${t} ${n}`)
        .join(", "),
  );
  L.push(
    `  결과가 큰 도구(맥락에 쌓인 글자 수): ` +
      top(r.resultSize, a.top)
        .map(([t, n]) => `${t} ${k(n)}`)
        .join(", "),
  );
  const mcp = new Map();
  for (const [t, n] of r.tools) if (mcpServer(t)) inc(mcp, mcpServer(t), n);
  L.push(`  MCP 서버별 호출: ${mapStr(mcp)}`);
  process.stdout.write(L.join("\n") + "\n");

  if (a.log) {
    const head =
      "날짜\t세션\t폴더\t모델\teffort\t분\t호출\t출력\t캐시읽기\t캐시쓰기\t앞부분\t캐시끊김\t서브에이전트\t가중메인\t가중서브\t주간\t메모\n";
    const row = [
      new Date(r.end ?? Date.now()).toISOString().slice(0, 16),
      basename(file, ".jsonl").slice(0, 8),
      basename(file.replace(/\/[^/]+$/, "")).slice(-40),
      top(r.models, 1)[0]?.[0] ?? "",
      top(r.efforts, 1)[0]?.[0] ?? "",
      mins,
      r.calls,
      r.sum.output,
      r.sum.read,
      r.sum.create,
      r.prefix,
      r.rebuilds,
      subs.length,
      Math.round(r.weighted),
      Math.round(subW),
      a.weekly ?? "",
      (a.label ?? "").replace(/\t|\n/g, " "),
    ].join("\t");
    appendFileSync(a.log, (existsSync(a.log) ? "" : head) + row + "\n");
    process.stdout.write(`  → ${a.log}에 한 줄 덧붙였습니다\n`);
  }
}

function since(a) {
  const cutoff = Date.now() - a.since * 86400000;
  const tools = new Map();
  const mcp = new Map();
  const models = new Map();
  let total = 0;
  const rows = [];
  for (const d of readdirSync(PROJECTS)) {
    if (a.match && !d.includes(a.match)) continue;
    const dir = join(PROJECTS, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(dir, f);
      if (statSync(file).mtimeMs < cutoff) continue;
      const r = analyze(file);
      if (!r.calls) continue;
      const subs = subagentsOf(file);
      const w = r.weighted + subs.reduce((s, x) => s + x.r.weighted, 0);
      total += w;
      for (const [t, n] of r.tools) {
        inc(tools, t, n);
        if (mcpServer(t)) inc(mcp, mcpServer(t), n);
      }
      for (const s of subs) for (const [m, n] of s.r.models) inc(models, m, n);
      for (const [m, n] of r.models) inc(models, m, n);
      rows.push({
        w,
        line: `${k(w).padStart(7)}  호출 ${String(r.calls).padStart(4)}  서브 ${String(subs.length).padStart(2)}  앞부분 ${k(r.prefix).padStart(6)}  끊김 ${String(r.rebuilds).padStart(2)}  ${d.slice(-30)}/${f.slice(0, 8)}`,
      });
    }
  }
  rows.sort((x, y) => y.w - x.w);
  process.stdout.write(
    `최근 ${a.since}일 세션 ${rows.length}개, 가중 합(추정) ${k(total)}\n`,
  );
  for (const r of rows.slice(0, 30)) process.stdout.write(r.line + "\n");
  if (rows.length > 30) process.stdout.write(`… ${rows.length - 30}개 더\n`);
  process.stdout.write(`모델별 호출: ${mapStr(models)}\n`);
  process.stdout.write(
    `도구 호출 상위: ${top(tools, a.top)
      .map(([t, n]) => `${t} ${n}`)
      .join(", ")}\n`,
  );
  process.stdout.write(
    `MCP 서버별 호출: ${
      top(mcp, 20)
        .map(([t, n]) => `${t} ${n}`)
        .join(", ") || "-"
    }\n`,
  );
}

const a = parseArgs(process.argv.slice(2));
if (a.since) since(a);
else
  for (const f of a.files.length ? a.files : [latestIn(projectDirFor(a.cwd))])
    report(f, a);
