import { fetchTodayOpenPrices, buildNetSummary } from './tradifi_utils.js';
import { registerCommand } from '../common/cli.js';

/**
 * Tradifi 커맨드 등록 (ta / ta2 / qg / ta3)
 * @param {object} strategies - { ta2: Algo2QqqGld, ta3: Algo3MeanReversionQqq }
 */
export function registerTradifiCommands(strategies) {

  // ── ta (통합) ─────────────────────────────────────────────────
  registerCommand('ta', (subCmd) => {
    if (subCmd === 'status')  return cmdTaStatus(strategies);
    if (subCmd === 'pending') return cmdTaPending(strategies);
    if (subCmd === 'confirm') return cmdTaConfirm(strategies);
    return 'ta [status|pending|confirm]';
  });

  // ── ta2 / qg (QQQ+GLD 트렌치) ────────────────────────────────
  const ta2 = strategies.ta2;
  const ta2Handler = (subCmd, args) => {
    if (subCmd === 'status') return ta2._cmdStatus(args);
    if (subCmd === 'init')   return ta2._cmdInit();
    if (subCmd === 'add')    return ta2._cmdAdd();
    if (subCmd === 'sub')    return ta2._cmdSub();
    if (subCmd === 'run')    return ta2._cmdRun();
    if (subCmd === 'check')  return ta2._cmdCheck();
    return 'ta2 [status|init|add|sub|run|check]';
  };
  registerCommand('ta2', ta2Handler);
  registerCommand('qg',  ta2Handler);

  // ── ta3 (QQQ 역추세 BB) ───────────────────────────────────────
  const ta3 = strategies.ta3;
  registerCommand('ta3', (subCmd) => {
    if (subCmd === 'status') return ta3._cmdStatus();
    if (subCmd === 'init')   return ta3._cmdInit();
    if (subCmd === 'add')    return ta3._cmdAdd();
    if (subCmd === 'sub')    return ta3._cmdSub();
    if (subCmd === 'run')    return ta3._cmdRun();
    return 'ta3 [status|init|add|sub|run]';
  });
}

// ─── ta 서브커맨드 구현 ──────────────────────────────────────────

function cmdTaStatus(strategies) {
  let msg = '=== Tradifi 전략 현황 ===\n\n';
  for (const [name, s] of Object.entries(strategies)) {
    msg += `[${name}] ${s.name}\n`;
    msg += s.getStatusSummary();
    msg += '\n';
  }
  return msg;
}

function cmdTaPending(strategies) {
  const allActions = collectAllActions(strategies);
  if (allActions.length === 0) return '대기 액션 없음';

  let msg = '=== Tradifi 대기 액션 ===\n\n';
  for (const [name, s] of Object.entries(strategies)) {
    if (s.pendingActions.length === 0) continue;
    msg += `[${name}]\n`;
    s.pendingActions.forEach((a) => {
      const kr     = a.action === 'buy' ? '매수' : '매도';
      const prefix = a.tranche_num ? `트렌치#${a.tranche_num} ` : '';
      msg += `  ${prefix}${a.ticker} ${kr} ${a.shares}주 @ ~$${a.price.toFixed(2)} (${a.reason})\n`;
    });
    msg += '\n';
  }
  msg += buildNetSummary(allActions);
  return msg;
}

function cmdTaConfirm(strategies) {
  const allActions = collectAllActions(strategies);
  if (allActions.length === 0) return '대기 액션 없음';

  let prompt = '=== 대기 액션 ===\n';
  allActions.forEach((a, i) => {
    const kr     = a.action === 'buy' ? '매수' : '매도';
    const prefix = a.tranche_num ? `[${a.source} 트렌치#${a.tranche_num}]` : `[${a.source}]`;
    prompt += `  #${i + 1} ${prefix} ${a.ticker} ${kr} ${a.shares}주 @ ~$${a.price.toFixed(2)}\n`;
  });
  prompt += '\n' + buildNetSummary(allActions);
  prompt += '\n번호 체결가 / all / all open 입력';

  return {
    prompt,
    handler: async (input) => {
      const trimmed = input.trim();

      // all open: 오늘 시가 조회 후 전체 체결
      if (trimmed === 'all open') {
        const tickers = [...new Set(allActions.map(a => a.ticker))];
        const prices  = await fetchTodayOpenPrices(tickers);
        const results = [];
        for (const a of allActions) {
          const p = prices[a.ticker];
          if (!p) { results.push(`[스킵] ${a.ticker} 시가 조회 실패`); continue; }
          results.push(await a.strategy._applyAction(a, p));
        }
        for (const s of Object.values(strategies)) await clearStrategyPending(s);
        return results.join('\n') + `\n=== ${results.length}건 시가 체결 완료 ===`;
      }

      // all: 추천가 그대로 전체 체결
      if (trimmed === 'all') {
        const results = [];
        for (const a of allActions) {
          results.push(await a.strategy._applyAction(a, a.price));
        }
        for (const s of Object.values(strategies)) await clearStrategyPending(s);
        return results.join('\n') + `\n=== ${results.length}건 체결 완료 ===`;
      }

      // 개별: "번호 체결가"
      const parts = trimmed.split(/\s+/);
      const idx   = parseInt(parts[0]) - 1;
      if (isNaN(idx) || idx < 0 || idx >= allActions.length) {
        return `번호 입력 (1~${allActions.length})`;
      }
      const action = allActions[idx];
      const price  = parts[1] ? parseFloat(parts[1]) : action.price;
      if (isNaN(price) || price <= 0) return '체결가 입력 필요 (예: 1 79.50)';

      const result = await action.strategy._applyAction(action, price);
      await removeStrategyPendingAction(action.strategy, action._original);
      return result;
    },
  };
}

// ─── 유틸 ─────────────────────────────────────────────────────

/** 모든 전략의 pendingActions를 source 태깅해서 합침 */
function collectAllActions(strategies) {
  const all = [];
  for (const [name, s] of Object.entries(strategies)) {
    for (const a of s.pendingActions) {
      all.push({ ...a, source: name, strategy: s, _original: a });
    }
  }
  return all;
}

async function clearStrategyPending(strategy) {
  if (typeof strategy.clearPendingActions === 'function') {
    await strategy.clearPendingActions();
    return;
  }
  strategy.pendingActions = [];
}

async function removeStrategyPendingAction(strategy, action) {
  if (typeof strategy.removePendingAction === 'function') {
    await strategy.removePendingAction(action);
    return;
  }

  const srcIdx = strategy.pendingActions.indexOf(action);
  if (srcIdx >= 0) strategy.pendingActions.splice(srcIdx, 1);
}
