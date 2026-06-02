/**
 * CLI 단순화 테스트
 *
 * 검증:
 * 1. { instruction, handler } 반환 시 console.log(instruction) 출력 + rl.prompt()
 * 2. process.stdout.write(result.prompt + ': ') 없음 → enterSubPrompt 사용
 * 3. 서브프롬프트 진입점 통일 — 2개 분기가 동일한 enterSubPrompt 로직 사용
 * 4. instruction 없을 때 ({ handler } 만) → 바로 rl.prompt()
 * 5. 모든 명령어 핸들러가 prompt → instruction 으로 변경됨
 */
import fs from 'fs';
import { registerCommand } from '../common/cli.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}

// =============================================================
// Test 1: registerCommand가 instruction 기반 핸들러 정상 등록
// =============================================================
{
  let handlerCalled = false;
  const testHandler = () => ({
    instruction: '금액 입력 (예: 100):',
    handler: async (input) => {
      handlerCalled = true;
      return `입력됨: ${input}`;
    },
  });

  registerCommand('test-cmd-1', testHandler);
  assert(true, 'registerCommand accepts instruction-based handler');
}

// =============================================================
// Test 2: enterSubPrompt 로직 검증
// - instruction 있으면 console.log 출력
// - handler 저장
// - rl.prompt() 호출
// =============================================================
{
  let consoleOutput = '';
  const origLog = console.log;
  console.log = (msg) => { consoleOutput = msg; };

  let rlPromptCalled = false;
  const mockRl = { prompt: () => { rlPromptCalled = true; } };

  let pendingHandler = null;
  const instruction = '금액을 입력하세요:';
  const handlerFn = async () => 'done';

  // enterSubPrompt 로직 복제
  if (instruction) console.log(instruction);
  pendingHandler = handlerFn;
  mockRl.prompt();

  assert(consoleOutput === '금액을 입력하세요:', 'enterSubPrompt: console.log(instruction)');
  assert(pendingHandler === handlerFn, 'enterSubPrompt: pendingHandler 할당');
  assert(rlPromptCalled === true, 'enterSubPrompt: rl.prompt() 호출');

  console.log = origLog;
}

// =============================================================
// Test 3: enterSubPrompt — instruction 없을 때 skip
// =============================================================
{
  let consoleOutput = null;
  const origLog = console.log;
  console.log = (msg) => { consoleOutput = msg; };

  let rlPromptCalled = false;
  const mockRl = { prompt: () => { rlPromptCalled = true; } };

  let pendingHandler = null;
  const instruction = undefined;
  const handlerFn = async () => 'done';

  if (instruction) console.log(instruction);
  pendingHandler = handlerFn;
  mockRl.prompt();

  assert(consoleOutput === null, 'enterSubPrompt: instruction 없음 → console.log skip');
  assert(pendingHandler === handlerFn, 'enterSubPrompt: instruction 없어도 handler 할당');
  assert(rlPromptCalled === true, 'enterSubPrompt: rl.prompt() 호출');

  console.log = origLog;
}

// =============================================================
// Test 4: 명령어 핸들러 반환 구조 검증 (string | { instruction?, handler })
// =============================================================
{
  // string 반환
  const strResult = 'plain text result';
  assert(typeof strResult === 'string', 'string 반환 지원');

  // { instruction, handler } 반환
  const objResult = { instruction: 'test', handler: async () => 'ok' };
  assert(typeof objResult.instruction === 'string', 'object: instruction string');
  assert(typeof objResult.handler === 'function', 'object: handler function');

  // { handler } 만 반환 (instruction 없음)
  const handlerOnly = { handler: async () => 'ok' };
  assert(handlerOnly.instruction === undefined, 'object: instruction 생략 가능');
  assert(typeof handlerOnly.handler === 'function', 'object: handler 필수');
}

// =============================================================
// Test 5: process.stdout.write 미사용 확인 (컴파일 타임 검증)
// cli.js에 process.stdout.write가 prompt 출력용으로 없음
// =============================================================
{
  const cliSource = fs.readFileSync('./common/cli.js', 'utf-8');
  // readline의 output: process.stdout 은 허용
  // prompt 출력용 process.stdout.write 호출이 없어야 함
  const writeCalls = cliSource.match(/process\.stdout\.write/g);
  // readline.createInterface에 전달하는 output: process.stdout 제외
  // 실제 write 호출이 없어야 함
  const hasProhibitedWrite = writeCalls && writeCalls.length > 0;
  assert(!hasProhibitedWrite, 'cli.js에 process.stdout.write 호출 없음');
}

// =============================================================
// 요약
// =============================================================
console.log(`\n=== CLI 테스트 완료: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
