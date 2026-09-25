#!/usr/bin/env node
// 현재 프로젝트 폴더와 그 .env의 조회 대상을, 사용자가 터미널에서 확인한 뒤 조회 스크립트의 허용 대상으로 고정한다.
//
// 사용: node query-pin.mjs          현재 폴더를 고정하거나, 설정을 바꾼 뒤 다시 고정한다
//       node query-pin.mjs --remove 현재 폴더의 고정을 지운다
// 사람이 입력할 수 있는 터미널에서만 돈다. 에이전트의 명령 실행처럼 입력이 터미널이 아니면 멈춰서,
// 에이전트가 스스로 새 폴더나 새 접속 대상을 허용할 수 없다. 현재 폴더는 git 저장소의 메인 체크아웃
// 맨 위 폴더여야 하고 임시 폴더 아래이면 안 된다. 고정할 때 DB 조회와 로그 조회 대상을 화면에 보여 주고
// y를 입력받아야 쓴다. 고정 파일은 query-guard.mjs의 PIN_FILE이고 소유자 전용 권한(600)으로 쓴다.
//
// 호스트가 있으면 ssh 설정이 그 호스트 이름으로 풀어 주는 접속 값(주소, 포트, 사용자, 키 파일, known_hosts
// 파일, 알고리즘)을 함께 고정한다. 이 터미널에는 주소·포트·사용자와, ssh 기본값과 다른 나머지 접속 값을 모두
// 보여 준다. 조회 스크립트는 ssh 설정 파일을 읽지 않고 이 값으로만 접속하므로, ssh 설정을 바꾼 뒤에는 다시
// 고정해야 조회에 반영된다. 경유 호스트를 쓰는 호스트는 고정하지 않는다.
//
// 접속 값을 풀 때 ssh는 설정의 Match exec 명령을 실행한다. macOS에서는 query-guard.mjs가 명령 실행을 막은
// 샌드박스 안에서 풀어서, 그런 줄이 돌려 하면 고정이 멈춘다. 샌드박스가 없는 시스템에서는 ssh 설정 파일과 그
// 파일이 Include로 부르는 파일에서 그런 줄을 먼저 찾아, 있으면 위치를 보여 주고 yes를 입력받아야 푼다.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";
import {
  DIR,
  ENV_FILE,
  NAME,
  PIN_FILE,
  SSH_SANDBOXED,
  dbTarget,
  findMatchExec,
  logTarget,
  pinEntry,
  readEnvValues,
  readPins,
  sshDefaults,
  sshDisplayLines,
} from "./query-guard.mjs";

const USAGE = "사용: node query-pin.mjs [--remove]";
const TEMP_ROOTS = [
  tmpdir(),
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

function stop(message) {
  console.error(message);
  process.exit(2);
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function git(args) {
  const res = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return res.status === 0 ? res.stdout : null;
}

// 현재 폴더가 고정해도 되는 프로젝트 폴더인지 확인하고 실제 경로를 돌려준다.
function projectRoot() {
  const root = realpathSync(process.cwd());
  for (const temp of TEMP_ROOTS.map(realOrSelf)) {
    if (root === temp || root.startsWith(temp + sep)) {
      stop("임시 폴더 아래는 고정하지 않는다");
    }
  }
  const top = git(["rev-parse", "--show-toplevel"])?.trim();
  if (!top || realOrSelf(top) !== root) {
    stop("git 저장소의 맨 위 폴더에서 돌려야 한다");
  }
  const main = /^worktree (.+)$/m.exec(
    git(["worktree", "list", "--porcelain"]) ?? "",
  )?.[1];
  if (!main || realOrSelf(main) !== root) {
    stop("worktree가 아닌 메인 체크아웃에서 돌려야 한다");
  }
  return root;
}

function writePins(pins) {
  const dir = dirname(PIN_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) {
    stop(`고정 파일 폴더(${dir})가 심링크이거나 이 계정 소유가 아니어서 쓰지 않는다`);
  }
  chmodSync(dir, 0o700);
  const tmp = `${PIN_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(tmp, PIN_FILE);
}

function show(label, value) {
  return `  ${label}: ${value || "(비어 있음)"}`;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--remove"))
  stop(USAGE);
const remove = args[0] === "--remove";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  stop(
    "사람이 입력하는 터미널에서만 돈다. 사용자가 터미널을 열고 직접 돌려야 한다",
  );
}

const root = projectRoot();
let pins;
try {
  pins = readPins();
} catch (err) {
  stop(`${err.message}. 고정 파일(${PIN_FILE})을 확인하고 다시 돌린다`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

if (remove) {
  if (!pins.roots[root]) {
    rl.close();
    stop("이 폴더는 고정되어 있지 않다");
  }
  const answer = await rl.question(`${root}의 고정을 지울까? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") stop("지우지 않았다");
  delete pins.roots[root];
  writePins(pins);
  console.log("고정을 지웠다. 이 폴더에서는 조회 스크립트가 멈춘다");
  process.exit(0);
}

let values;
try {
  values = readEnvValues(ENV_FILE);
} catch (err) {
  rl.close();
  stop(err.message);
}
const db = dbTarget(values);
const log = logTarget(values);
for (const [key, value] of [
  ["DB_QUERY_SSH_HOST", db.host],
  ["DB_QUERY_CONTAINER", db.container],
  ["LOG_QUERY_SSH_HOST(없으면 DB_QUERY_SSH_HOST)", log.host],
  ["LOG_QUERY_CONTAINER(없으면 DB_QUERY_CONTAINER)", log.container],
]) {
  if (value && !NAME.test(value)) {
    rl.close();
    stop(`${key}에 쓸 수 없는 글자가 있다`);
  }
}
if (log.dir && (!DIR.test(log.dir) || log.dir.split("/").includes(".."))) {
  rl.close();
  stop(
    "LOG_QUERY_DIR는 /로 시작하는 절대 경로이고 영문자·숫자와 _.@-만 쓸 수 있으며 ..을 넣을 수 없다",
  );
}

if ((db.host || log.host) && !SSH_SANDBOXED) {
  const { found, unverified } = findMatchExec();
  if (found.length || unverified.length) {
    for (const where of found) console.log(`Match exec 줄: ${where}`);
    for (const where of unverified) console.log(`확인하지 못한 ssh 설정: ${where}`);
    console.log(
      "접속 값을 풀 때 ssh가 이 설정을 읽고, Match exec 줄의 명령을 실행한다. 직접 넣은 줄이 아니면 여기서 멈추고 파일을 확인한다.",
    );
    const go = await rl.question("직접 넣은 설정이 맞으면 yes를 입력한다: ");
    if (go.trim() !== "yes") {
      rl.close();
      stop("접속 값을 풀지 않고 멈췄다");
    }
  }
}

let entries;
let defaults;
try {
  entries = { db: pinEntry(db), log: pinEntry(log) };
  defaults = {
    db: db.host ? sshDefaults(db.host) : {},
    log: log.host ? sshDefaults(log.host) : {},
  };
} catch (err) {
  rl.close();
  stop(err.message);
}

function showSsh(kind) {
  const ssh = entries[kind].ssh;
  return ssh ? sshDisplayLines(ssh, defaults[kind]) : [];
}

console.log(`고정할 폴더: ${root}`);
console.log("DB 조회 대상");
console.log(show("ssh 호스트", db.host));
console.log(show("컨테이너", db.container));
console.log(show("DB 파일", db.path));
for (const line of showSsh("db")) console.log(line);
console.log("로그 조회 대상");
console.log(show("ssh 호스트", log.host));
console.log(show("컨테이너", log.container));
console.log(show("로그 폴더", log.dir));
for (const line of showSsh("log")) console.log(line);
if (!log.dir) {
  console.log(
    "LOG_QUERY_DIR가 비어 있어 저장한 로그 파일 조회는 돌지 않는다. 넣은 뒤 다시 고정한다.",
  );
}
console.log(
  "조회는 ssh 설정 파일을 읽지 않고 위 접속 값으로만 접속한다. 키 파일이나 known_hosts 파일이 평소 쓰던 것과 다르면 고정하지 않는다.",
);
console.log(
  "나중에 .env의 이 값을 바꾸면 다시 고정할 때까지 조회가 멈추고, ssh 설정을 바꾸면 다시 고정해야 조회에 반영된다.",
);
const answer = await rl.question("이 값으로 고정할까? [y/N] ");
rl.close();
if (answer.trim().toLowerCase() !== "y") stop("고정하지 않았다");

pins.version = 2;
pins.roots[root] = { ...entries, pinnedAt: new Date().toISOString() };
writePins(pins);
console.log(
  "고정했다. 이 폴더에서 db-query.mjs와 log-query.mjs를 돌릴 수 있다",
);
