#!/usr/bin/env node
// .env 파일에 변수가 있는지만 알려 준다. 값은 어떤 형태로도 출력하지 않는다.
//
// 사용: node env-has.mjs KEY [KEY...] [--file <경로>]
// 파일을 지정하지 않으면 현재 폴더의 .env를 읽는다. 변수마다 `KEY 있음` 또는 `KEY 없음`을 한 줄씩
// 출력하고, 값이 비어 있으면 없음으로 센다. 같은 이름이 여러 번 나오면 마지막 줄을 따른다.
// 종료 코드는 모두 있으면 0, 하나라도 없으면 1, 사용법이나 파일 읽기 오류는 2다.
import { readFileSync } from "node:fs";

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const args = process.argv.slice(2);
let file = ".env";
const keys = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file") {
    file = args[++i];
    continue;
  }
  keys.push(args[i]);
}

if (!file || keys.length === 0 || keys.some((k) => !KEY_NAME.test(k))) {
  console.error(
    "사용: node env-has.mjs KEY [KEY...] [--file <경로>] — KEY는 영문자·숫자·밑줄만",
  );
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  // 오류 객체를 통째로 찍지 않는다. 코드만 알린다.
  console.error(`env 파일을 읽지 못했다: ${err?.code ?? "unknown"}`);
  process.exit(2);
}

const present = new Map();
for (const line of text.split(/\r?\n/)) {
  const m = ASSIGN.exec(line);
  if (!m) continue;
  const raw = m[2].trim();
  const empty =
    raw === "" || raw === '""' || raw === "''" || raw.startsWith("#");
  present.set(m[1], !empty);
}

let missing = 0;
for (const key of keys) {
  const has = present.get(key) === true;
  if (!has) missing++;
  console.log(`${key} ${has ? "있음" : "없음"}`);
}
process.exit(missing === 0 ? 0 : 1);
