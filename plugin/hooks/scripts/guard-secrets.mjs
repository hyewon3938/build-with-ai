#!/usr/bin/env node
// PreToolUse(Bash) secrets 노출 가드.
// 기존 settings.json 인라인 훅의 패턴을 1:1 이식 + 경로 변형 .env 덤프 탐지 보강.
// exit 2 = 차단 (stderr가 모델에게 전달), exit 0 = 통과. 파싱 실패 시 방해하지 않는다.
import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cmd = String(input?.tool_input?.command ?? "");
if (!cmd) process.exit(0);

// .env.example 은 placeholder 파일이라 허용 — 판정 전에 제거해 두고 검사한다.
const scrubbed = cmd.replaceAll(".env.example", "");
// 경로가 붙은 .env 참조 (.env, .env.local, .env.production ... / file.envelope 같은 오탐 제외)
const ENV_REF = /\.env(\.[A-Za-z0-9_-]+)?(?=$|[\s'";|&)])/;

const RULES = [
  {
    re: /(^|[\s;&|()`])(bash|sh|zsh)\s+-[a-zA-Z]*x[a-zA-Z]*(\s|$)/,
    msg: "셸 트레이스(-x) 실행 금지 — 스크립트가 .env를 소싱하면 모든 secrets가 trace로 출력된다. 사본에 echo를 주입해 디버깅할 것.",
  },
  {
    re: /(^|[\s;&|()`])set\s+-[a-zA-Z]*x\b/,
    msg: "set -x 금지 — secrets 소싱 이후 트레이스는 전체 값을 노출한다.",
  },
  {
    test: (c) => /(^|[;&|()`\s])(source\s+|\.\s+)\S*\.env(\s|$|;|&|\|)/.test(c),
    msg: ".env 소싱 감지 — env/printenv/set -x와 결합되면 전체 노출. 특정 변수만 필요하면 grep으로 값을 읽을 것.",
  },
  {
    re: /\bdocker\s+exec\s.+\s(env|printenv)(\s|$)/,
    msg: "컨테이너 환경변수 전체 덤프 금지. 특정 변수만: docker exec <c> printenv VAR",
  },
  {
    re: /\bkubectl\s+exec\s.+\s(env|printenv)(\s|$)/,
    msg: "파드 환경변수 전체 덤프 금지. 특정 변수만: kubectl exec <pod> -- printenv VAR",
  },
  {
    re: /\beval\s+\$\(\s*cat\s+[^)]*\.env/,
    msg: "eval $(cat .env) 패턴 금지 — 전체 값이 셸 히스토리·로그에 노출된다.",
  },
  {
    // 파이프라인 구간 단위로 판정 — 덤프 명령과 .env 참조가 같은 구간에 있을 때만 차단.
    // (cat settings.json | jq '.env' 처럼 jq 필터의 .env 필드 참조가 다른 구간에 있는 정당한 명령은 통과)
    test: () =>
      scrubbed
        .split(/[|;&\n]+/)
        .some(
          (seg) =>
            /(^|[\s;&|()`])(cat|head|tail|less|more|bat|strings)\s/.test(seg) &&
            ENV_REF.test(seg),
        ),
    msg: ".env 계열 파일 덤프 금지 (경로 포함 변형 감지). 특정 변수: grep '^KEY=' — 존재 확인: grep -c '^KEY=' <파일>",
  },
];

for (const r of RULES) {
  const hit = r.re ? r.re.test(cmd) : r.test(cmd);
  if (hit) {
    console.error(`⛔ secrets 가드: ${r.msg}`);
    console.error(`Command: ${cmd}`);
    console.error(
      "글로벌 보안 규칙 '민감 정보 노출 명령 금지' 참조. 의도된 작업이면 범위를 좁혀 다시 쓰거나 사용자가 직접 실행.",
    );
    process.exit(2);
  }
}
process.exit(0);
