// @ts-check
// _cmdStatus() unit tests — tests weights, rebal info, pending warning enhancements
// Firestore calls may fail silently if unauthenticated; tests still verify in-memory behavior.

import { Algo2QqqGld } from '../alogs_tradifi/algo2Class_qqq_gld.js';

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
