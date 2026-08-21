/**
 * CHAT_HTML 안의 인라인 <script> 문법 검사.
 *
 * index.ts 의 UI 는 템플릿 리터럴 안에 들어 있어서, 클라이언트 JS 문자열에
 * '\n' 을 쓰면 TypeScript 가 그걸 실제 개행으로 바꿔버린다. 그러면 브라우저에서
 * "SyntaxError: Invalid or unexpected token" 이 나고 UI 전체가 죽는다.
 * (원본 코드가 buf.split('\n') 처럼 이중 이스케이프를 쓰는 이유다.)
 * 타입체크로는 절대 잡히지 않으므로 별도 검사가 필요하다.
 *
 * 사용: node scripts/check_inline_js.mjs [base_url]   (기본 http://127.0.0.1:8788)
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");

const html = await fetch(BASE + "/").then((r) => r.text());
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length === 0) {
  console.error("인라인 <script> 를 찾지 못했습니다.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "inlinejs-"));
let fail = 0;
scripts.forEach((code, i) => {
  const f = join(dir, `s${i}.js`);
  writeFileSync(f, code, "utf8");
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    console.log(`  ok   script[${i}]  ${code.split("\n").length}줄`);
  } catch (e) {
    fail++;
    console.log(`  FAIL script[${i}]`);
    console.log(String(e.stderr || e).split("\n").slice(0, 6).map((l) => "       " + l).join("\n"));
  }
});
console.log(fail ? `\n실패 ${fail}건` : "\n인라인 JS 문법 이상 없음");
process.exit(fail ? 1 : 0);
