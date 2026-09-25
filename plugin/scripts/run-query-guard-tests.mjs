#!/usr/bin/env node
// 조회 고정 가드 회귀 테스트. query-guard.mjs, query-pin.mjs, db-query.mjs, log-query.mjs를 고친 뒤 실행한다.
//
// 사용: node run-query-guard-tests.mjs
// 임시 폴더의 고정 파일과 ssh 설정 파일로 가드 함수를 시험하고, 실제 사용자 고정 파일은 읽기만 한다.
// ssh는 -G로 설정을 풀어 보기만 하고 접속하지 않는다. Match exec 시험은 샌드박스가 명령을 막는지 보고, 샌드박스가
// 없는 시스템에서는 임시 폴더에 env 출력만 적는다. 조회 스크립트는 고정되지 않은 임시 폴더에서 돌려 원격 접속 전에
// 멈추는지만 본다.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SSH_BIN,
  SSH_OPTS,
  SSH_SANDBOXED,
  dbTarget,
  findMatchExec,
  logTarget,
  pinEntry,
  readEnvValues,
  rootOnly,
  sshConnectArgs,
  sshDisplayLines,
  sshEnv,
  verifyPin,
} from "./query-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "query-guard-test-")));
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`통과  ${name}`);
  } else {
    failed++;
    console.log(`실패  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function writePins(file, roots, { mode = 0o600, version = 2 } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ version, roots }), { mode });
  chmodSync(file, mode);
}

function throwsWith(fn, text) {
  try {
    fn();
    return false;
  } catch (err) {
    return err.message.includes(text);
  }
}

// ssh -G 출력에서 한 설정의 값을 모두 모은다.
function sshG(args, host) {
  const res = spawnSync("ssh", [...args, "-G", host], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const values = {};
  for (const line of res.stdout.split("\n")) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key) (values[key.toLowerCase()] ??= []).push(rest.join(" "));
  }
  return { status: res.status, values };
}

try {
  const project = join(base, "project");
  const other = join(base, "other");
  mkdirSync(project);
  mkdirSync(other);
  const sshA = join(base, "ssh-a");
  const sshB = join(base, "ssh-b");
  writeFileSync(
    sshA,
    [
      "Host testalias",
      "  HostName 192.0.2.1",
      "  User deploy",
      "  Port 2222",
      "  IdentityFile ~/.ssh/test_key",
      "  Ciphers aes256-gcm@openssh.com",
      "  SendEnv LANG",
      "",
    ].join("\n"),
  );
  writeFileSync(sshB, "Host testalias\n  HostName 192.0.2.2\n  User deploy\n");
  const target = {
    host: "testalias",
    container: "app",
    path: "/app/data/app.db",
  };
  const pinFile = join(base, "pins", "query-pins.json");
  const opts = { pinFile, cwd: project };
  const entry = pinEntry(target, { sshConfigFile: sshA });

  check(
    "고정할 때 ssh 설정이 푼 주소·포트·사용자·키 파일·알고리즘을 담는다",
    entry.ssh.hostname === "192.0.2.1" &&
      entry.ssh.port === "2222" &&
      entry.ssh.user === "deploy" &&
      entry.ssh.identityfile?.join() === "~/.ssh/test_key" &&
      entry.ssh.ciphers === "aes256-gcm@openssh.com",
    JSON.stringify(entry.ssh),
  );

  check(
    "고정 파일이 없으면 멈춘다",
    verifyPin("db", target, opts).problem?.includes("고정되지 않아"),
  );

  writePins(pinFile, { [project]: { db: entry } });
  const ok = verifyPin("db", target, opts);
  check(
    "고정한 폴더와 대상이면 고정한 접속 값을 돌려준다",
    !ok.problem && ok.ssh?.hostname === "192.0.2.1",
    JSON.stringify(ok),
  );

  check(
    "고정하지 않은 다른 폴더에서는 멈춘다",
    verifyPin("db", target, { ...opts, cwd: other }).problem?.includes(
      "고정되지 않아",
    ),
  );

  check(
    "고정한 종류가 아니면 멈춘다",
    verifyPin(
      "log",
      { host: "testalias", container: "app", dir: "" },
      opts,
    ).problem?.includes("고정되지 않아"),
  );

  for (const [key, value] of [
    ["host", "otheralias"],
    ["container", "app2"],
    ["path", "/app/data/other.db"],
  ]) {
    check(
      `${key}를 바꾸면 멈춘다`,
      verifyPin("db", { ...target, [key]: value }, opts).problem?.includes(
        "달라",
      ),
    );
  }

  // 조회는 ssh 설정을 읽지 않으므로, 고정한 뒤 설정이 다른 주소로 풀려도 고정한 주소로만 접속한다.
  const other2 = pinEntry(target, { sshConfigFile: sshB });
  check(
    "고정한 뒤 ssh 설정이 바뀌어도 고정한 접속 값으로만 접속한다",
    other2.ssh.hostname === "192.0.2.2" &&
      verifyPin("db", target, opts).ssh?.hostname === "192.0.2.1",
  );

  const args = sshConnectArgs(ok.ssh, target.host);
  check(
    "접속 인자는 설정 파일을 읽지 않는 -F none으로 시작하고 고정한 값을 넘긴다",
    args[0] === "-F" &&
      args[1] === "none" &&
      args.at(-1) === "testalias" &&
      args.includes("HostName=192.0.2.1") &&
      args.includes("Port=2222") &&
      args.includes("User=deploy") &&
      args.includes("IdentityFile=~/.ssh/test_key") &&
      args.includes("Ciphers=aes256-gcm@openssh.com") &&
      !args.some((a) => /^SendEnv=/i.test(a)),
    args.join(" "),
  );

  // ssh가 이 인자를 설정 파일 없이 풀었을 때 고정한 값과 같은지 본다. 접속하지 않는다.
  const round = sshG(args.slice(0, -1), target.host);
  const same = Object.entries(ok.ssh).every(([key, value]) => {
    const got = round.values[key] ?? [];
    return Array.isArray(value)
      ? got.flatMap((v) => v.split(/\s+/)).join(" ") === value.join(" ")
      : got.join(" ") === value;
  });
  check(
    "ssh가 접속 인자를 설정 파일 없이 고정한 값과 같게 푼다",
    round.status === 0 && same && !round.values.sendenv,
    JSON.stringify(round.values.hostname),
  );

  for (const [label, line] of [
    ["ProxyJump", "  ProxyJump jumphost"],
    ["ProxyCommand", "  ProxyCommand nc %h %p"],
  ]) {
    const file = join(base, `ssh-${label}`);
    writeFileSync(file, `Host testalias\n  HostName 192.0.2.1\n${line}\n`);
    check(
      `${label}를 쓰는 호스트는 고정하지 않는다`,
      throwsWith(
        () => pinEntry(target, { sshConfigFile: file }),
        "경유 호스트",
      ),
    );
  }

  const spaced = join(base, "ssh-spaced");
  writeFileSync(
    spaced,
    'Host testalias\n  HostName 192.0.2.1\n  IdentityFile "~/.ssh/my key"\n',
  );
  check(
    "ssh 설정 값에 공백 같은 글자가 있으면 고정하지 않는다",
    throwsWith(
      () => pinEntry(target, { sshConfigFile: spaced }),
      "쓸 수 없는 글자",
    ),
  );

  for (const [label, ssh, text] of [
    [
      "주소에 옵션을 끼워 넣은 값",
      { ...ok.ssh, hostname: "192.0.2.1 -oProxyCommand=x" },
      "쓸 수 없는 글자",
    ],
    [
      "키 파일에 토큰을 넣은 값",
      { ...ok.ssh, identityfile: ["~/.ssh/%d"] },
      "쓸 수 없는 글자",
    ],
    [
      "여러 값 설정을 문자열로 바꾼 값",
      { ...ok.ssh, identityfile: "~/.ssh/test_key" },
      "형식",
    ],
    ["주소가 없는 값", { ...ok.ssh, hostname: "" }, "없다"],
    ["접속 값이 없는 고정", null, "없다"],
  ]) {
    writePins(pinFile, { [project]: { db: { target, ssh } } });
    check(
      `고정 파일의 ${label}은 쓰지 않고 멈춘다`,
      verifyPin("db", target, opts).problem?.includes(text),
      JSON.stringify(verifyPin("db", target, opts)),
    );
  }

  writePins(pinFile, { [project]: { db: "a".repeat(64) } }, { version: 1 });
  check(
    "해시만 적은 옛 형식의 고정은 믿지 않고 다시 고정받는다",
    verifyPin("db", target, opts).problem?.includes("고정되지 않아"),
  );

  writePins(pinFile, { [project]: { db: entry } });
  chmodSync(pinFile, 0o644);
  check(
    "고정 파일 권한이 600이 아니면 멈춘다",
    verifyPin("db", target, opts).problem?.includes("600"),
  );
  chmodSync(pinFile, 0o600);

  const linkedPins = join(base, "linked", "query-pins.json");
  mkdirSync(dirname(linkedPins), { mode: 0o700 });
  symlinkSync(pinFile, linkedPins);
  check(
    "고정 파일이 심링크면 멈춘다",
    verifyPin("db", target, { ...opts, pinFile: linkedPins }).problem?.includes(
      "심링크",
    ),
  );

  const linkedDir = join(base, "linked-dir");
  symlinkSync(dirname(pinFile), linkedDir);
  check(
    "고정 파일 폴더가 심링크면 멈춘다",
    verifyPin("db", target, {
      ...opts,
      pinFile: join(linkedDir, "query-pins.json"),
    }).problem?.includes("심링크"),
  );

  chmodSync(dirname(pinFile), 0o770);
  check(
    "고정 파일 폴더를 다른 사람이 쓸 수 있으면 멈춘다",
    verifyPin("db", target, opts).problem?.includes("폴더"),
  );
  chmodSync(dirname(pinFile), 0o700);

  const sshArgs = SSH_OPTS.join(" ");
  check(
    "ssh 호출은 연결 공유·로컬 명령·정규화를 끄고 모르는 호스트 키를 받지 않는다",
    [
      "ControlPath=none",
      "ControlMaster=no",
      "PermitLocalCommand=no",
      "CanonicalizeHostname=no",
      "StrictHostKeyChecking=yes",
      "ClearAllForwardings=yes",
      "ForwardAgent=no",
      "BatchMode=yes",
      "SecurityKeyProvider=internal",
    ].every((opt) => sshArgs.includes(opt)),
  );

  const env = sshEnv({
    PATH: "/tmp/evil:/usr/bin",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SSH_ASKPASS: "/tmp/evil",
    SSH_ASKPASS_REQUIRE: "force",
    SSH_SK_PROVIDER: "/tmp/evil.dylib",
    NODE_OPTIONS: "--require /tmp/evil.cjs",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    LANG: "ko_KR.UTF-8",
  });
  check(
    "ssh에는 시스템 PATH와 접속에 필요한 환경 변수만 넘긴다",
    env.PATH === "/usr/bin:/bin:/usr/sbin:/sbin" &&
      env.SSH_AUTH_SOCK === "/tmp/agent.sock" &&
      env.LANG === "ko_KR.UTF-8" &&
      Object.keys(env).every((key) =>
        ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "LANG"].includes(
          key,
        ),
      ),
    Object.keys(env).join(" "),
  );
  check(
    "ssh는 시스템 폴더의 실행 파일로 부른다",
    /^\/(?:usr\/)?s?bin\/ssh$/.test(SSH_BIN),
    SSH_BIN,
  );
  for (const script of ["db-query.mjs", "log-query.mjs"]) {
    const source = readFileSync(join(here, script), "utf8");
    check(
      `${script}는 시스템 ssh를 줄인 환경 변수로 부른다`,
      source.includes("SSH_BIN") &&
        source.includes("env: sshEnv()") &&
        !/spawn\("ssh"/.test(source),
    );
  }

  // 고정할 때 ssh -G가 설정의 Match exec 명령을 실행하지 못하는지 본다. 샌드박스가 없는 시스템에서는 그 명령이
  // 받은 환경 변수로, 푸는 ssh에도 줄인 환경 변수가 가는지 본다.
  const envDump = join(base, "match-env.txt");
  const matchCfg = join(base, "ssh-match");
  writeFileSync(
    matchCfg,
    `Match exec "env > ${envDump}"\nHost testalias\n  HostName 192.0.2.1\n  User deploy\n`,
  );
  process.env.SSH_ASKPASS = "/tmp/evil";
  process.env.QUERY_GUARD_TEST_LEAK = "leak";
  if (SSH_SANDBOXED) {
    check(
      "고정할 때 ssh 설정의 Match exec 명령은 샌드박스가 막고 고정을 멈춘다",
      throwsWith(
        () => pinEntry(target, { sshConfigFile: matchCfg }),
        "Match exec",
      ) && !existsSync(envDump),
    );
  } else {
    pinEntry(target, { sshConfigFile: matchCfg });
    const dumped = readFileSync(envDump, "utf8");
    check(
      "고정할 때 ssh 설정을 푸는 ssh에도 줄인 환경 변수만 넘긴다",
      !dumped.includes("SSH_ASKPASS") &&
        !dumped.includes("QUERY_GUARD_TEST_LEAK") &&
        dumped.includes("PATH=/usr/bin:/bin:/usr/sbin:/sbin"),
    );
  }
  delete process.env.SSH_ASKPASS;
  delete process.env.QUERY_GUARD_TEST_LEAK;
  const guardSource = readFileSync(join(here, "query-guard.mjs"), "utf8");
  check(
    "고정할 때 ssh 설정을 푸는 ssh도 줄인 환경 변수로 부른다",
    /function readSshConfig[\s\S]*?env: sshEnv\(\)[\s\S]*?\n}/.test(
      guardSource,
    ),
  );

  // Match exec 줄 찾기. 상대 경로 Include와 이름의 *를 따라가고, 풀 수 없는 Include는 확인하지 못한 것으로 둔다.
  const cfgDir = join(base, "sshcfg");
  mkdirSync(join(cfgDir, "conf.d"), { recursive: true });
  writeFileSync(
    join(cfgDir, "config"),
    "Include conf.d/*.conf\nHost a\n  HostName 192.0.2.1\n",
  );
  writeFileSync(join(cfgDir, "conf.d", "10-a.conf"), "Host b\n  Port 22\n");
  writeFileSync(
    join(cfgDir, "conf.d", "20-b.conf"),
    'Host c\n  Port 22\nMatch host c exec "true"\n',
  );
  writeFileSync(join(cfgDir, "conf.d", "30-c.txt"), 'Match exec "true"\n');
  const scan = findMatchExec([{ file: join(cfgDir, "config"), base: cfgDir }]);
  check(
    "Include로 부른 파일의 Match exec 줄을 찾고 이름이 맞지 않는 파일은 건너뛴다",
    scan.found.length === 1 &&
      scan.found[0] === `${join(cfgDir, "conf.d", "20-b.conf")}:3` &&
      scan.unverified.length === 0,
    JSON.stringify(scan),
  );
  writeFileSync(
    join(cfgDir, "env-include"),
    "Include ${HOME}/x.conf\nMatch=exec true\n",
  );
  const scan2 = findMatchExec([
    { file: join(cfgDir, "env-include"), base: cfgDir },
  ]);
  check(
    "환경 변수로 쓴 Include는 확인하지 못한 것으로 두고, = 모양의 Match exec도 찾는다",
    scan2.unverified.length === 1 && scan2.found.length === 1,
    JSON.stringify(scan2),
  );
  const scan3 = findMatchExec([
    { file: join(cfgDir, "missing"), base: cfgDir },
    { file: join(cfgDir, "conf.d", "10-a.conf"), base: cfgDir },
  ]);
  check(
    "Match exec가 없거나 파일이 없으면 아무것도 알리지 않는다",
    scan3.found.length === 0 && scan3.unverified.length === 0,
  );

  // ssh는 명령을 실행하는데 줄 단위 검사가 놓칠 수 있는 모양은 모두 알려야 한다.
  const tricky = {
    "따옴표로 감싼 Match": '"Match" exec "true"',
    "키워드 가운데 따옴표": 'Ma"tch" exec true',
    "= 로 시작하는 줄": "=Match exec true",
    "따옴표로 감싼 Include": `"Include" "${cfgDir}/evil.conf"`,
    "= 로 시작하는 Include": `=Include ${cfgDir}/evil.conf`,
    "줄 끝 \\r\\r": "Match exec true\r\r",
    "따옴표 안의 \\r": 'Match exec "true;#\r"',
    "줄 가운데 U+2028": "Match exec true",
    "줄 가운데 U+2029": "Match exec true",
    "exec 가운데 따옴표": 'Match e"x"ec true',
    "exec 가운데 작은따옴표": "Match ex''ec true",
    "!exec 가운데 따옴표": 'Match !e"xe"c true',
    "작은따옴표 Include": `Include '${cfgDir}/evil.conf'`,
    "공백이 든 Include": `Include "${cfgDir}/sp ace/evil.conf"`,
    "빈 따옴표가 든 Include": `Include ${cfgDir}/ev""il.conf`,
    "역슬래시가 든 Include": `Include ${cfgDir}/ev\\il.conf`,
    "~사용자 Include": "Include ~nobody/../evil.conf",
    "\\r로 시작하는 줄": "\rMatch exec true",
  };
  const missed = [];
  Object.entries(tricky).forEach(([name, line], n) => {
    const file = join(cfgDir, `tricky-${n}`);
    writeFileSync(file, `Host a\n  Port 22\n${line}\n`);
    const r = findMatchExec([{ file, base: cfgDir }]);
    if (r.found.length + r.unverified.length === 0) missed.push(name);
  });
  check(
    "따옴표·역슬래시·ASCII 밖 글자·줄 가운데 \\r·글자로 시작하지 않는 줄은 확인하지 못한 것으로 알린다",
    missed.length === 0,
    missed.join(", "),
  );

  // Include 경로의 ..은 운영체제처럼 심링크를 따라 푼다.
  mkdirSync(join(base, "real", "sub"), { recursive: true });
  writeFileSync(join(base, "real", "evil.conf"), "Match exec true\n");
  symlinkSync(join(base, "real", "sub"), join(cfgDir, "lnk"));
  writeFileSync(join(cfgDir, "dotdot"), "Include lnk/../evil.conf\n");
  const scan4 = findMatchExec([{ file: join(cfgDir, "dotdot"), base: cfgDir }]);
  check(
    "Include 경로의 ..은 심링크를 따라 풀어 그 파일의 Match exec 줄을 찾는다",
    scan4.found.length === 1,
    JSON.stringify(scan4),
  );

  writeFileSync(
    join(cfgDir, "plain"),
    '# 주석은 한글이어도 괜찮다\nHost a\n  IdentityFile "~/.ssh/id_ed25519"\n  Port=22\n',
  );
  const scan5 = findMatchExec([{ file: join(cfgDir, "plain"), base: cfgDir }]);
  check(
    "흔한 설정(한글 주석, 따옴표로 감싼 값, = 모양)은 알리지 않는다",
    scan5.found.length === 0 && scan5.unverified.length === 0,
    JSON.stringify(scan5),
  );

  // glob이 고른 파일 이름에 줄바꿈이 들어 있으면 따라가지 않고 알린다.
  mkdirSync(join(cfgDir, "nl.d"), { recursive: true });
  writeFileSync(join(cfgDir, "nl.d", "a\nb.conf"), "Match exec true\n");
  writeFileSync(join(cfgDir, "nl-include"), "Include nl.d/*.conf\n");
  const scan6 = findMatchExec([
    { file: join(cfgDir, "nl-include"), base: cfgDir },
  ]);
  check(
    "줄바꿈이 든 파일 이름을 glob이 고르면 확인하지 못한 것으로 알린다",
    scan6.found.length + scan6.unverified.length > 0 &&
      [...scan6.found, ...scan6.unverified].every((w) => !w.includes("\n")),
    JSON.stringify(scan6),
  );

  // 같은 파일이라도 기준 폴더가 다르면 상대 경로 Include가 다른 파일로 풀리므로 따로 읽는다.
  mkdirSync(join(cfgDir, "base1"), { recursive: true });
  mkdirSync(join(cfgDir, "base2"), { recursive: true });
  writeFileSync(join(cfgDir, "shared"), "Include rel.conf\n");
  writeFileSync(join(cfgDir, "base2", "rel.conf"), "Match exec true\n");
  const scan7 = findMatchExec([
    { file: join(cfgDir, "shared"), base: join(cfgDir, "base1") },
    { file: join(cfgDir, "shared"), base: join(cfgDir, "base2") },
  ]);
  check(
    "같은 파일을 기준 폴더가 다른 두 곳에서 부르면 둘 다 따라간다",
    scan7.found.length === 1,
    JSON.stringify(scan7),
  );

  // 일반 파일이 아닌 Include 대상은 읽지 않고 알린다. 읽으면 끝없이 이어지는 장치 파일이 있다.
  writeFileSync(join(cfgDir, "dev-include"), "Include /dev/zero\n");
  const scan8 = findMatchExec([
    { file: join(cfgDir, "dev-include"), base: cfgDir },
  ]);
  check(
    "장치 파일을 Include하면 읽지 않고 확인하지 못한 것으로 알린다",
    scan8.unverified.includes("/dev/zero"),
    JSON.stringify(scan8),
  );

  // 시스템 설정을 믿을지 볼 때 경로가 거치는 심링크와 폴더를 모두 본다.
  const userLink = join(base, "to-system-config");
  const userDirLink = join(base, "to-system-ssh");
  if (existsSync("/etc/ssh/ssh_config")) {
    symlinkSync("/etc/ssh/ssh_config", userLink);
    symlinkSync("/etc/ssh", userDirLink);
    check(
      "root만 쓸 수 있는 시스템 설정 경로는 믿는다",
      rootOnly("/etc/ssh/ssh_config") && rootOnly("/usr/bin/../bin/ssh"),
    );
    check(
      "이 계정이 만든 심링크나 이 계정 폴더를 거치는 경로는 믿지 않는다",
      !rootOnly(userLink) &&
        !rootOnly(`${userDirLink}/ssh_config`) &&
        !rootOnly(`${cfgDir}/../../../../../../../../etc/ssh/ssh_config`) &&
        !rootOnly(join(cfgDir, "config")),
    );
  }

  const shown = sshDisplayLines(ok.ssh, {
    ...ok.ssh,
    identityfile: ["~/.ssh/id_ed25519"],
  });
  check(
    "고정 화면은 주소·포트·사용자와 기본값과 다른 설정만 보여 준다",
    shown.some((l) => l.includes("접속 주소: 192.0.2.1")) &&
      shown.some((l) => l.includes("키 파일: ~/.ssh/test_key")) &&
      !shown.some((l) => l.includes("Ciphers")),
    shown.join(" / "),
  );

  // 메인 체크아웃만 고정하고 worktree에서 부르면 메인 체크아웃을 알려 준다.
  const repo = join(base, "repo");
  const tree = join(base, "repo-tree");
  mkdirSync(repo);
  const git = (cwd, ...a) =>
    spawnSync("git", a, { cwd, encoding: "utf8", stdio: "ignore" }).status;
  const gitOk =
    git(repo, "init", "-q") === 0 &&
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ) === 0 &&
    git(repo, "worktree", "add", "-q", tree) === 0;
  if (gitOk) {
    writePins(pinFile, { [realpathSync(repo)]: { db: entry } });
    const msg = verifyPin("db", target, { ...opts, cwd: tree }).problem;
    check(
      "worktree에서는 메인 체크아웃에서 부르라고 알린다",
      msg?.includes("worktree") && msg.includes(realpathSync(repo)),
      msg ?? "null",
    );
    check(
      "메인 체크아웃은 고정대로 통과한다",
      !verifyPin("db", target, { ...opts, cwd: repo }).problem,
    );
  } else {
    check("worktree 시험용 git 저장소를 만든다", false);
  }

  const realEnv = join(project, ".env");
  writeFileSync(
    realEnv,
    "DB_QUERY_SSH_HOST=testalias\nDB_QUERY_CONTAINER='app' # 주석\nLOG_QUERY_DIR=/srv/logs\n",
  );
  const values = readEnvValues(realEnv);
  check(
    ".env 값을 읽고 로그 설정은 DB 설정으로 채운다",
    dbTarget(values).container === "app" &&
      logTarget(values).host === "testalias" &&
      logTarget(values).dir === "/srv/logs",
  );
  const linkedEnv = join(other, ".env");
  symlinkSync(realEnv, linkedEnv);
  check(
    ".env가 심링크면 읽지 않는다",
    throwsWith(() => readEnvValues(linkedEnv), "심링크"),
  );

  const pin = spawnSync(process.execPath, [join(here, "query-pin.mjs")], {
    cwd: project,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  check(
    "query-pin은 터미널이 아니면 멈춘다",
    pin.status === 2 && pin.stderr.includes("터미널"),
    `${pin.status} ${pin.stderr.trim()}`,
  );

  // 호스트를 비운 로컬 모드라 고정 확인을 지나치면 이 컴퓨터에서 조회를 시작한다. 멈추는지만 본다.
  const local = join(base, "local");
  mkdirSync(local);
  writeFileSync(
    join(local, ".env"),
    "DB_QUERY_PATH=./x.db\nLOG_QUERY_CONTAINER=app\n",
  );
  const db = spawnSync(process.execPath, [join(here, "db-query.mjs")], {
    cwd: local,
    input: "SELECT 1",
    encoding: "utf8",
  });
  check(
    "db-query는 고정하지 않은 폴더에서 멈춘다",
    db.status === 2 && db.stdout === "" && /고정/.test(db.stderr),
    `${db.status} ${db.stderr.trim()}`,
  );
  const log = spawnSync(
    process.execPath,
    [join(here, "log-query.mjs"), "--since", "1h", "--grep", "x", "--count"],
    { cwd: local, encoding: "utf8" },
  );
  check(
    "log-query는 고정하지 않은 폴더에서 멈춘다",
    log.status === 2 && log.stdout === "" && /고정/.test(log.stderr),
    `${log.status} ${log.stderr.trim()}`,
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
process.exit(failed ? 1 : 0);
