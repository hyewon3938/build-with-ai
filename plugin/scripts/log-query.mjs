#!/usr/bin/env node
// 운영 컨테이너 로그나 배포 때 저장한 로그 파일에서 조건에 맞는 줄만 골라, 민감한 값을 가려 출력한다.
//
// 사용: node log-query.mjs --since 시각 [--until 시각] --grep 낱말 [--grep ...] [--regex 패턴 ...]
//         [--count] [--limit N] [--max-chars N]
//       node log-query.mjs --file 이름.log [--since 시각] [--until 시각] --grep 낱말 ...
//       node log-query.mjs --list
// 첫 형식은 지금 컨테이너 로그를, 둘째는 저장한 로그 파일을 보고, 셋째는 저장한 로그 파일 이름을 찍는다.
// 접속 정보는 현재 폴더의 .env에서 읽는다. LOG_QUERY_SSH_HOST와 LOG_QUERY_CONTAINER가 없으면
// DB_QUERY_SSH_HOST와 DB_QUERY_CONTAINER를 쓰고, 저장한 로그 파일은 LOG_QUERY_DIR(서버에서 로그 파일을
// 모아 두는 폴더의 절대 경로)에서 찾는다. 호스트가 비어 있으면 같은 명령을 이 컴퓨터에서 돌린다(로컬 시험용).
//
// 원격에서 돌리는 명령은 docker logs, 그 폴더의 ls -1, 그 폴더 안 .log 파일의 cat 세 가지뿐이다. 명령에
// 들어가는 값은 호스트·컨테이너 이름, 폴더 경로, 파일 이름, 유닉스 초 시각이고, 모두 정해진 글자만 허용해
// 원격 쉘이 해석할 문자가 들어가지 않는다. 거르는 조건은 원격으로 보내지 않고 받은 줄을 이 프로세스에서
// 거른다. docker logs는 앱이 stderr로 찍은 줄을 stderr로 돌려주므로, stderr에서도 시각이 붙은 줄은 로그로
// 읽고 나머지는 오류 문구로 모은다.
//
// 시각은 2026-09-24 23:31, 9/24 23:31, 30m·6h·2d(지금부터 거슬러 올라간 시간), 시간대를 붙인 ISO 시각
// 가운데 하나로 받는다. 시간대를 적지 않은 시각은 이 컴퓨터의 시간대로 읽고, 출력하는 줄 앞 시각도 같은
// 시간대로 바꾼다.
//
// 받은 줄과 파일 이름에서는 설정 값(호스트, 컨테이너, 폴더와 그 상위 폴더), 토큰·키 모양의 문자열, IPv4
// 주소, 현재 폴더 .env에서 이름에 KEY·TOKEN·SECRET 같은 말이 든 값을 먼저 가리고, 가린 줄에 거르는 조건을
// 적용한 뒤 글자 수를 자른다. 모양을 모르는 비밀 값이 .env에 없는 이름으로 찍혀 있으면 가리지 못한다.
// 오류 문구는 경로와 주소도 가리고, ssh 자체가 실패하면 원문 대신 분류만 알린다.
//
// 출력은 일치한 줄을 시각 순으로 --limit개까지 찍고, 마지막 줄들에 일치 수, 훑은 줄 수, 받은 로그의 시각
// 범위를 적는다. 입력 상한이나 시간 제한에 걸려 끝까지 못 봤으면 본 데까지 찍고 1로 끝난다. 종료 코드는
// 성공 0, 조회 실패 1, 사용법·설정 오류 2다.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { posix } from "node:path";

const ENV_FILE = ".env";
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// ssh와 docker 인자로 넘기므로 옵션으로 읽히거나 원격 쉘이 해석할 문자를 막는다.
// 사용자@호스트 모양의 호스트는 @ 뒤도 -로 시작할 수 없다.
const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:@[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/;
const DIR = /^(?:\/[A-Za-z0-9_.@-]+)+\/?$/;
const FILE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*\.log$/;
const LIMIT = { default: 50, min: 1, max: 200 };
const MAX_CHARS = { default: 300, min: 20, max: 2000 };
const MAX_OUTPUT_CHARS = 200_000;
const MAX_KEPT = 20_000;
const MAX_INPUT_BYTES = 300 * 1024 * 1024;
const MAX_ERROR_CHARS = 64 * 1024;
const TOTAL_TIMEOUT_MS = 120_000;
// 받은 로그의 첫 줄이 --since보다 이만큼 늦으면 그 사이 로그가 컨테이너 재생성으로 사라졌을 수 있다고 알린다.
const LATE_START_MS = 10 * 60_000;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "LogLevel=ERROR",
];
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
// .env에서 이 말이 이름에 든 값은 출력에서 가린다.
const SECRET_KEY =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|WEBHOOK|COOKIE|DSN/i;
const SECRET_MIN_CHARS = 8;
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // 텔레그램 봇 토큰. 요청 URL이 오류 문구에 찍히면 /bot 뒤에 붙어 나온다.
  /\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  /hooks\.slack\.com\/[A-Za-z0-9/_-]+/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// docker logs --timestamps 줄과, 앞에 "서비스-1  | "가 붙는 docker compose logs --timestamps 줄을 읽는다.
const LOG_LINE =
  /^(?:\S+\s+\|\s)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) ?(.*)$/;

const USAGE = `사용: node log-query.mjs --since 시각 [--until 시각] --grep 낱말 [--grep ...] [--regex 패턴 ...] [--count] [--limit N] [--max-chars N]
      node log-query.mjs --file 이름.log [--since 시각] [--until 시각] --grep 낱말 ...
      node log-query.mjs --list
시각: 2026-09-24 23:31, 9/24 23:31, 30m·6h·2d, 시간대를 붙인 ISO 시각`;

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

function localTime(parts, text, flag) {
  const [y, mo, d, h, mi, s] = parts;
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (
    y < 2000 ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi
  ) {
    usage(`${flag} 시각을 읽지 못했다: ${text}`);
  }
  return date.getTime();
}

function parseTime(text, flag) {
  const now = Date.now();
  let m = /^(\d{1,4})([mhd])$/.exec(text);
  if (m) return now - Number(m[1]) * UNIT_MS[m[2]];
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m)
    return localTime(
      m.slice(1).map((v) => Number(v ?? 0)),
      text,
      flag,
    );
  m = /^(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})$/.exec(text);
  if (m) {
    const year = new Date(now).getFullYear();
    const parts = [year, ...m.slice(1).map(Number), 0];
    const t = localTime(parts, text, flag);
    // 해를 적지 않은 날짜가 하루 넘게 미래면 지난해로 읽는다.
    return t > now + UNIT_MS.d
      ? localTime([year - 1, ...parts.slice(1)], text, flag)
      : t;
  }
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
  ) {
    const t = Date.parse(text);
    if (!Number.isNaN(t)) return t;
  }
  return usage(`${flag} 시각을 읽지 못했다: ${text}`);
}

function parseArgs(argv) {
  const opts = {
    limit: LIMIT.default,
    maxChars: MAX_CHARS.default,
    grep: [],
    regex: [],
    count: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${arg} 뒤에 값이 필요하다`);
      return v;
    };
    switch (arg) {
      case "--limit":
        opts.limit = intInRange(argv[++i], LIMIT, arg);
        break;
      case "--max-chars":
        opts.maxChars = intInRange(argv[++i], MAX_CHARS, arg);
        break;
      case "--since":
        opts.since = parseTime(value(), arg);
        break;
      case "--until":
        opts.until = parseTime(value(), arg);
        break;
      case "--grep": {
        const v = value();
        if (!v) usage("--grep에 빈 낱말은 줄 수 없다");
        opts.grep.push(v);
        break;
      }
      case "--regex": {
        const v = value();
        try {
          opts.regex.push(new RegExp(v, "u"));
        } catch {
          usage(`--regex 패턴을 읽지 못했다: ${v}`);
        }
        break;
      }
      case "--file":
        opts.file = value();
        if (!FILE.test(opts.file)) {
          usage(
            "--file에는 폴더 없이 .log로 끝나는 파일 이름만 쓸 수 있다(영문자·숫자와 _.@-)",
          );
        }
        break;
      case "--count":
        opts.count = true;
        break;
      case "--list":
        opts.list = true;
        break;
      default:
        usage(`모르는 인자: ${arg}`);
    }
  }
  if (opts.list) {
    if (argv.length !== 1) usage("--list는 다른 인자와 함께 쓰지 않는다");
    return opts;
  }
  if (!opts.grep.length && !opts.regex.length) {
    usage("--grep이나 --regex가 하나 이상 필요하다");
  }
  if (!opts.file && opts.since === undefined) {
    usage("컨테이너 로그를 볼 때는 --since가 필요하다");
  }
  if (
    opts.since !== undefined &&
    opts.until !== undefined &&
    opts.until <= opts.since
  ) {
    usage("--until은 --since보다 뒤여야 한다");
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

// 설정 이름의 값과, 출력에서 가릴 비밀 값 목록을 읽는다. 같은 이름은 마지막 줄을 따른다.
function readEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    // 오류 객체를 통째로 찍지 않는다. 코드만 알린다.
    console.error(`${file} 파일을 읽지 못했다: ${err?.code ?? "unknown"}`);
    process.exit(2);
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGN.exec(line);
    if (m) values[m[1]] = unquote(m[2].trim());
  }
  const secrets = Object.entries(values)
    .filter(([k, v]) => SECRET_KEY.test(k) && v.length >= SECRET_MIN_CHARS)
    .map(([, v]) => v);
  const pick = (key, fallback) => values[key] || values[fallback] || "";
  return {
    host: pick("LOG_QUERY_SSH_HOST", "DB_QUERY_SSH_HOST"),
    container: pick("LOG_QUERY_CONTAINER", "DB_QUERY_CONTAINER"),
    dir: values.LOG_QUERY_DIR ?? "",
    secrets,
  };
}

function checkConfig(opts, cfg) {
  for (const [key, value] of [
    ["LOG_QUERY_SSH_HOST(없으면 DB_QUERY_SSH_HOST)", cfg.host],
    ["LOG_QUERY_CONTAINER(없으면 DB_QUERY_CONTAINER)", cfg.container],
  ]) {
    if (value && !NAME.test(value)) {
      usage(
        `${key}에는 영문자·숫자와 _.-, 사용자를 붙일 때 @ 하나만 쓸 수 있고 맨 앞과 @ 뒤에 -를 둘 수 없다`,
      );
    }
  }
  if (opts.list || opts.file) {
    if (!cfg.dir) usage(`${ENV_FILE}에 LOG_QUERY_DIR가 없다`);
    if (!DIR.test(cfg.dir) || cfg.dir.split("/").includes("..")) {
      usage(
        "LOG_QUERY_DIR는 /로 시작하는 절대 경로이고 영문자·숫자와 _.@-만 쓸 수 있으며 ..을 넣을 수 없다",
      );
    }
  } else if (!cfg.container) {
    usage(`${ENV_FILE}에 LOG_QUERY_CONTAINER나 DB_QUERY_CONTAINER가 없다`);
  }
}

function remoteCommand(opts, cfg) {
  if (opts.list) return ["ls", "-1", cfg.dir];
  if (opts.file) return ["cat", posix.join(cfg.dir, opts.file)];
  const cmd = [
    "docker",
    "logs",
    "--timestamps",
    "--since",
    String(Math.max(0, Math.floor(opts.since / 1000))),
  ];
  if (opts.until !== undefined) {
    cmd.push("--until", String(Math.max(1, Math.ceil(opts.until / 1000))));
  }
  cmd.push(cfg.container);
  return cmd;
}

function makeMask(cfg) {
  const hidden = new Set();
  for (const value of [cfg.host, cfg.container, cfg.dir]) {
    for (const v of [value, posix.dirname(value)]) {
      if (v && v.length >= 2) hidden.add(v);
    }
  }
  const configs = [...hidden].sort((a, b) => b.length - a.length);
  const secrets = [...new Set(cfg.secrets)].sort((a, b) => b.length - a.length);
  return (text) => {
    let s = secrets.reduce((acc, v) => acc.split(v).join("<비밀값>"), text);
    for (const re of SECRET_PATTERNS) s = s.replace(re, "<비밀값>");
    s = configs.reduce((acc, v) => acc.split(v).join("<가림>"), s);
    return s.replace(IPV4, "<주소>");
  };
}

// 오류 문구에는 설정하지 않은 경로와 주소도 섞일 수 있어 한 번 더 가린다.
function maskMessage(mask, text) {
  return mask(text)
    .replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, "<주소>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<경로>");
}

function describeErrors(mask, lines, sshFailed) {
  const out = [];
  for (const raw of lines) {
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

function cut(text, max) {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…(+${text.length - end}자)`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(ms) {
  if (ms === null) return "시각 없음";
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function run(cmd, cfg, onLine) {
  return new Promise((resolve) => {
    const child = cfg.host
      ? spawn("ssh", [...SSH_OPTS, cfg.host, ...cmd])
      : spawn(cmd[0], cmd.slice(1));
    const errors = [];
    let errorChars = 0;
    let bytes = 0;
    let tooBig = false;
    let timedOut = false;
    let spawnError = null;
    const stop = () => child.kill("SIGTERM");
    const countBytes = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES && !tooBig) {
        tooBig = true;
        stop();
      }
    };
    child.stdout.on("data", countBytes);
    child.stderr.on("data", countBytes);
    const outLines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    outLines.on("line", (line) => {
      if (!tooBig) onLine(line);
    });
    const errLines = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    errLines.on("line", (line) => {
      if (tooBig) return;
      if (LOG_LINE.test(line)) {
        onLine(line);
      } else if (errorChars < MAX_ERROR_CHARS) {
        errors.push(line);
        errorChars += line.length;
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, TOTAL_TIMEOUT_MS);
    const closed = (emitter) =>
      new Promise((done) => emitter.once("close", done));
    const exited = new Promise((done) => {
      child.once("error", (e) => {
        spawnError = e.code ?? "unknown";
        done(null);
      });
      child.once("close", (code, signal) => done(code ?? signal));
    });
    Promise.all([exited, closed(outLines), closed(errLines)]).then(
      ([status]) => {
        clearTimeout(timer);
        resolve({ status, errors, tooBig, timedOut, spawnError });
      },
    );
  });
}

const opts = parseArgs(process.argv.slice(2));
const cfg = readEnv(ENV_FILE);
checkConfig(opts, cfg);
const mask = makeMask(cfg);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const state = {
  scanned: 0,
  first: null,
  last: null,
  lastTs: null,
  matched: 0,
  kept: [],
};
const names = [];

function onLogLine(raw) {
  state.scanned++;
  const m = LOG_LINE.exec(raw);
  let ts = state.lastTs;
  let text = raw;
  if (m) {
    const parsed = Date.parse(`${m[1]}${(m[2] ?? "").slice(0, 4)}${m[3]}`);
    if (!Number.isNaN(parsed)) {
      ts = parsed;
      state.lastTs = ts;
      // stdout과 stderr 줄이 섞여 도착하므로 받은 순서와 상관없이 가장 이른 시각과 늦은 시각을 적는다.
      state.first = state.first === null ? ts : Math.min(state.first, ts);
      state.last = state.last === null ? ts : Math.max(state.last, ts);
    }
    text = m[4];
  }
  if (ts !== null) {
    if (opts.since !== undefined && ts < opts.since) return;
    if (opts.until !== undefined && ts >= opts.until) return;
  }
  // 가린 줄에서 거른다. 원문에서 거르면 조건을 한 글자씩 바꿔 가며 일치 수로 가린 값을 알아낼 수 있다.
  const shown = mask(text);
  if (!opts.grep.every((g) => shown.includes(g))) return;
  if (!opts.regex.every((re) => re.test(shown))) return;
  state.matched++;
  if (!opts.count && state.kept.length < MAX_KEPT) {
    // 가린 뒤에 자른다. 먼저 자르면 잘린 비밀 값이 패턴에 안 걸려 그대로 나온다.
    state.kept.push({ ts, text: cut(shown, opts.maxChars) });
  }
}

function onNameLine(raw) {
  const name = raw.trim();
  if (FILE.test(name)) names.push(name);
}

const result = await run(
  remoteCommand(opts, cfg),
  cfg,
  opts.list ? onNameLine : onLogLine,
);
const sshFailed = Boolean(cfg.host) && result.status === SSH_FAILED;

if (result.spawnError) {
  console.error(`조회 프로세스를 시작하지 못했다: ${result.spawnError}`);
  process.exitCode = 1;
} else if (opts.list) {
  if (result.status !== 0) {
    console.error("로그 폴더를 읽지 못했다");
    const tail = describeErrors(mask, result.errors, sshFailed);
    if (tail) console.error(tail);
    process.exitCode = 1;
  } else {
    for (const name of names.sort()) console.log(mask(name));
    console.log(`.log 파일 ${names.length}개`);
  }
} else if (result.status !== 0 && state.scanned === 0) {
  console.error(
    result.timedOut
      ? `${TOTAL_TIMEOUT_MS / 1000}초 안에 로그가 오지 않아 연결을 끊었다`
      : `로그를 받지 못했다(종료 상태 ${result.status})`,
  );
  const tail = describeErrors(mask, result.errors, sshFailed);
  if (tail) console.error(tail);
  process.exitCode = 1;
} else {
  const kept = state.kept.sort(
    (a, b) => (a.ts ?? -Infinity) - (b.ts ?? -Infinity),
  );
  let shown = 0;
  let chars = 0;
  let stoppedBySize = false;
  if (!opts.count) {
    for (const entry of kept) {
      if (shown === opts.limit) break;
      const line = `${formatTime(entry.ts)} ${entry.text}`;
      if (chars + line.length > MAX_OUTPUT_CHARS) {
        stoppedBySize = true;
        break;
      }
      chars += line.length;
      console.log(line);
      shown++;
    }
  }
  let summary = `일치 ${state.matched}줄`;
  if (!opts.count) {
    summary += `, ${shown}줄 출력`;
    if (stoppedBySize) {
      summary += `(줄을 합쳐 ${MAX_OUTPUT_CHARS}자를 넘어 뒤 줄은 생략, --max-chars를 줄인다)`;
    } else if (shown < state.matched) {
      summary += `(시각 순 앞 ${shown}줄, 뒤는 --since를 옮기거나 --limit을 늘려 본다)`;
    }
  }
  console.log(summary);
  const source = opts.file ? "파일" : "받은 로그";
  console.log(
    state.scanned
      ? `훑은 줄 ${state.scanned}, ${source} 범위 ${formatTime(state.first)} ~ ${formatTime(state.last)}, 시간대 ${timeZone}`
      : `${source}에 줄이 없다, 시간대 ${timeZone}`,
  );
  if (
    !opts.file &&
    state.first !== null &&
    state.first - opts.since > LATE_START_MS
  ) {
    const minutes = Math.round((state.first - opts.since) / 60_000);
    console.log(
      `받은 로그의 첫 줄이 --since보다 ${minutes}분 늦다. 그 사이에 컨테이너를 다시 만들었으면 앞 로그는 저장한 로그 파일(--list)에서 본다`,
    );
  }
  if (result.tooBig || result.timedOut) {
    console.log(
      result.tooBig
        ? `입력이 ${MAX_INPUT_BYTES / 1024 / 1024}MB를 넘어 거기까지만 봤다. --since와 --until을 좁힌다`
        : `${TOTAL_TIMEOUT_MS / 1000}초 안에 끝나지 않아 거기까지만 봤다. --since와 --until을 좁힌다`,
    );
    process.exitCode = 1;
  } else if (result.status !== 0) {
    console.error(`로그 명령이 실패로 끝났다(종료 상태 ${result.status})`);
    const tail = describeErrors(mask, result.errors, sshFailed);
    if (tail) console.error(tail);
    process.exitCode = 1;
  }
}
