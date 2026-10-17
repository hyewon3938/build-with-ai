#!/usr/bin/env node
// queue-read.mjs 회귀 테스트. queue-read.mjs를 고친 뒤 실행한다.
//
// 사용: node run-queue-read-tests.mjs
// 임시 폴더에 작은 대기열 파일을 만들어 명령마다 출력을 확인한다. 실제 대기열 파일은 읽지 않는다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "queue-read.mjs");
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `\n${detail}` : ""}`);
  }
}

const FIXTURE = `# 세션 대기열

## 일정

| 날짜 | 할 일 |
| --- | --- |
| 10/18 | A1 열기 |

## 지금

- **대기열 진행 방식.** 행은 순서대로 연다.
- **자율 진행.** 10/17 밤에 켰다.
  - 지금 계획: 줄 1은 A1 → A2.
    - 줄 1 세부
  - 지난 계획: 10/10 줄 표는 끝났다.
    - 지난 줄 세부
  - 아침에 확인할 것: 아직 없다.
- **사용자가 정해야 하는 일.** 없다.

## 남은 작업

- **할 일 X.** 다시 볼 날짜는 10/20.

## 배포 대기

| 세션 | 이슈 | PR | 머지한 날 | 배포 묶음 | 배포 때 할 일 |
| --- | --- | --- | --- | --- | --- |
| Z9 | #1 | #2 | 10/16 | 10/16 밤 | 없음 |

## 대기열

| 순서 | 세션 | 할 일 | 이슈 | 손댈 파일 | 선행 세션 | 여는 날짜와 이유 | 모델 | 배포 묶음 | 머지 전 확인 | 배포 뒤 확인 | 상태 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A0 | 고친다 | #10 | \`a.ts\` | 없음 | 10/17 | opus | 다음 | 없음 | 없음 | 진행 중 |
| 2 | A1 | 값 \\| 문구를 바꾼다 | #11 | \`b.ts\` | 없음 | 10/18 | sonnet | 다음 | 없음 | 없음 | 대기 |
| 3 | \`A2\` | 옮긴다 | #12 | \`c.ts\` | A1 머지 | 10/19 | opus | 다음 | 서하님 확인 | 없음 | 대기 |
| 4 | A3 | 확인한다 | #13 | \`d.ts\` | 없음 | 10/20 | opus | 다음 | 있음 | 없음 | 머지 전 확인. PR #20 |
`;

const NO_AUTO = FIXTURE.replace(
  /- \*\*자율 진행\.\*\*[\s\S]*?(?=- \*\*사용자가)/,
  "",
);

function run(file, ...args) {
  const r = spawnSync("node", [script, "--file", file, ...args], {
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const dir = mkdtempSync(join(tmpdir(), "queue-read-test-"));
try {
  const file = join(dir, "LOCAL-SESSIONS.md");
  const noAuto = join(dir, "no-auto.md");
  writeFileSync(file, FIXTURE);
  writeFileSync(noAuto, NO_AUTO);

  const outline = run(file, "--outline");
  check(
    "outline: 절 5개와 줄 범위",
    /## 일정 {2}3-8줄/.test(outline.out) &&
      /## 대기열 {2}\d+-\d+줄/.test(outline.out) &&
      (outline.out.match(/^## /gm) || []).length === 5,
    outline.out,
  );
  check(
    "outline: 지금 절 최상위 불릿 3개",
    (
      outline.out
        .split("## 남은 작업")[0]
        .split("## 지금")[1]
        .match(/^ {2}\d+-\d+줄 [\d.]+KB \S/gm) || []
    ).length === 3,
    outline.out,
  );
  check(
    "outline: 대기열 표 4행, 배포 대기 1행",
    /표 4행/.test(outline.out) && /표 1행/.test(outline.out),
    outline.out,
  );

  const section = run(file, "--section", "남은 작업");
  check(
    "section: 절 본문만",
    section.out.includes("할 일 X") && !section.out.includes("배포 대기"),
    section.out,
  );
  const noSection = run(file, "--section", "없는 절");
  check(
    "section: 없는 절은 종료 코드 1과 있는 절 목록",
    noSection.code === 1 && noSection.err.includes("일정"),
    noSection.err,
  );

  const lines = run(file, "--lines", "1-1");
  check("lines: 한 줄", lines.out.trim() === "# 세션 대기열", lines.out);

  const auto = run(file, "--auto");
  check(
    "auto: 첫 하위 불릿은 세부까지 전체",
    auto.out.includes("지금 계획") && auto.out.includes("줄 1 세부"),
    auto.out,
  );
  check(
    "auto: 나머지 하위 불릿은 첫머리와 줄 범위만",
    /\[\d+-\d+줄 [\d.]+KB\] 지난 계획/.test(auto.out) &&
      !auto.out.includes("지난 줄 세부") &&
      auto.out.includes("아침에 확인할 것"),
    auto.out,
  );
  check(
    "auto: 다른 최상위 불릿은 내지 않음",
    !auto.out.includes("사용자가 정해야"),
    auto.out,
  );
  const autoOff = run(noAuto, "--auto");
  check(
    "auto: 불릿이 없으면 꺼져 있다고 알림",
    autoOff.code === 0 && autoOff.out.includes("꺼져 있다"),
    autoOff.out,
  );

  const rows = run(file, "--rows");
  check(
    "rows: 행 4개",
    (rows.out.match(/^\d+줄 /gm) || []).length === 4,
    rows.out,
  );
  check(
    "rows: 모델과 상태 칸",
    rows.out.includes("2. A1 | 이슈 #11 | 모델 sonnet") &&
      rows.out.includes("상태 머지 전 확인. PR #20"),
    rows.out,
  );

  const row = run(file, "--row", "A1");
  check(
    "row: 이스케이프한 세로줄은 칸을 나누지 않음",
    row.out.includes("할 일: 값 \\| 문구를 바꾼다") &&
      row.out.includes("상태: 대기"),
    row.out,
  );
  const rowTick = run(file, "--row", "A2");
  check(
    "row: 백틱으로 감싼 세션 이름도 찾음",
    rowTick.out.includes("선행 세션: A1 머지"),
    rowTick.out,
  );
  const rowDeploy = run(file, "--row", "Z9");
  check(
    "row: 배포 대기 표에서도 찾음",
    rowDeploy.out.includes("[배포 대기") &&
      rowDeploy.out.includes("배포 때 할 일: 없음"),
    rowDeploy.out,
  );
  const rowNone = run(file, "--row", "없는행");
  check("row: 없으면 종료 코드 1", rowNone.code === 1, rowNone.err);

  const next = run(file, "--next");
  check(
    "next: 상태가 대기인 첫 행 전체",
    /^\[대기열 \d+줄\]\n순서: 2\n세션: A1/.test(next.out),
    next.out,
  );
  check(
    "next: 뒤 순서 대기 행의 선행과 파일",
    next.out.includes("[뒤 순서의 대기 행]") &&
      next.out.includes("A2` | 선행 A1 머지") &&
      next.out.includes("파일 `c.ts`"),
    next.out,
  );
  check(
    "next: 진행 중과 머지 전 확인 행",
    next.out.includes("A0: 진행 중") &&
      next.out.includes("A3: 머지 전 확인. PR #20"),
    next.out,
  );

  const noCmd = run(file);
  check("인자: 명령이 없으면 종료 코드 1", noCmd.code === 1, noCmd.err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed}개 실패`);
  process.exit(1);
}
console.log("\n전부 통과");
