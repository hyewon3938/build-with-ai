#!/usr/bin/env node
// 운영 DB에 읽기 전용 조회 한 문장을 돌리고, 행 수와 글자 수를 줄여 출력한다.
//
// 사용: node db-query.mjs [--limit N] [--max-chars N] < 조회.sql
// SQL은 stdin으로 받고 SELECT나 WITH로 시작하는 한 문장만 돌린다. 접속 정보는 현재 폴더의 .env에서
// DB_QUERY_SSH_HOST(ssh 설정의 호스트 이름), DB_QUERY_CONTAINER, DB_QUERY_PATH(컨테이너 안 DB 파일
// 경로)를 읽는다. 다른 env 파일을 고르는 옵션은 두지 않아서, 조회 대상은 그 폴더의 .env에 사람이 적은
// 값으로 정해진다. 호스트와 컨테이너가 있으면 ssh로 그 컨테이너 안의 node에 조회 프로그램을 stdin으로
// 넘기고, 둘 다 비어 있으면 현재 폴더에서 node로 직접 연다(로컬 시험용). 어느 쪽이든 better-sqlite3가
// 설치된 작업 폴더에서 돈다.
//
// DB는 읽기 전용 모드와 query_only로 열고, 준비한 문장이 값을 돌려주는 읽기 전용 문장인지 한 번 더
// 확인한다. sqlite3 CLI는 dot 명령으로 쉘을 실행할 수 있어서 쓰지 않는다. 조회는 JS 힙을 제한한
// worker에서 돌리고 시간을 넘기면 조회 프로세스를 SIGKILL로 끝낸다. ssh나 docker exec 연결이 끊겨도
// 컨테이너 안 프로세스는 계속 돌기 때문이다. 힙 제한은 값 하나가 수백 MB인 조회(큰 hex, group_concat)를
// 막지 못해서, 그런 조회는 출력이 잘려도 서버가 그 크기만큼 메모리를 쓴다.
//
// 출력은 첫 줄에 컬럼 이름 배열, 이어서 행마다 값 배열을 JSON 한 줄씩, 마지막 줄에 행 수다. 긴 텍스트는
// 잘라서 잘린 글자 수를 붙이고 BLOB은 크기만 적으며, 행 줄을 합쳐 상한을 넘으면 뒤 행을 뺀다.
// 호스트·컨테이너 이름과 DB 경로(설정 값, SQLite가 연 파일 경로, 그 폴더)는 출력과 오류에 그대로
// 찍힐 때만 가리고, 조회가 경로를 쪼개거나 바꿔 찍는 것은 막지 못한다. ssh 자체가 실패하면 원문 대신
// 분류만 알린다. 종료 코드는 성공 0, 조회 실패 1, 사용법·설정 오류 2다.
import { readFileSync, readSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const ENV_FILE = ".env";
const ENV_KEYS = ["DB_QUERY_SSH_HOST", "DB_QUERY_CONTAINER", "DB_QUERY_PATH"];
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// ssh와 docker 인자로 넘기므로 옵션으로 읽히거나 원격 쉘이 해석할 문자를 막는다.
// 사용자@호스트 모양의 호스트는 @ 뒤도 -로 시작할 수 없다.
const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:@[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/;
const LIMIT = { default: 50, min: 1, max: 200 };
const MAX_CHARS = { default: 300, min: 20, max: 2000 };
const MAX_OUTPUT_CHARS = 200_000;
const MAX_SQL_CHARS = 20_000;
const QUERY_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 50_000;
const WORKER_HEAP_MB = 256;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
// ssh는 자기 오류로 끝나면 255를 돌려준다. 이때 stderr에는 설정 파일의 실제 주소가 찍힐 수 있다.
const SSH_FAILED = 255;
const SSH_ERRORS = [
  [/could not resolve hostname/i, "ssh 호스트 이름을 찾지 못했다"],
  [/timed out/i, "ssh 연결 시간이 초과됐다"],
  [/connection refused/i, "ssh 연결이 거부됐다"],
  [/permission denied/i, "ssh 인증이 거부됐다"],
  [/host key/i, "ssh 호스트 키 확인에 실패했다"],
  [
    /no route to host|network is unreachable/i,
    "서버로 가는 네트워크 경로가 없다",
  ],
  [
    /connection (?:closed|reset)|broken pipe|kex_exchange_identification/i,
    "ssh 연결이 끊겼다",
  ],
];

const USAGE = "사용: node db-query.mjs [--limit N] [--max-chars N] < 조회.sql";

// 원격 worker에서 도는 코드. 문자열로 넘기므로 이 파일의 변수를 참조하지 않는다.
const WORKER_SOURCE = `"use strict";
const { parentPort, workerData: config } = require("node:worker_threads");
function cut(value) {
  if (typeof value === "string") {
    if (value.length <= config.maxChars) return value;
    let end = config.maxChars;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    return value.slice(0, end) + "…(+" + (value.length - end) + "자)";
  }
  if (Buffer.isBuffer(value)) return "<blob " + value.length + " bytes>";
  if (typeof value === "bigint") return value.toString();
  return value;
}
const hide = [];
let result;
try {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (err) {
    throw new Error("작업 폴더에서 better-sqlite3를 불러오지 못했다(" + ((err && err.code) || "unknown") + ")");
  }
  const db = new Database(config.path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    // 부모가 출력에서 가릴 수 있게 SQLite가 실제로 연 파일 경로를 함께 보낸다.
    for (const file of db.prepare("SELECT file FROM pragma_database_list").pluck().all()) {
      if (file) hide.push(file);
    }
    const stmt = db.prepare(config.sql);
    if (!stmt.reader || !stmt.readonly) {
      throw new Error("값을 돌려주는 읽기 전용 문장만 돌릴 수 있다");
    }
    stmt.raw(true);
    const columns = stmt.columns().map((c) => c.name);
    // 행을 바로 JSON 줄로 바꿔 잘라 낸 원문을 붙잡지 않고, 줄 길이를 더해 출력 크기를 제한한다.
    const lines = [];
    let chars = 0;
    let more = "";
    for (const row of stmt.iterate()) {
      if (lines.length === config.limit) {
        more = "rows";
        break;
      }
      const line = JSON.stringify(row.map(cut));
      if (chars + line.length > config.maxOutputChars) {
        more = "size";
        break;
      }
      chars += line.length;
      lines.push(line);
    }
    result = { ok: true, columns, lines, more };
  } finally {
    db.close();
  }
} catch (err) {
  result = { ok: false, error: String((err && err.message) || err) };
}
result.hide = hide;
parentPort.postMessage(result);
`;

function usage(message) {
  console.error(message ? `${message}\n${USAGE}` : USAGE);
  process.exit(2);
}

function intInRange(value, range, flag) {
  if (!/^\d+$/.test(value ?? "")) usage(`${flag} 뒤에 숫자가 필요하다`);
  const n = Number(value);
  if (n < range.min || n > range.max) {
    usage(`${flag}는 ${range.min}~${range.max} 사이여야 한다`);
  }
  return n;
}

function parseArgs(argv) {
  const opts = { limit: LIMIT.default, maxChars: MAX_CHARS.default };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      opts.limit = intInRange(argv[++i], LIMIT, "--limit");
    } else if (arg === "--max-chars") {
      opts.maxChars = intInRange(argv[++i], MAX_CHARS, "--max-chars");
    } else {
      usage(`모르는 인자: ${arg}`);
    }
  }
  return opts;
}

// 따옴표로 감싼 값은 따옴표를 떼고, 감싸지 않은 값은 공백 뒤 # 주석을 뗀다.
function unquote(raw) {
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
  if (quoted) return quoted[2];
  if (raw.startsWith("#")) return "";
  return raw.replace(/\s+#.*$/, "").trim();
}

// 필요한 세 이름만 읽고 나머지 줄은 보지 않는다. 같은 이름은 마지막 줄을 따른다.
function readEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    // 오류 객체를 통째로 찍지 않는다. 코드만 알린다.
    console.error(`${file} 파일을 읽지 못했다: ${err?.code ?? "unknown"}`);
    process.exit(2);
  }
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGN.exec(line);
    if (!m || !ENV_KEYS.includes(m[1])) continue;
    found[m[1]] = unquote(m[2].trim());
  }
  return found;
}

function stripLeadingComments(sql) {
  let s = sql;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*(?:\n|$)/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) return s;
    s = next;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 상한을 넘는 입력은 끝까지 읽지 않는다. UTF-16 한 글자는 UTF-8로 3바이트를 넘지 않으므로, 이 바이트
// 수를 다 채운 입력은 글자 수도 상한을 넘는다.
function readStdin() {
  const cap = MAX_SQL_CHARS * 3 + 1;
  const buf = Buffer.alloc(cap);
  let size = 0;
  while (size < cap) {
    let n;
    try {
      n = readSync(0, buf, size, cap - size, null);
    } catch (err) {
      if (err?.code === "EAGAIN") {
        sleep(5);
        continue;
      }
      if (err?.code === "EOF") break;
      console.error(`stdin을 읽지 못했다: ${err?.code ?? "unknown"}`);
      process.exit(2);
    }
    if (n === 0) break;
    size += n;
  }
  if (size === cap) usage(`SQL은 ${MAX_SQL_CHARS}자까지 받는다`);
  return buf.toString("utf8", 0, size);
}

function readSql() {
  if (process.stdin.isTTY) usage("SQL을 stdin으로 넘겨야 한다");
  let sql = readStdin();
  if (sql.length > MAX_SQL_CHARS) usage(`SQL은 ${MAX_SQL_CHARS}자까지 받는다`);
  sql = sql.replace(/[\s;]+$/, "");
  if (!/^(?:select|with)\b/i.test(stripLeadingComments(sql))) {
    usage("SELECT나 WITH로 시작하는 조회 한 문장만 돌릴 수 있다");
  }
  return sql;
}

function buildProgram(config) {
  return `"use strict";
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const config = ${JSON.stringify(config)};
let done = false;
// Worker를 만들면 stdout이 non-blocking이 되어 writeSync 한 번이 일부만 쓸 수 있다. 다 쓸 때까지 되풀이한다.
function writeAll(text) {
  const buf = Buffer.from(text);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      if (!err || err.code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}
function finish(result) {
  if (done) return;
  done = true;
  writeAll(JSON.stringify(result) + "\\n");
}
const timer = setTimeout(() => {
  finish({ ok: false, error: "조회가 " + config.timeoutMs / 1000 + "초 안에 끝나지 않아 멈췄다" });
  process.kill(process.pid, "SIGKILL");
}, config.timeoutMs);
const worker = new Worker(${JSON.stringify(WORKER_SOURCE)}, {
  eval: true,
  workerData: config,
  resourceLimits: { maxOldGenerationSizeMb: config.heapMb },
});
worker.on("message", (result) => {
  clearTimeout(timer);
  finish(result);
  process.exit(0);
});
worker.on("error", (err) => {
  clearTimeout(timer);
  const error =
    err && err.code === "ERR_WORKER_OUT_OF_MEMORY"
      ? "조회 worker가 메모리 상한 " + config.heapMb + "MB를 넘어 멈췄다. 큰 값은 length()나 substr()로 줄여서 읽는다"
      : String((err && err.message) || err);
  finish({ ok: false, error });
  process.exit(0);
});
worker.on("exit", () => {
  clearTimeout(timer);
  finish({ ok: false, error: "조회 worker가 결과 없이 끝났다" });
});
`;
}

function run(program, { host, container }) {
  return new Promise((resolve) => {
    const child = host
      ? spawn("ssh", [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=15",
          "-o",
          "LogLevel=ERROR",
          host,
          "docker",
          "exec",
          "-i",
          container,
          "node",
          "-",
        ])
      : spawn(process.execPath, ["-"]);
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let tooBig = false;
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        tooBig = true;
        child.kill("SIGTERM");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      err.push(chunk);
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TOTAL_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ spawnError: e.code ?? "unknown" });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status: code ?? signal,
        tooBig,
        timedOut,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(program);
  });
}

function lastResult(stdout) {
  const lines = stdout.split("\n").filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
    } catch {
      // 결과 줄이 아니면 앞 줄을 본다.
    }
  }
  return null;
}

const opts = parseArgs(process.argv.slice(2));
const env = readEnv(ENV_FILE);
const host = env.DB_QUERY_SSH_HOST ?? "";
const container = env.DB_QUERY_CONTAINER ?? "";
const dbPath = env.DB_QUERY_PATH ?? "";
if (!dbPath) usage(`${ENV_FILE}에 DB_QUERY_PATH가 없다`);
if (Boolean(host) !== Boolean(container)) {
  usage(
    "DB_QUERY_SSH_HOST와 DB_QUERY_CONTAINER는 둘 다 채우거나 둘 다 비워야 한다",
  );
}
for (const [key, value] of [
  ["DB_QUERY_SSH_HOST", host],
  ["DB_QUERY_CONTAINER", container],
]) {
  if (value && !NAME.test(value)) {
    usage(
      `${key}에는 영문자·숫자와 _.-, 사용자를 붙일 때 @ 하나만 쓸 수 있고 맨 앞과 @ 뒤에 -를 둘 수 없다`,
    );
  }
}
const sql = readSql();

// 설정 값과 worker가 알려 준 파일 경로, 각각의 폴더를 가린다. JSON으로 이스케이프된 모양도 함께 넣는다.
function makeMask(reported) {
  const values = [dbPath, host, container, ...reported];
  if (!host) values.push(resolve(dbPath));
  const hidden = new Set();
  for (const value of values) {
    for (const v of [value, dirname(value)]) {
      if (v.length < 2 || v === ".." || v === "./") continue;
      hidden.add(v);
      hidden.add(JSON.stringify(v).slice(1, -1));
    }
  }
  const sorted = [...hidden].sort((a, b) => b.length - a.length);
  return (text) => sorted.reduce((s, v) => s.split(v).join("<가림>"), text);
}

// 오류 문구에는 설정하지 않은 경로와 주소도 섞일 수 있어 한 번 더 가린다.
function maskMessage(mask, text) {
  return mask(text)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<주소>")
    .replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, "<주소>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<경로>");
}

function describeStderr(mask, stderr, sshFailed) {
  const out = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const text = sshFailed
      ? (SSH_ERRORS.find(([re]) => re.test(line))?.[1] ??
        "ssh 연결에 실패했다(분류하지 못한 오류)")
      : maskMessage(mask, line);
    if (!out.includes(text)) out.push(text);
  }
  return out.slice(-5).join("\n");
}

const result = await run(
  buildProgram({
    path: dbPath,
    sql,
    limit: opts.limit,
    maxChars: opts.maxChars,
    maxOutputChars: MAX_OUTPUT_CHARS,
    heapMb: WORKER_HEAP_MB,
    timeoutMs: QUERY_TIMEOUT_MS,
  }),
  { host, container },
);

if (result.spawnError) {
  console.error(`조회 프로세스를 시작하지 못했다: ${result.spawnError}`);
  process.exitCode = 1;
} else if (result.tooBig) {
  console.error(
    `출력이 ${MAX_STDOUT_BYTES / 1024 / 1024}MB를 넘어 멈췄다. --limit이나 --max-chars를 줄인다`,
  );
  process.exitCode = 1;
} else {
  const parsed = lastResult(result.stdout);
  const reported = Array.isArray(parsed?.hide)
    ? parsed.hide.filter((v) => typeof v === "string")
    : [];
  const mask = makeMask(reported);
  if (parsed?.ok) {
    console.log(mask(JSON.stringify(parsed.columns)));
    for (const line of parsed.lines) console.log(mask(line));
    const n = parsed.lines.length;
    if (parsed.more === "rows") {
      console.log(`${n}행까지 출력, 뒤 행은 생략(--limit 최대 ${LIMIT.max})`);
    } else if (parsed.more === "size") {
      console.log(
        `${n}행까지 출력, 행 줄을 합쳐 ${MAX_OUTPUT_CHARS}자를 넘어 뒤 행은 생략(--max-chars를 줄이거나 컬럼을 줄인다)`,
      );
    } else {
      console.log(`${n}행`);
    }
  } else if (parsed) {
    console.error(`조회 실패: ${maskMessage(mask, String(parsed.error))}`);
    process.exitCode = 1;
  } else {
    console.error(
      result.timedOut
        ? `${TOTAL_TIMEOUT_MS / 1000}초 안에 결과가 오지 않아 연결을 끊었다`
        : `조회 결과를 받지 못했다(종료 상태 ${result.status})`,
    );
    const tail = describeStderr(
      mask,
      result.stderr,
      Boolean(host) && result.status === SSH_FAILED,
    );
    if (tail) console.error(tail);
    process.exitCode = 1;
  }
}
