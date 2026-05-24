import readline from 'readline';
import { consoleLogger } from './logger.js';

const commands = {};
let pendingHandler = null;  // 서브 프롬프트 대기 핸들러

export function registerCommand(name, handler) {
  commands[name] = handler;
}

/**
 * CLI 초기화 — 전략 맵을 받아 커맨드 등록 + readline 시작
 *
 * @param {object} strategyMap - { tradifi: { ta2, ta3 }, crypto: { ca3: {...} } }
 * @param {object} cronTasks   - { '4h': task, 'daily': task }
 *
 * handleCommand 반환값:
 *   - string → 바로 출력
 *   - { prompt: string, handler: async (input) => string } → 서브 프롬프트 진입
 */
export function initCLI(strategyMap, cronTasks = {}) {
  registerCommand('help', () => {
    let msg = '=== 사용 가능한 커맨드 ===\n';
    msg += '  help                           — 도움말\n';
    msg += '  clear                          — 화면 지우기\n';
    msg += '  status                         — 전체 전략 상태\n';
    msg += '  cron                           — cron 상태 확인\n';
    msg += '\n--- 명명규칙: ta=tradifi, ca=crypto, 숫자=algo번호 ---\n';
    msg += '--- ca3: crypto algo3 (BTC/ETH BB+ADX)\n';
    msg += '--- ta2 (= qg): tradifi algo2 (QQQ+GLD 트렌치)\n';
    msg += '--- ta3: tradifi algo3 (QQQ 역추세 BB)\n';
    msg += '\n--- 통합 tradifi (ta) ---\n';
    msg += '  ta status                      — 전체 tradifi 현황\n';
    msg += '  ta pending                     — 전체 대기 액션\n';
    msg += '  ta confirm                     — 통합 체결 확인\n';
    msg += '\n--- crypto algo3 (ca3) ---\n';
    msg += '  ca3 status                     — algo3 전체 상태\n';
    msg += '  ca3 setstop                    — stop 강제 설정 (수동)\n';
    msg += '  ca3 setstop2                   — stop 자동 계산 설정 (long/short)\n';
    msg += '\n--- QQQ+GLD 트렌치 (ta2 또는 qg) ---\n';
    msg += '  ta2 status [트렌치번호]         — 포트폴리오 현황\n';
    msg += '  ta2 init                       — 초기 포트폴리오 세팅\n';
    msg += '  ta2 add                        — 현금 추가 투입\n';
    msg += '  ta2 sub                        — 현금 인출\n';
    msg += '  ta2 run                        — 강제 실행\n';
    msg += '  ta2 check                      — pending 재계산\n';
    msg += '  ta2 clear                      — pending 초기화\n';
    msg += '  ta2 adjust                     — 트렌치별 수동 체결 조정\n';
    msg += '\n--- QQQ 역추세 BB (ta3) ---\n';
    msg += '  ta3 status                     — 포지션/지표 현황\n';
    msg += '  ta3 init                       — 초기 자본 세팅\n';
    msg += '  ta3 add                        — 현금 추가\n';
    msg += '  ta3 sub                        — 현금 인출\n';
    msg += '  ta3 run                        — 강제 실행\n';
    return msg;
  });

  registerCommand('cron', () => {
    let msg = '=== CRON 상태 ===\n';
    for (const [name, task] of Object.entries(cronTasks)) {
      msg += `  ${name}: status=${task.getStatus()}, nextRun=${task.getNextRun()}\n`;
    }
    return msg;
  });

  registerCommand('clear', () => {
    console.clear();
  });

  registerCommand('status', () => {
    let msg = '=== 전략 상태 ===\n';
    msg += '[tradifi]\n';
    for (const [name] of Object.entries(strategyMap.tradifi || {})) {
      msg += `  ${name}: 등록됨\n`;
    }
    msg += '[crypto]\n';
    for (const [name] of Object.entries(strategyMap.crypto || {})) {
      msg += `  ${name}: 등록됨\n`;
    }
    return msg;
  });

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

    const parts   = trimmed.split(/\s+/);
    const cmdName = parts[0];
    const subCmd  = parts[1] || '';
    const args    = parts.slice(2);

    const cmd = commands[cmdName];
    if (!cmd) {
      console.log(`알 수 없는 커맨드: ${cmdName}. 'help' 입력으로 확인.`);
      rl.prompt();
      return;
    }

    try {
      const result = await cmd(subCmd, args);
      if (result && typeof result === 'object' && result.prompt) {
        // 서브 프롬프트 요청
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
