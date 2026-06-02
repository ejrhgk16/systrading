// @ts-check
// _cmdStatus() unit tests — tests weights, rebal info, pending warning enhancements
// Firestore calls may fail silently if unauthenticated; tests still verify in-memory behavior.

import { Algo2QqqGld } from '../alogs_tradifi/algo2Class_qqq_gld.js';
import { Tranche } from '../alogs_tradifi/algo2Class_tranche.js';

// ─── Helpers ──────────────────────────────────────────────────

/** Create a minimal algo instance with controlled state for _cmdStatus testing */
function makeAlgo(overrides = {}) {
  const algo = new Algo2QqqGld();
  // Clear tranches and set a minimal one so the output has predictable length
  algo.tranches = [];
  algo.weights = overrides.weights ?? [0.35, 0.35, 0.30];
  algo.lastRebalDate = overrides.lastRebalDate ?? null;
  algo.lastRebalTrancheNum = overrides.lastRebalTrancheNum ?? null;
  algo.pendingActions = overrides.pendingActions ?? [];
  algo.tip_state = overrides.tip_state ?? 'normal';
  algo.vix_ts_state = overrides.vix_ts_state ?? 0;
  algo.qqq_mom_state = overrides.qqq_mom_state ?? 'normal';
  algo.gld_mom_state = overrides.gld_mom_state ?? 'normal';
  algo.lastSignals = overrides.lastSignals ?? null;
  return algo;
}

// ─── Test 1: weights line appears in output ───────────────────

function testCmdStatusWeightsDisplay() {
  const algo = makeAlgo({ weights: [0.35, 0.35, 0.30] });
  const out = algo._cmdStatus([]);

  // Should contain the weights line with exact format
  const expected = '가중치: TQQQ 35% / UGL 35% / CTA 30%';
  if (!out.includes(expected)) {
    console.error(`FAIL testCmdStatusWeightsDisplay:\n  expected to include: "${expected}"\n  got:\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusWeightsDisplay: weights line found`);
  return true;
}

// ─── Test 2: rebal info appears when present ──────────────────

function testCmdStatusRebalInfo() {
  const algo = makeAlgo({
    weights: [0.35, 0.35, 0.30],
    lastRebalDate: '2026-05-21',
    lastRebalTrancheNum: 2,
  });
  const out = algo._cmdStatus([]);

  const expected = '마지막 리밸런싱: 트렌치 #2 (2026-05-21)';
  if (!out.includes(expected)) {
    console.error(`FAIL testCmdStatusRebalInfo:\n  expected to include: "${expected}"\n  got:\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusRebalInfo: rebal info line found`);
  return true;
}

// ─── Test 3: "없음" when no rebal info ────────────────────────

function testCmdStatusNoRebal() {
  const algo = makeAlgo({
    weights: [0.35, 0.35, 0.30],
    lastRebalDate: null,
    lastRebalTrancheNum: null,
  });
  const out = algo._cmdStatus([]);

  const expected = '마지막 리밸런싱: 없음';
  if (!out.includes(expected)) {
    console.error(`FAIL testCmdStatusNoRebal:\n  expected to include: "${expected}"\n  got:\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusNoRebal: "마지막 리밸런싱: 없음" found`);
  return true;
}

// ─── Test 4: pending warning appears when actions present ─────

function testCmdStatusPendingWarning() {
  const algo = makeAlgo({
    weights: [0.35, 0.35, 0.30],
    lastRebalDate: '2026-05-21',
    lastRebalTrancheNum: 2,
    pendingActions: [{ action: 'buy', ticker: 'TQQQ', shares: 10 }],
  });
  const out = algo._cmdStatus([]);

  const expected = '⚠️ 대기 중인 미체결 액션 1건 (confirm 필요)';
  if (!out.includes(expected)) {
    console.error(`FAIL testCmdStatusPendingWarning:\n  expected to include: "${expected}"\n  got:\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusPendingWarning: pending warning found (1건)`);
  return true;
}

// ─── Test 5: no pending warning when actions empty ────────────

function testCmdStatusNoPending() {
  const algo = makeAlgo({
    weights: [0.35, 0.35, 0.30],
    lastRebalDate: '2026-05-21',
    lastRebalTrancheNum: 2,
    pendingActions: [],
  });
  const out = algo._cmdStatus([]);

  // Should NOT contain the warning text
  const unexpected = '대기 중인 미체결 액션';
  if (out.includes(unexpected)) {
    console.error(`FAIL testCmdStatusNoPending:\n  should NOT contain "${unexpected}" but found it\n  got:\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusNoPending: no pending warning when empty`);
  return true;
}

// ─── Test 6: pending warning shows correct count ──────────────

function testCmdStatusPendingCount() {
  const algo = makeAlgo({
    weights: [0.35, 0.35, 0.30],
    lastRebalDate: '2026-05-21',
    lastRebalTrancheNum: 2,
    pendingActions: [
      { action: 'buy', ticker: 'TQQQ', shares: 10 },
      { action: 'sell', ticker: 'UGL', shares: 5 },
      { action: 'buy', ticker: 'CTA', shares: 20 },
    ],
  });
  const out = algo._cmdStatus([]);

  const expected = '⚠️ 대기 중인 미체결 액션 3건 (confirm 필요)';
  if (!out.includes(expected)) {
    console.error(`FAIL testCmdStatusPendingCount:\n  expected to include: "${expected}"\n  got:\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusPendingCount: pending warning shows 3건`);
  return true;
}

// ─── Test 7: order of sections (weights before rebal, before signals, pending last) ──

function testCmdStatusSectionOrder() {
  const algo = makeAlgo({
    weights: [0.35, 0.35, 0.30],
    lastRebalDate: '2026-05-21',
    lastRebalTrancheNum: 2,
    pendingActions: [{ action: 'buy', ticker: 'TQQQ', shares: 10 }],
    lastSignals: { date: '2026-05-24', tip_avg_ret: 0.01, qqq_mom_avg: 0.02, gld_mom_avg: 0.015, cta_mom_avg: 0.005, qqq_lv_price: 50, gld_lv_price: 30, cta_price: 25 },
  });
  const out = algo._cmdStatus([]);

  // Weights should appear after "필터 상태:" and before "시그널"
  const filterIdx = out.indexOf('필터 상태');
  const weightsIdx = out.indexOf('가중치:');
  if (weightsIdx === -1) {
    console.error(`FAIL testCmdStatusSectionOrder: weights line not found`);
    return false;
  }
  if (weightsIdx < filterIdx) {
    console.error(`FAIL testCmdStatusSectionOrder: weights line should appear AFTER filter status`);
    return false;
  }

  // Rebal info should appear after weights
  const weightsIdx2 = out.indexOf('가중치:');
  const rebalIdx = out.indexOf('마지막 리밸런싱:');
  if (rebalIdx < weightsIdx2) {
    console.error(`FAIL testCmdStatusSectionOrder: rebal info should appear AFTER weights`);
    return false;
  }

  // Pending warning should appear after "시그널"
  const signalIdx = out.indexOf('시그널');
  const pendingIdx = out.indexOf('대기 중인 미체결 액션');
  if (pendingIdx === -1) {
    console.error(`FAIL testCmdStatusSectionOrder: pending warning not found`);
    return false;
  }
  if (pendingIdx < signalIdx) {
    console.error(`FAIL testCmdStatusSectionOrder: pending warning should appear AFTER signals`);
    return false;
  }

  console.log(`PASS testCmdStatusSectionOrder: section order correct (filter<weights<rebal, pending>signal)`);
  return true;
}

// ─── Test 8: _cmdAdjust does not corrupt equity to cash-only ──

async function testCmdAdjustDoesNotCorruptEquity() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  // Need 4 tranches for _cmdAdjust's guard check
  const tranches = [1, 2, 3, 4].map(i => new Tranche(i, 10000, T1, T2, T3));
  const t = tranches[0];
  t.shares[T1] = 100;
  t.avg_price[T1] = 70;
  t.updateEquity({ [T1]: 72.50, [T2]: 0, [T3]: 0 });
  algo.tranches = tranches;

  const cashBefore = t.cash; // 10000
  const equityWithPositions = t.equity; // 10000 + 100*72.50 = 17250

  const cmd = algo._cmdAdjust();
  await cmd.handler('1 TQQQ buy 10 72.50');

  // After buy: cash = 10000 - 725 = 9275
  // Bug (old code): equity = cash = 9275 (updateEquity with bad args zeroes positions)
  // Fix (new code): equity stays at ~17250 (stale cache, not corrupted)
  if (t.equity === t.cash) {
    console.error(`FAIL testCmdAdjustDoesNotCorruptEquity: equity corrupted to cash only (eq=${t.equity}, cash=${t.cash})`);
    return false;
  }
  // Verify equity is still >= old equity minus some (buy reduces cash but equity cache not updated immediately)
  if (t.equity < cashBefore) {
    console.error(`FAIL testCmdAdjustDoesNotCorruptEquity: equity dropped below starting cash (eq=${t.equity}, cash=${t.cash})`);
    return false;
  }
  console.log(`PASS testCmdAdjustDoesNotCorruptEquity: equity=${t.equity} not corrupted to cash=${t.cash}`);
  return true;
}

// ─── Test 9: _cmdStatus shows current price per ticker ────────

function testCmdStatusShowsTickerCurrentPrice() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  const t = new Tranche(1, 5000, T1, T2, T3);
  t.shares[T1] = 200;
  t.avg_price[T1] = 70;
  t.shares[T2] = 300;
  t.avg_price[T2] = 25;
  t.shares[T3] = 500;
  t.avg_price[T3] = 32;
  t.updateEquity({ [T1]: 72.50, [T2]: 25.80, [T3]: 32.50 });
  algo.tranches = [t];
  algo.weights = [0.40, 0.40, 0.20];
  algo.lastSignals = {
    qqq_lv_price: 72.50,
    gld_lv_price: 25.80,
    cta_price: 32.50,
    date: '2026-06-03',
  };

  const out = algo._cmdStatus([]);

  if (!out.includes('현재 $72.50') || !out.includes('현재 $25.80') || !out.includes('현재 $32.50')) {
    console.error(`FAIL testCmdStatusShowsTickerCurrentPrice: missing current price in output\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusShowsTickerCurrentPrice: current prices found`);
  return true;
}

// ─── Test 10: _cmdStatus shows position value per ticker ──────

function testCmdStatusShowsPosValue() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  const t = new Tranche(1, 5000, T1, T2, T3);
  t.shares[T1] = 200;
  t.avg_price[T1] = 70;
  t.shares[T2] = 300;
  t.avg_price[T2] = 25;
  t.shares[T3] = 500;
  t.avg_price[T3] = 32;
  t.updateEquity({ [T1]: 72.50, [T2]: 25.80, [T3]: 32.50 });
  algo.tranches = [t];
  algo.weights = [0.40, 0.40, 0.20];
  algo.lastSignals = {
    qqq_lv_price: 72.50,
    gld_lv_price: 25.80,
    cta_price: 32.50,
    date: '2026-06-03',
  };

  const out = algo._cmdStatus([]);

  // Position values: TQQQ 200*72.50=14500, UGL 300*25.80=7740, CTA 500*32.50=16250
  if (!out.includes('= $14500') || !out.includes('= $7740') || !out.includes('= $16250')) {
    console.error(`FAIL testCmdStatusShowsPosValue: missing position value in output\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusShowsPosValue: position values found`);
  return true;
}

// ─── Test 11: _cmdStatus shows unrealized PnL per ticker ──────

function testCmdStatusShowsUnrealizedPnl() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  const t = new Tranche(1, 5000, T1, T2, T3);
  t.shares[T1] = 200;
  t.avg_price[T1] = 70;
  t.shares[T2] = 300;
  t.avg_price[T2] = 25;
  t.shares[T3] = 500;
  t.avg_price[T3] = 32;
  t.updateEquity({ [T1]: 72.50, [T2]: 25.80, [T3]: 32.50 });
  algo.tranches = [t];
  algo.weights = [0.40, 0.40, 0.20];
  algo.lastSignals = {
    qqq_lv_price: 72.50,
    gld_lv_price: 25.80,
    cta_price: 32.50,
    date: '2026-06-03',
  };

  const out = algo._cmdStatus([]);

  // PnL: TQQQ (72.50-70)*200=+500, UGL (25.80-25)*300=+240, CTA (32.50-32)*500=+250
  if (!out.includes('(+$500)') || !out.includes('(+$240)') || !out.includes('(+$250)')) {
    console.error(`FAIL testCmdStatusShowsUnrealizedPnl: missing PnL in output\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusShowsUnrealizedPnl: PnL values found`);
  return true;
}

// ─── Test 12: _cmdStatus summary includes total PnL ───────────

function testCmdStatusTotalPnl() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  const t = new Tranche(1, 5000, T1, T2, T3);
  t.shares[T1] = 200;
  t.avg_price[T1] = 70;
  t.shares[T2] = 300;
  t.avg_price[T2] = 25;
  t.shares[T3] = 500;
  t.avg_price[T3] = 32;
  t.updateEquity({ [T1]: 72.50, [T2]: 25.80, [T3]: 32.50 });
  algo.tranches = [t];
  algo.weights = [0.40, 0.40, 0.20];
  algo.lastSignals = {
    qqq_lv_price: 72.50,
    gld_lv_price: 25.80,
    cta_price: 32.50,
    date: '2026-06-03',
  };

  const out = algo._cmdStatus([]);

  // Total PnL = 500 + 240 + 250 = +$990
  if (!out.includes('평가손익 +$990')) {
    console.error(`FAIL testCmdStatusTotalPnl: expected 평가손익 +$990 in output\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusTotalPnl: total PnL found`);
  return true;
}

// ─── Test 13: _cmdStatus individual tranche mode shows detail ──

function testCmdStatusIndividualTrancheDetail() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  const t = new Tranche(1, 5000, T1, T2, T3);
  t.shares[T1] = 200;
  t.avg_price[T1] = 70;
  t.updateEquity({ [T1]: 72.50, [T2]: 0, [T3]: 0 });
  algo.tranches = [t];
  algo.lastSignals = {
    qqq_lv_price: 72.50,
    gld_lv_price: 25.80,
    cta_price: 32.50,
    date: '2026-06-03',
  };

  const out = algo._cmdStatus(['1']);

  if (!out.includes('현재 $72.50') || !out.includes('(+$500)')) {
    console.error(`FAIL testCmdStatusIndividualTrancheDetail: missing detail in individual mode\n${out}`);
    return false;
  }
  console.log(`PASS testCmdStatusIndividualTrancheDetail: individual mode shows detail`);
  return true;
}

// ─── Test 14: getStatusSummary refreshes equity from lastSignals

function testGetStatusSummaryRefreshesEquity() {
  const algo = new Algo2QqqGld();
  const T1 = Algo2QqqGld.TICKER_QQQ_LV;
  const T2 = Algo2QqqGld.TICKER_GLD_LV;
  const T3 = Algo2QqqGld.TICKER_CTA_LV;

  const t = new Tranche(1, 10000, T1, T2, T3);
  t.shares[T1] = 100;
  t.avg_price[T1] = 70;
  // No updateEquity called — equity still at initial value 10000
  algo.tranches = [t];
  algo.lastSignals = {
    qqq_lv_price: 72.50,
    gld_lv_price: 0,
    cta_price: 0,
    date: '2026-06-03',
  };
  algo.weights = [0.40, 0.40, 0.20];
  algo.tip_state = 'normal';
  algo.vix_ts_state = 0;
  algo.qqq_mom_state = 'normal';
  algo.gld_mom_state = 'normal';

  const summary = algo.getStatusSummary();

  // After refresh: equity = 10000 + 100*72.50 = 17250
  if (!summary.includes('17250')) {
    console.error(`FAIL testGetStatusSummaryRefreshesEquity: expected 17250 in summary\n${summary}`);
    return false;
  }
  console.log(`PASS testGetStatusSummaryRefreshesEquity: equity refreshed`);
  return true;
}

// ─── Run all tests ─────────────────────────────────────────────
async function main() {
  const results = [];
  results.push({ name: 'cmdStatus: weights display', pass: testCmdStatusWeightsDisplay() });
  results.push({ name: 'cmdStatus: rebal info when present', pass: testCmdStatusRebalInfo() });
  results.push({ name: 'cmdStatus: "없음" when no rebal', pass: testCmdStatusNoRebal() });
  results.push({ name: 'cmdStatus: pending warning when actions present', pass: testCmdStatusPendingWarning() });
  results.push({ name: 'cmdStatus: no pending warning when empty', pass: testCmdStatusNoPending() });
  results.push({ name: 'cmdStatus: pending count correct', pass: testCmdStatusPendingCount() });
  results.push({ name: 'cmdStatus: section order', pass: testCmdStatusSectionOrder() });
  results.push({ name: 'cmdAdjust: does not corrupt equity', pass: await testCmdAdjustDoesNotCorruptEquity() });
  results.push({ name: 'cmdStatus: shows current price per ticker', pass: testCmdStatusShowsTickerCurrentPrice() });
  results.push({ name: 'cmdStatus: shows position value per ticker', pass: testCmdStatusShowsPosValue() });
  results.push({ name: 'cmdStatus: shows unrealized PnL per ticker', pass: testCmdStatusShowsUnrealizedPnl() });
  results.push({ name: 'cmdStatus: total PnL in summary', pass: testCmdStatusTotalPnl() });
  results.push({ name: 'cmdStatus: individual tranche detail', pass: testCmdStatusIndividualTrancheDetail() });
  results.push({ name: 'getStatusSummary: refreshes equity', pass: testGetStatusSummaryRefreshesEquity() });

  console.log('\n=== Results ===');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}`);
    if (!r.pass) allPass = false;
  }

  if (!allPass) {
    console.error('\nSome tests FAILED');
    process.exit(1);
  }
  console.log('\nAll tests PASSED');
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
