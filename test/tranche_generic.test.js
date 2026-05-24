/**
 * Tranche N-자산 제네릭 테스트
 * 실행: node test/tranche_generic.test.js
 */
import { Tranche } from '../alogs_tradifi/algo2Class_tranche.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.log(`  \u2717 ${msg}`);
    failed++;
  }
}

// ─── Test 1: N-자산 constructor ─────────────────────
console.log('\n[Test 1] N-자산 constructor');
{
  const t = new Tranche(1, 10000, 'TQQQ', 'UGL', 'CTA');
  assert(t.tranche_num === 1, 'tranche_num === 1');
  assert(t.cash === 10000, 'cash === 10000');
  assert(Array.isArray(t.tickers), 'tickers is array');
  assert(t.tickers.length === 3, '3 tickers');
  assert(t.tickers[0] === 'TQQQ', 'ticker[0] === TQQQ');
  assert(t.tickers[1] === 'UGL', 'ticker[1] === UGL');
  assert(t.tickers[2] === 'CTA', 'ticker[2] === CTA');
  assert(t.shares['TQQQ'] === 0, 'TQQQ shares = 0');
  assert(t.shares['UGL'] === 0, 'UGL shares = 0');
  assert(t.shares['CTA'] === 0, 'CTA shares = 0');
  assert(t.avg_price['TQQQ'] === 0, 'TQQQ avg_price = 0');
  assert(t.avg_price['UGL'] === 0, 'UGL avg_price = 0');
  assert(t.avg_price['CTA'] === 0, 'CTA avg_price = 0');
  assert(t.equity === 10000, 'equity === 10000');
  assert(!('ticker1' in t), 'ticker1 프로퍼티 없음');
  assert(!('ticker2' in t), 'ticker2 프로퍼티 없음');
}

// ─── Test 2: buy / sell with N assets ────────────────────
console.log('\n[Test 2] buy/sell with N assets');
{
  const t = new Tranche(1, 10000, 'TQQQ', 'UGL', 'CTA');
  t.buy('TQQQ', 10, 100);
  assert(t.shares['TQQQ'] === 10, 'TQQQ 매수 10주');
  assert(t.cash === 9000, '매수 후 cash = 9000');

  t.buy('CTA', 20, 25);
  assert(t.shares['CTA'] === 20, 'CTA 매수 20주');
  assert(t.cash === 8500, 'CTA 매수 후 cash = 8500');

  t.sell('TQQQ', 5, 110);
  assert(t.shares['TQQQ'] === 5, 'TQQQ 매도 후 5주');
  assert(t.avg_price['TQQQ'] === 100, 'TQQQ avg_price 유지');
  assert(t.cash === 9050, 'TQQQ 매도 후 cash = 9050');

  t.sell('CTA', 20, 30);
  assert(t.shares['CTA'] === 0, 'CTA 전량 매도');
  assert(t.avg_price['CTA'] === 0, 'CTA avg_price 초기화');
  assert(t.cash === 9650, 'CTA 매도 후 cash = 9650');
}

// ─── Test 3: updateEquity ─────────────────────
console.log('\n[Test 3] updateEquity with prices object');
{
  const t = new Tranche(1, 5000, 'TQQQ', 'UGL', 'CTA');
  t.buy('TQQQ', 10, 100);
  t.buy('UGL', 5, 50);
  t.buy('CTA', 20, 25);
  // equity = 5000 - 1000 - 250 - 500 = 3250 cash + (10*100 + 5*50 + 20*25) = 1000 + 250 + 500 = 1750
  // total = 3250 + 1750 = 5000
  assert(t.equity === 5000, '초기 equity = 5000');

  const eq = t.updateEquity({ TQQQ: 110, UGL: 55, CTA: 30 });
  // equity = 3250 + (10*110) + (5*55) + (20*30) = 3250 + 1100 + 275 + 600 = 5225
  assert(eq === 5225, 'updateEquity return = 5225');
  assert(t.equity === 5225, 'equity = 5225 after update');
}

// ─── Test 4: updateEquity with missing price ──────────────
console.log('\n[Test 4] updateEquity with missing price (should treat as 0)');
{
  const t = new Tranche(1, 5000, 'TQQQ', 'UGL', 'CTA');
  t.buy('TQQQ', 10, 100);
  t.buy('UGL', 5, 50);
  t.buy('CTA', 20, 25);

  // Only TQQQ price provided
  const eq = t.updateEquity({ TQQQ: 110 });
  // Missing UGL and CTA → treated as 0
  // equity = 3250 + (10*110) + (5*0) + (20*0) = 3250 + 1100 = 4350
  assert(eq === 4350, 'missing prices → 0, equity = 4350');
}

// ─── Test 5: fromData N-자산 ─────────────────────
console.log('\n[Test 5] fromData with N assets');
{
  const data = {
    tranche_num: 2,
    cash: 8000,
    shares: { TQQQ: 10, UGL: 5, CTA: 15 },
    avg_price: { TQQQ: 100, UGL: 50, CTA: 30 },
    equity: 10000,
  };
  const t = Tranche.fromData(data, 'TQQQ', 'UGL', 'CTA');
  assert(t.tranche_num === 2, 'tranche_num 복원');
  assert(t.cash === 8000, 'cash 복원');
  assert(t.shares['TQQQ'] === 10, 'TQQQ shares 복원');
  assert(t.shares['UGL'] === 5, 'UGL shares 복원');
  assert(t.shares['CTA'] === 15, 'CTA shares 복원');
  assert(t.avg_price['TQQQ'] === 100, 'TQQQ avg_price 복원');
  assert(t.avg_price['UGL'] === 50, 'UGL avg_price 복원');
  assert(t.avg_price['CTA'] === 30, 'CTA avg_price 복원');
  assert(t.equity === 10000, 'equity 복원');
}

// ─── Test 6: fromData with missing ticker data ──────────
console.log('\n[Test 6] fromData with missing ticker (defaults to 0)');
{
  const data = {
    tranche_num: 1,
    cash: 5000,
    shares: { TQQQ: 10 },  // UGL and CTA missing
    avg_price: { TQQQ: 100 },
    equity: 5000,
  };
  const t = Tranche.fromData(data, 'TQQQ', 'UGL', 'CTA');
  assert(t.shares['TQQQ'] === 10, 'TQQQ shares 복원 (있음)');
  assert(t.shares['UGL'] === 0, 'UGL shares = 0 (기본값)');
  assert(t.shares['CTA'] === 0, 'CTA shares = 0 (기본값)');
}

// ─── Test 7: toData ─────────────────────
console.log('\n[Test 7] toData N-자산');
{
  const t = new Tranche(3, 10000, 'TQQQ', 'UGL', 'CTA');
  t.buy('TQQQ', 10, 100);
  t.buy('UGL', 5, 50);
  const data = t.toData();
  assert(data.tranche_num === 3, 'toData tranche_num');
  assert(data.cash === 8750, 'toData cash');
  assert(data.shares['TQQQ'] === 10, 'toData TQQQ shares');
  assert(data.shares['UGL'] === 5, 'toData UGL shares');
  assert(data.shares['CTA'] === 0, 'toData CTA shares = 0');
  assert(data.equity === 10000, 'toData equity');
}

// ─── Test 8: edge cases ─────────────────────
console.log('\n[Test 8] Edge cases');
{
  // 1 ticker
  const t1 = new Tranche(1, 1000, 'TQQQ');
  assert(t1.tickers.length === 1, '1 ticker');
  assert(t1.shares['TQQQ'] === 0, '1 ticker shares');

  // buy/sell with invalid params
  const t2 = new Tranche(1, 1000, 'TQQQ');
  t2.buy('TQQQ', 0, 100);
  assert(t2.shares['TQQQ'] === 0, '0 shares buy = no-op');
  t2.buy('TQQQ', 10, 0);
  assert(t2.shares['TQQQ'] === 0, '0 price buy = no-op');
  t2.sell('TQQQ', -1, 100);
  assert(t2.shares['TQQQ'] === 0, 'negative sell = no-op');
}

// ─── 결과 ──────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`);
console.log(`결과: ${passed} passed, ${failed} failed (총 ${passed + failed})`);
if (failed > 0) process.exit(1);
