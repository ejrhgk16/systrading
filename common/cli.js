import readline from 'readline';
import { consoleLogger } from './logger.js';

const commands = {};
let pendingHandler = null;  // 서브 프롬프트 대기 핸들러

function registerCommand(name, handler) {
  commands[name] = handler;
}

/**
 * CLI 초기화 — 전략 인스턴스 맵을 받아 커맨드 등록 + readline 시작
 *
 * handleCommand 반환값:
 *   - string → 바로 출력
 *   - { prompt: string, handler: async (input) => string } → 서브 프롬프트 진입
 */
export function initCLI(strategyMap) {
  registerCommand('help', () => {
    let msg = '=== 사용 가능한 커맨드 ===\n';
    msg += '  help                           — 도움말\n';
    msg += '  clear                          — 화면 지우기\n';
    msg += '  status                         — 전체 전략 상태\n';
    msg += '\n--- 명명규칙: ta=tradifi, ca=crypto, 숫자=algo번호 ---\n';
    msg += '--- ca3: crypto algo3 (BTC/ETH BB+ADX)\n';
    msg += '--- ta2 (= qg): tradifi algo2 (QQQ+GLD 트렌치)\n';
    msg += '\n--- QQQ+GLD 트렌치 (ta2 또는 qg) ---\n';
    msg += '  ta2 status [트렌치번호]         — 포트폴리오 현황\n';
    msg += '  ta2 pending                    — 대기 액션 목록\n';
    msg += '  ta2 confirm                    — 체결 확인\n';
    msg += '  ta2 init                       — 초기 포트폴리오 세팅\n';
    msg += '  ta2 add                        — 현금 추가 투입\n';
    msg += '  ta2 sub                        — 현금 인출\n';
    msg += '  ta2 run                        — 강제 실행 (리밸런싱 포함)\n';
    return msg;
  });

  registerCommand('clear', () => {
    console.clear();
  });

  registerCommand('status', () => {
    let msg = '=== 전략 상태 ===\n';
    for (const [name] of Object.entries(strategyMap)) {
      msg += `  ${name}: 등록됨\n`;
    }
    return msg;
  });

  for (const [name, inst] of Object.entries(strategyMap)) {
    if (typeof inst.handleCommand === 'function') {
      registerCommand(name, (subCmd, args) => inst.handleCommand(subCmd, args));
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log(commands['help']());
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // 서브 프롬프트 대기 중이면 해당 핸들러로 전달
    if (pendingHandler) {
      const handler = pendingHandler;
      pendingHandler = null;
      try {
        const result = await handler(trimmed);
        if (result) console.log(result);
      } catch (err) {
        consoleLogger.error('서브 프롬프트 실행 오류:', err);
      }
      rl.prompt();
      return;
    }

    const parts = trimmed.split(/\s+/);
    const cmdName = parts[0];
    const subCmd = parts[1] || '';
    const args = parts.slice(2);

    const cmd = commands[cmdName];
    if (!cmd) {
      console.log(`알 수 없는 커맨드: ${cmdName}. 'help' 입력으로 확인.`);
      rl.prompt();
      return;
    }

    try {
      const result = await cmd(subCmd, args);
      if (result && typeof result === 'object' && result.prompt) {
        // 서브 프롬프트 요청 — 마지막 줄 옆에 ': ' 붙여 바로 입력
        process.stdout.write(result.prompt + ': ');
        pendingHandler = result.handler;
        return;
      } else if (result) {
        console.log(result);
      }
    } catch (err) {
      consoleLogger.error(`커맨드 실행 오류 (${cmdName}):`, err);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    consoleLogger.info('CLI 종료');
  });
}
