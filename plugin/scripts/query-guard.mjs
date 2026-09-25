// 조회 스크립트가 사용자가 터미널에서 고정한 폴더와 접속 대상에서만 돌게 확인하는 공용 모듈.
//
// db-query.mjs와 log-query.mjs는 현재 폴더의 .env에서 조회 대상(ssh 호스트 이름, 컨테이너, DB 파일이나
// 로그 폴더)을 읽는다. query-pin.mjs는 터미널에서 사용자 확인을 받아, 메인 체크아웃의 실제 경로마다 그 조회
// 대상과 ssh 설정이 그 호스트 이름으로 풀어 주는 접속 값(주소, 포트, 사용자, 키 파일, known_hosts 파일,
// 알고리즘)을 고정 파일에 적는다. 조회할 때는 현재 폴더와 .env의 조회 대상이 고정한 값과 같을 때만 허용하고,
// ssh는 설정 파일을 하나도 읽지 않는 -F none과 고정한 접속 값으로만 부른다. 그래서 다른 폴더에 .env를 새로
// 만들거나 .env를 바꾸면 사용자가 다시 고정할 때까지 조회가 멈추고, 고정한 뒤 ssh 설정을 바꿔도 조회의 접속
// 대상은 그대로다. ssh 설정을 바꾼 것을 조회에 반영하려면 다시 고정한다. 경유 호스트(ProxyJump,
// ProxyCommand)를 쓰는 호스트는 고정하지 않는다.
//
// 고정 파일 경로는 HOME 환경 변수 대신 계정 정보의 홈 폴더로 정한다. 고정 파일과 그 폴더는 심링크를
// 거부하고, 이 계정 소유이며 파일은 소유자만 읽고 쓰는(600) 권한일 때만 믿는다. 고정 파일과 .env는 조회
// 한 번에 한 번씩만 읽고, 확인에 쓴 값으로 바로 접속한다. query-pin.mjs는 메인 체크아웃만 고정하고,
// worktree에서 조회를 부르면 멈추고 메인 체크아웃에서 부르라고 알린다.
//
// ssh는 시스템 폴더의 실행 파일로 부르고 접속에 필요한 환경 변수만 넘긴다. 고정할 때 ssh -G는 ssh 설정의
// Match exec 명령을 실행하므로, macOS에서는 새 프로세스 만들기와 네트워크, 파일 쓰기, 시스템 서비스 부르기를 막은 샌드박스
// (sandbox-exec) 안에서 ssh -G를 돌린다. 설정이 명령을 실행하려 하면 ssh가 실패하고 고정도 멈춘다. 샌드박스가
// 없는 시스템에서는 query-pin.mjs가 설정 파일에서 그런 줄을 먼저 찾아 알리고 사용자가 yes를 입력해야 푼다.
// 스크립트 안에서 막을 수 없는 경로도 있다. 조회를 돌리는 node에 NODE_OPTIONS나 DYLD_ 변수로 코드를 먼저
// 올리는 것, 이 스크립트들이나 고정 파일, ssh 설정 파일을 직접 고치는 것은 권한 규칙과 사용자 확인에 맡긴다.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

export const PIN_FILE = join(
  userInfo().homedir,
  ".config",
  "build-with-ai",
  "query-pins.json",
);
export const ENV_FILE = ".env";
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// ssh와 docker 인자로 넘기므로 옵션으로 읽히거나 원격 쉘이 해석할 문자를 막는다.
// 사용자@호스트 모양의 호스트는 @ 뒤도 -로 시작할 수 없다.
export const NAME =
  /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:@[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/;
export const DIR = /^(?:\/[A-Za-z0-9_.@-]+)+\/?$/;
const TIMEOUT_MS = 10_000;

// 원격 명령 하나만 돌리는 ssh 옵션. 고정할 때 ssh -G에도 같은 옵션을 줘서 풀린 값이 조회 때와 같게 한다.
// 터미널과 에이전트·X11·포트 전달을 끄고, 이미 열린 다른 연결을 빌려 쓰거나 로컬 명령을 돌리지 못하게 하며,
// known_hosts에 없는 호스트 키는 받지 않는다.
export const SSH_OPTS = [
  "-T",
  ...[
    "ForwardAgent=no",
    "ForwardX11=no",
    "ClearAllForwardings=yes",
    "CanonicalizeHostname=no",
    "ControlMaster=no",
    "ControlPath=none",
    "PermitLocalCommand=no",
    "KnownHostsCommand=none",
    "RemoteCommand=none",
    "Tunnel=no",
    "StrictHostKeyChecking=yes",
    "UpdateHostKeys=no",
    "BatchMode=yes",
    "SecurityKeyProvider=internal",
    "ConnectTimeout=15",
    "LogLevel=ERROR",
  ].flatMap((opt) => ["-o", opt]),
];

// ssh는 시스템 폴더에서만 찾고, 환경 변수는 접속에 필요한 것만 넘긴다. 조회를 부른 쉘의 PATH나 ssh가 로컬
// 프로그램을 부르게 하는 변수(SSH_ASKPASS, SSH_SK_PROVIDER 같은 것)가 접속에 끼어들지 못하게 한다.
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
export const SSH_BIN =
  SYSTEM_PATH.map((dir) => join(dir, "ssh")).find((file) => existsSync(file)) ??
  "ssh";
const SSH_ENV_KEEP = ["SSH_AUTH_SOCK", "LANG", "LC_ALL", "LC_CTYPE"];

export function sshEnv(env = process.env) {
  const { homedir, username } = userInfo();
  const out = {
    PATH: SYSTEM_PATH.join(":"),
    HOME: homedir,
    USER: username,
    LOGNAME: username,
  };
  for (const key of SSH_ENV_KEEP) if (env[key]) out[key] = env[key];
  return out;
}

// 고정할 때 ssh -G를 가두는 macOS 샌드박스. 설정을 풀어 찍기만 하면 되므로 새 프로세스 만들기와 네트워크,
// 파일 쓰기, 다른 시스템 서비스 부르기를 막는다. ssh가 시작할 때 여는 /dev/null 쓰기와, 계정 정보를 읽는
// 서비스 하나만 허용한다.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny process-fork)",
  "(deny network*)",
  "(deny mach-lookup)",
  '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
  "(deny file-write*)",
  '(allow file-write* (literal "/dev/null"))',
].join("");
export const SSH_SANDBOXED = existsSync(SANDBOX_EXEC);

// 고정하는 접속 값. 키는 ssh -G 출력의 이름이고, option은 -o로 넘길 때의 이름이다. list는 값이 여러 개인
// 설정이고, spaced는 그 여러 값을 -o 하나에 공백으로 이어 넘기는 설정이다. 글자 규칙은 ssh 설정 한 줄에서
// 다른 설정이나 토큰(%, ${})으로 읽힐 문자를 막는다.
const PATH_VALUE = /^[A-Za-z0-9_.~/@+-]+$/;
const ALGOS = /^[A-Za-z0-9_.@,+-]+$/;
const SSH_KEYS = {
  hostname: {
    option: "HostName",
    label: "접속 주소",
    re: /^[A-Za-z0-9.:-]+$/,
    required: true,
  },
  port: { option: "Port", label: "포트", re: /^[0-9]{1,5}$/, required: true },
  user: {
    option: "User",
    label: "사용자",
    re: /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/,
    required: true,
  },
  identityfile: {
    option: "IdentityFile",
    label: "키 파일",
    re: PATH_VALUE,
    list: true,
  },
  identitiesonly: {
    option: "IdentitiesOnly",
    label: "지정한 키만 쓰기",
    re: /^(?:yes|no)$/,
  },
  certificatefile: {
    option: "CertificateFile",
    label: "인증서 파일",
    re: PATH_VALUE,
    list: true,
  },
  userknownhostsfile: {
    option: "UserKnownHostsFile",
    label: "known_hosts 파일",
    re: PATH_VALUE,
    list: true,
    spaced: true,
  },
  globalknownhostsfile: {
    option: "GlobalKnownHostsFile",
    label: "시스템 known_hosts 파일",
    re: PATH_VALUE,
    list: true,
    spaced: true,
  },
  hostkeyalias: {
    option: "HostKeyAlias",
    label: "호스트 키 별칭",
    re: /^[A-Za-z0-9_.:-]+$/,
  },
  ciphers: { option: "Ciphers", label: "Ciphers", re: ALGOS },
  kexalgorithms: { option: "KexAlgorithms", label: "KexAlgorithms", re: ALGOS },
  macs: { option: "MACs", label: "MACs", re: ALGOS },
  hostkeyalgorithms: {
    option: "HostKeyAlgorithms",
    label: "HostKeyAlgorithms",
    re: ALGOS,
  },
  pubkeyacceptedalgorithms: {
    option: "PubkeyAcceptedAlgorithms",
    label: "PubkeyAcceptedAlgorithms",
    re: ALGOS,
  },
};

// 따옴표로 감싼 값은 따옴표를 떼고, 감싸지 않은 값은 공백 뒤 # 주석을 뗀다.
function unquote(raw) {
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
  if (quoted) return quoted[2];
  if (raw.startsWith("#")) return "";
  return raw.replace(/\s+#.*$/, "").trim();
}

// .env를 읽어 이름별 값을 돌려준다. keys를 주면 그 이름만 담는다. 같은 이름은 마지막 줄을 따른다.
// 심링크는 다른 폴더의 파일을 가리킬 수 있어 읽지 않는다. 실패하면 오류 코드만 담은 Error를 던진다.
export function readEnvValues(file = ENV_FILE, keys = null) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (err) {
    throw new Error(`${file} 파일을 읽지 못했다: ${err?.code ?? "unknown"}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${file}가 일반 파일이 아니라서 읽지 않는다(심링크 포함)`);
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    // 오류 객체를 통째로 찍지 않는다. 코드만 알린다.
    throw new Error(`${file} 파일을 읽지 못했다: ${err?.code ?? "unknown"}`);
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ASSIGN.exec(line);
    if (!m || (keys && !keys.includes(m[1]))) continue;
    values[m[1]] = unquote(m[2].trim());
  }
  return values;
}

export function dbTarget(values) {
  return {
    host: values.DB_QUERY_SSH_HOST ?? "",
    container: values.DB_QUERY_CONTAINER ?? "",
    path: values.DB_QUERY_PATH ?? "",
  };
}

export function logTarget(values) {
  const pick = (key, fallback) => values[key] || values[fallback] || "";
  return {
    host: pick("LOG_QUERY_SSH_HOST", "DB_QUERY_SSH_HOST"),
    container: pick("LOG_QUERY_CONTAINER", "DB_QUERY_CONTAINER"),
    dir: values.LOG_QUERY_DIR ?? "",
  };
}

function isEmpty(value) {
  return (
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

// 접속 값이 글자 규칙에 맞으면 null, 아니면 설정 이름만 담은 문장을 돌려준다. 값은 문장에 넣지 않는다.
export function sshProblem(ssh) {
  if (!ssh || typeof ssh !== "object" || Array.isArray(ssh))
    return "ssh 접속 값이 없다";
  for (const [key, rule] of Object.entries(SSH_KEYS)) {
    const value = ssh[key];
    if (isEmpty(value)) {
      if (rule.required) return `ssh 접속 값에 ${key}가 없다`;
      continue;
    }
    if (rule.list && !Array.isArray(value))
      return `ssh 접속 값 ${key}의 형식이 맞지 않는다`;
    const items = rule.list ? value : [value];
    if (!items.every((v) => typeof v === "string" && rule.re.test(v))) {
      return `ssh 접속 값 ${key}에 쓸 수 없는 글자가 있다`;
    }
  }
  return null;
}

// ssh -G로 이 호스트 이름의 접속 값을 풀어 읽는다. ssh -G는 접속하지 않고 설정만 풀어 찍지만, 설정에 Match
// exec 줄이 있으면 그 명령을 실행하므로 샌드박스가 있으면 그 안에서 돌린다. 출력에는 실제 주소가 있으므로
// 돌려주기만 하고 찍지 않는다. 경유 호스트를 쓰면 고정하지 않도록 오류를 던진다. sshConfigFile을 주면 그
// 파일만 읽고, "none"이면 설정 파일 없이 푼다.
function readSshConfig(host, { sshConfigFile } = {}) {
  if (!NAME.test(host))
    throw new Error("ssh 호스트 이름에 쓸 수 없는 글자가 있다");
  const sshArgs = [
    ...(sshConfigFile ? ["-F", sshConfigFile] : []),
    ...SSH_OPTS,
    "-G",
    host,
  ];
  const [bin, args] = SSH_SANDBOXED
    ? [SANDBOX_EXEC, ["-p", SANDBOX_PROFILE, SSH_BIN, ...sshArgs]]
    : [SSH_BIN, sshArgs];
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: sshEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) {
    // ssh의 오류 문장에는 주소가 들어갈 수 있어 찍지 않고, 샌드박스가 명령 실행을 막았는지만 본다.
    if (/fork: Operation not permitted/.test(res.stderr ?? "")) {
      throw new Error(
        "ssh 설정이 접속 값을 풀면서 명령을 실행하려 해서(Match exec) 멈췄다. 그런 줄 없이 풀리는 호스트만 고정한다",
      );
    }
    throw new Error("ssh 설정에서 접속 대상을 풀지 못했다");
  }
  const ssh = {};
  for (const line of res.stdout.split("\n")) {
    const [rawKey, ...rest] = line.trim().split(/\s+/);
    const key = rawKey?.toLowerCase();
    const value = rest.join(" ");
    if (!key || !value) continue;
    if ((key === "proxyjump" || key === "proxycommand") && value !== "none") {
      throw new Error(
        "경유 호스트(ProxyJump, ProxyCommand)를 쓰는 호스트는 고정하지 않는다",
      );
    }
    const rule = SSH_KEYS[key];
    if (!rule) continue;
    if (rule.list) {
      ssh[key] = [...(ssh[key] ?? []), ...(rule.spaced ? rest : [value])];
    } else {
      ssh[key] = value;
    }
  }
  return ssh;
}

// 고정할 때 ssh 설정이 이 호스트 이름으로 풀어 주는 접속 값을 읽는다. 글자 규칙에 맞지 않는 값이 있으면
// 고정하지 않도록 오류를 던진다. sshConfigFile은 테스트에서만 쓴다.
export function resolveSshTarget(host, { sshConfigFile } = {}) {
  const ssh = readSshConfig(host, { sshConfigFile });
  const problem = sshProblem(ssh);
  if (problem) throw new Error(problem);
  return ssh;
}

// 사용자 설정 없이 시스템 설정만으로 풀었을 때의 접속 값. 고정 화면에서 사용자 설정이 바꾼 값만 골라 보여 줄
// 때 쓴다. 시스템 설정 파일과 그 파일이 Include로 부르는 파일, 그 경로가 거치는 폴더와 심링크가 모두 root
// 소유이고 다른 사람이 쓸 수 없을 때만 시스템 설정을 쓰고, 아니면 설정 파일 없이 푼 값을 쓴다. -F로 준 파일은
// 사용자 설정으로 읽혀서 상대 경로 Include가 ~/.ssh 아래로 풀리므로 그 기준으로 따라간다.
const SYSTEM_SSH_CONFIG = "/etc/ssh/ssh_config";

// 경로를 / 부터 한 단계씩 직접 따라가며, 거치는 폴더와 심링크, 마지막 파일이나 폴더가 모두 root 소유이고
// 폴더와 파일은 다른 사람이 쓸 수 없을 때만 true를 돌려준다. 심링크는 가리키는 경로도 같은 방식으로 따라가고,
// ..은 운영체제처럼 실제로 도착한 폴더의 위 폴더로 푼다. ACL은 보지 않는다. 테스트에서도 쓴다.
export function rootOnly(path) {
  let hops = 0;
  const walk = (target, from) => {
    let cur = target.startsWith("/") ? "/" : from;
    for (const part of target.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        cur = dirname(cur);
        continue;
      }
      const next = cur === "/" ? `/${part}` : `${cur}/${part}`;
      const stat = lstatSync(next);
      if (stat.uid !== 0) return null;
      if (stat.isSymbolicLink()) {
        if (++hops > 32) return null;
        cur = walk(readlinkSync(next), cur);
        if (cur === null) return null;
        continue;
      }
      if ((stat.mode & 0o022) !== 0) return null;
      cur = next;
    }
    return cur;
  };
  try {
    const top = lstatSync("/");
    if (top.uid !== 0 || (top.mode & 0o022) !== 0) return false;
    if (!path.startsWith("/")) return false;
    const real = walk(path, "/");
    if (real === null) return false;
    const stat = lstatSync(real);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

export function sshDefaults(host) {
  const walk = walkSshConfig([
    { file: SYSTEM_SSH_CONFIG, base: join(userInfo().homedir, ".ssh") },
  ]);
  const trusted =
    walk.paths.includes(SYSTEM_SSH_CONFIG) &&
    walk.found.length === 0 &&
    walk.unverified.length === 0 &&
    walk.paths.every((path) => rootOnly(path));
  return readSshConfig(host, {
    sshConfigFile: trusted ? SYSTEM_SSH_CONFIG : "none",
  });
}

// 고정 화면에 보여 줄 접속 값 줄. 주소·포트·사용자는 늘 보여 주고, 나머지는 defaults와 다를 때만 보여 준다.
export function sshDisplayLines(ssh, defaults = {}) {
  const lines = [];
  let changed = 0;
  for (const [key, rule] of Object.entries(SSH_KEYS)) {
    const value = ssh?.[key];
    const text = Array.isArray(value) ? value.join(", ") : (value ?? "");
    if (!rule.required) {
      if (
        JSON.stringify(value ?? null) === JSON.stringify(defaults[key] ?? null)
      )
        continue;
      changed++;
    }
    lines.push(`  ${rule.label}: ${text || "(비어 있음)"}`);
  }
  lines.push(
    changed
      ? "  위에 없는 접속 설정은 시스템 ssh 기본값과 같다"
      : "  나머지 접속 설정은 시스템 ssh 기본값과 같다",
  );
  return lines;
}

// Include의 파일 이름에 쓰는 *와 ?만 정규식으로 바꾼다. 이름은 INCLUDE_PATH를 통과한 글자만 온다. ssh의
// glob처럼 *와 ?가 줄바꿈 문자에도 맞게 한다.
function globToRegExp(name) {
  const body = name
    .split("")
    .map((ch) =>
      ch === "*"
        ? "[\\s\\S]*"
        : ch === "?"
          ? "[\\s\\S]"
          : ch.replace(/[.+]/, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

// Include 경로로 믿고 따라가는 글자. 따옴표, 역슬래시, 변수(%, $), [ ] { } 같은 것이 들어가면 ssh가 이 검사와
// 다르게 풀 수 있어서 따라가지 않고 확인하지 못한 것으로 둔다.
const INCLUDE_PATH = /^[A-Za-z0-9_.\/~*?+@-]+$/;

// ssh 설정 파일을 Include까지 따라가며 읽는다. 명령을 실행하는 Match exec 줄은 found에, 이 검사가 ssh와 같게
// 읽는다고 장담할 수 없는 줄과 읽지 못한 파일은 unverified에, 읽은 파일과 glob으로 훑은 폴더는 paths에 담는다.
// 따옴표나 역슬래시가 든 키워드, ASCII 밖 글자, 줄 가운데의 \r, 글자로 시작하지 않는 줄, 따라갈 수 없는
// Include, 일반 파일이 아니거나 너무 큰 파일, 제어 문자나 ASCII 밖 글자가 든 파일 이름이 unverified에 든다.
// 위치는 파일과 줄 번호만 담는다. 같은 파일도 상대 경로 Include를 푸는 기준 폴더가 다르면 따로 읽는다.
const MAX_CONFIG_BYTES = 1 << 20;
function walkSshConfig(roots) {
  const home = userInfo().homedir;
  const found = [];
  const unverified = [];
  const paths = [];
  const seen = new Set();
  const visit = (file, base, depth) => {
    const key = `${base}\0${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (depth > 16) {
      unverified.push(file);
      return;
    }
    let text;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
        unverified.push(file);
        return;
      }
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") unverified.push(file);
      return;
    }
    paths.push(file);
    text.split("\n").forEach((raw, i) => {
      const at = `${file}:${i + 1}`;
      // ssh처럼 줄 끝의 공백, 탭, \r, \f를 떼고 앞의 공백과 탭을 뗀다. 빈 줄과 #로 시작하는 줄은 ssh도 읽지 않는다.
      const line = raw.replace(/[ \t\r\f]+$/, "").replace(/^[ \t]+/, "");
      if (!line || line.startsWith("#")) return;
      const m = /^([A-Za-z]+)(?:[ \t]*=[ \t]*|[ \t]+|$)([\x20-\x7e\t]*)$/.exec(
        line,
      );
      if (!m) {
        unverified.push(at);
        return;
      }
      const key = m[1].toLowerCase();
      const rest = m[2];
      if (key === "match") {
        if (/exec/i.test(rest)) found.push(at);
        else if (/["'\\]/.test(rest)) unverified.push(at);
        return;
      }
      if (key !== "include") return;
      for (const pattern of rest.split(/[ \t]+/).filter(Boolean)) {
        if (
          !INCLUDE_PATH.test(pattern) ||
          (pattern.startsWith("~") && !pattern.startsWith("~/"))
        ) {
          unverified.push(at);
          continue;
        }
        // 경로를 정리하지 않고 이어 붙여서 ..와 심링크를 ssh처럼 운영체제가 풀게 한다.
        const path = pattern.startsWith("~/")
          ? `${home}${pattern.slice(1)}`
          : pattern.startsWith("/")
            ? pattern
            : `${base}/${pattern}`;
        const slash = path.lastIndexOf("/");
        const dir = path.slice(0, slash) || "/";
        const name = path.slice(slash + 1);
        if (/[*?]/.test(dir)) {
          unverified.push(at);
          continue;
        }
        if (!/[*?]/.test(name)) {
          visit(path, base, depth + 1);
          continue;
        }
        const re = globToRegExp(name);
        let entries;
        try {
          entries = readdirSync(dir);
        } catch (err) {
          if (err?.code !== "ENOENT") unverified.push(at);
          continue;
        }
        paths.push(dir);
        for (const entry of entries.filter((e) => re.test(e)).sort()) {
          // 이름에 줄바꿈 같은 글자가 들어가면 위치를 보여 주는 화면이 흐트러지므로 따라가지 않고 알린다.
          if (/[^\x20-\x7e]/.test(entry)) {
            unverified.push(at);
            continue;
          }
          visit(`${dir === "/" ? "" : dir}/${entry}`, base, depth + 1);
        }
      }
    });
  };
  for (const { file, base } of roots) visit(file, base, 0);
  return { found, unverified, paths };
}

// ssh 설정에서 명령을 실행하는 Match exec 줄을 찾는다. 샌드박스가 없는 시스템에서 고정하기 전에 사용자에게
// 알릴 목적으로 쓴다. 사용자 설정과 시스템 설정을 보고, files는 테스트에서만 준다.
export function findMatchExec(files) {
  const home = userInfo().homedir;
  const { found, unverified } = walkSshConfig(
    files ?? [
      { file: join(home, ".ssh", "config"), base: join(home, ".ssh") },
      { file: SYSTEM_SSH_CONFIG, base: "/etc/ssh" },
    ],
  );
  return { found, unverified };
}

// 고정한 접속 값으로 ssh 인자를 만든다. 설정 파일은 읽지 않는다. 돌려준 배열 뒤에 원격 명령을 붙여 쓴다.
export function sshConnectArgs(ssh, host) {
  const problem = sshProblem(ssh);
  if (problem) throw new Error(problem);
  if (!NAME.test(host))
    throw new Error("ssh 호스트 이름에 쓸 수 없는 글자가 있다");
  const args = ["-F", "none", ...SSH_OPTS];
  for (const [key, rule] of Object.entries(SSH_KEYS)) {
    const value = ssh[key];
    if (isEmpty(value)) continue;
    if (!rule.list) {
      args.push("-o", `${rule.option}=${value}`);
    } else if (rule.spaced) {
      args.push("-o", `${rule.option}=${value.join(" ")}`);
    } else {
      for (const item of value) args.push("-o", `${rule.option}=${item}`);
    }
  }
  args.push(host);
  return args;
}

// git 저장소 안이면 메인 체크아웃의 실제 경로를, 아니면 null을 돌려준다.
export function mainCheckout(cwd) {
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const main =
    res.status === 0 ? /^worktree (.+)$/m.exec(res.stdout)?.[1] : null;
  if (!main) return null;
  try {
    return realpathSync(main);
  } catch {
    return null;
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

// 고정 파일과 폴더가 심링크가 아니고 이 계정 소유이며, 다른 사람이 쓸 수 없는지 본다.
// 문제가 없으면 null, 있으면 알릴 문장을 돌려준다. 파일이 없으면 "missing"을 돌려준다.
export function checkPinFileMode(pinFile = PIN_FILE) {
  const uid = currentUid();
  const dir = dirname(pinFile);
  let dirStat;
  let fileStat;
  try {
    dirStat = lstatSync(dir);
    fileStat = lstatSync(pinFile);
  } catch (err) {
    if (err?.code === "ENOENT") return "missing";
    return `고정 파일을 확인하지 못했다: ${err?.code ?? "unknown"}`;
  }
  if (!dirStat.isDirectory() || (dirStat.mode & 0o022) !== 0) {
    return "고정 파일 폴더가 심링크이거나 다른 사람이 쓸 수 있어서 믿지 않는다";
  }
  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
    return "고정 파일이 심링크이거나 권한이 소유자 전용(600)이 아니어서 믿지 않는다";
  }
  if (uid !== null && (dirStat.uid !== uid || fileStat.uid !== uid)) {
    return "고정 파일이나 그 폴더의 소유자가 이 계정이 아니어서 믿지 않는다";
  }
  return null;
}

export function readPins(pinFile = PIN_FILE) {
  const problem = checkPinFileMode(pinFile);
  if (problem === "missing") return { version: 2, roots: {} };
  if (problem) throw new Error(problem);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pinFile, "utf8"));
  } catch {
    throw new Error("고정 파일을 읽지 못했다");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.roots ||
    typeof parsed.roots !== "object"
  ) {
    throw new Error("고정 파일 형식이 맞지 않는다");
  }
  // 접속 값을 담기 전 형식(version 1)의 고정은 버리고 다시 고정받는다.
  if (parsed.version !== 2) return { version: 2, roots: {} };
  return parsed;
}

// 고정 파일에 적을 한 종류의 항목. 호스트가 있으면 ssh 설정을 풀어 접속 값을 함께 담는다.
export function pinEntry(target, { sshConfigFile } = {}) {
  return {
    target: { ...target },
    ssh: target.host ? resolveSshTarget(target.host, { sshConfigFile }) : null,
  };
}

function sameTarget(a, b) {
  if (!b || typeof b !== "object") return false;
  const keys = Object.keys(a).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) &&
    keys.every((key) => a[key] === b[key])
  );
}

// 현재 폴더와 조회 대상이 고정한 값과 같은지 본다. 같으면 { ssh }로 고정한 접속 값(호스트가 없으면 null)을,
// 다르면 { problem }으로 알릴 문장을 돌려준다. 조회 스크립트는 돌려받은 접속 값으로 바로 접속한다.
export function verifyPin(
  kind,
  target,
  { pinFile = PIN_FILE, cwd = process.cwd(), pinCommand } = {},
) {
  const how = pinCommand
    ? `사용자가 이 폴더에서 터미널을 열고 ${pinCommand}를 직접 돌려야 한다`
    : "사용자가 이 폴더에서 터미널로 query-pin.mjs를 직접 돌려야 한다";
  let root;
  let pins;
  try {
    root = realpathSync(cwd);
    pins = readPins(pinFile);
  } catch (err) {
    return { problem: `${err.message}. ${how}` };
  }
  const saved = pins.roots[root]?.[kind];
  if (!saved || typeof saved !== "object" || !saved.target) {
    const main = mainCheckout(root);
    if (main && main !== root) {
      return {
        problem: `이 폴더는 worktree라서 조회가 돌지 않는다. 메인 체크아웃(${main})에서 다시 부른다`,
      };
    }
    return {
      problem: `이 폴더는 조회할 폴더로 고정되지 않아 멈췄다. 조회는 사용자가 고정한 프로젝트 폴더에서만 돈다. ${how}`,
    };
  }
  if (!sameTarget(target, saved.target)) {
    return {
      problem: `.env의 조회 설정이 고정한 값과 달라 멈췄다. 사용자가 바꾼 것이 맞다면 ${how.replace(/^사용자가 /, "사용자가 다시 ")}`,
    };
  }
  if (!target.host) return { ssh: null };
  const problem = sshProblem(saved.ssh);
  if (problem) return { problem: `고정 파일의 ${problem}. ${how}` };
  return { ssh: saved.ssh };
}
