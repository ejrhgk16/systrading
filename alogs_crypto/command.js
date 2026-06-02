import { registerCommand } from '../common/cli.js';

/**
 * Crypto 커맨드 등록 (ca3)
 * @param {object} strategies - { ca3: { BTCUSDT: algo3인스턴스, ETHUSDT: algo3인스턴스 } }
 */
export function registerCryptoCommands(strategies) {
  const ca3Objs = strategies.ca3;

  registerCommand('ca3', (subCmd) => {
    if (subCmd === 'status') {
      let msg = '=== algo3 상태 ===\n';
      for (const obj of Object.values(ca3Objs)) {
        msg += obj.getStatus() + '\n\n';
      }
      return msg;
    }

    if (subCmd === 'setstop') {
      return {
        instruction: '종목 종류 수량 가격 순서로 입력\n종류: atr_stop, exit1, exit2, exit3\n예) BTCUSDT atr_stop 0.054 82000:',
        handler: async (input) => {
          const [symbol, type, qtyStr, priceStr] = input.trim().split(/\s+/);
          if (!symbol || !type || !qtyStr || !priceStr) return '입력 형식 오류. 예) BTCUSDT atr_stop 0.054 82000';
          const obj = ca3Objs[symbol];
          if (!obj) return `알 수 없는 심볼: ${symbol}. (${Object.keys(ca3Objs).join(', ')})`;
          const qty   = parseFloat(qtyStr);
          const price = parseFloat(priceStr);
          if (isNaN(qty) || isNaN(price)) return '수량/가격이 유효하지 않습니다.';
          return await obj.setStop(type, qty, price);
        },
      };
    }

    if (subCmd === 'setstop2') {
      return {
        instruction: '심볼 방향 순서로 입력\n방향: long, short\n예) BTCUSDT long:',
        handler: async (input) => {
          const [symbol, side] = input.trim().split(/\s+/);
          if (!symbol || !side) return '입력 형식 오류. 예) BTCUSDT long';
          const obj = ca3Objs[symbol];
          if (!obj) return `알 수 없는 심볼: ${symbol}. (${Object.keys(ca3Objs).join(', ')})`;
          if (side !== 'long' && side !== 'short') return '방향은 long 또는 short 이어야 합니다.';
          return await obj.setStop2(side);
        },
      };
    }

    return `ca3 [status|setstop|setstop2]`;
  });
}
