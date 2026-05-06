import { getCandles_yahoo } from '../common/util.js';

/**
 * 오늘 시가 일괄 조회 (ta confirm all open 용)
 * @param {string[]} tickers
 * @returns {Promise<{[ticker]: number}>}
 */
export async function fetchTodayOpenPrices(tickers) {
  const prices = {};
  await Promise.all(tickers.map(async (ticker) => {
    const candles = await getCandles_yahoo(ticker, 5);
    if (candles.length > 0) prices[ticker] = candles[candles.length - 1][1]; // open
  }));
  return prices;
}

/**
 * 전략별 액션 합산 요약 문자열 생성
 * @param {Array} allActions - { ticker, action, shares } 형식
 * @returns {string}
 */
export function buildNetSummary(allActions) {
  if (!allActions || allActions.length === 0) return '';

  const net = {};
  for (const a of allActions) {
    if (!net[a.ticker]) net[a.ticker] = { buy: 0, sell: 0 };
    if (a.action === 'buy') net[a.ticker].buy += a.shares;
    else net[a.ticker].sell += a.shares;
  }

  let msg = '=== 합산 (실제 브로커 체결량) ===\n';
  for (const [ticker, v] of Object.entries(net)) {
    const delta = v.buy - v.sell;
    if (v.buy > 0 && v.sell > 0) {
      msg += `  ${ticker}: 매수 ${v.buy}주 + 매도 ${v.sell}주`;
      if (delta > 0)      msg += ` → 순매수 ${delta}주\n`;
      else if (delta < 0) msg += ` → 순매도 ${Math.abs(delta)}주\n`;
      else                msg += ` → 완전 상쇄\n`;
    } else if (v.buy > 0) {
      msg += `  ${ticker}: 매수 ${v.buy}주\n`;
    } else {
      msg += `  ${ticker}: 매도 ${v.sell}주\n`;
    }
  }
  return msg;
}
