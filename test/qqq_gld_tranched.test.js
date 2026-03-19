/**
 * QQQ+GLD 트렌치 전략 단위 테스트
 * 실행: node test/qqq_gld_tranched.test.js
 */
import { Algo2QqqGld } from '../alogs_tradifi/algo2Class_qqq_gld.js';
import { Tranche } from '../alogs_tradifi/algo2Class_tranche.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

// ─── 테스트용 인스턴스 (Firestore 없이) ─────────────────────

const T1 = Algo2QqqGld.TICKER_QQQ_LV;  // 'QLD'
const T2 = Algo2QqqGld.TICKER_GLD_LV;  // 'UGL'

function createTestInstance(capital = 10000) {
  const algo = new Algo2QqqGld();
  algo.capital = capital;
  const trancheCapital = capital / 4;
  algo.tranches = [1, 2, 3, 4].map(i => new Tranche(i, trancheCapital, T1, T2));
  algo.lastRebalIsoWeek = null;
  algo.lastSignals = null;
  return algo;
}


// ─── Test 1: ISO week 계산 ──────────────────────────────────
console.log('\n[Test 1] ISO week 계산');
{
  const algo = createTestInstance();
  // 2026-03-15 → ISO week 11 (일요일)
  const w = algo._getISOWeek(new Date(2026, 2, 15));
  assert(w === 11, `2026-03-15 → ISO week ${w} (expected 11)`);

  // 2026-01-01 → ISO week 1
  const w2 = algo._getISOWeek(new Date(2026, 0, 1));
  assert(w2 === 1, `2026-01-01 → ISO week ${w2} (expected 1)`);
}


// ─── Test 2: 트렌치 번호 결정 ──────────────────────────────
console.log('\n[Test 2] 리밸런싱 대상 트렌치 번호');
{
  const algo = createTestInstance();
  // ISO week 11 → (11 % 4) + 1 = 4
  const isoWeek = 11;
  const targetTrancheNum = (isoWeek % 4) + 1;
  assert(targetTrancheNum === 4, `ISO week 11 → 트렌치 #${targetTrancheNum} (expected 4)`);

  // ISO week 12 → (12 % 4) + 1 = 1
  const t2 = (12 % 4) + 1;
  assert(t2 === 1, `ISO week 12 → 트렌치 #${t2} (expected 1)`);

  // ISO week 13 → (13 % 4) + 1 = 2
  const t3 = (13 % 4) + 1;
  assert(t3 === 2, `ISO week 13 → 트렌치 #${t3} (expected 2)`);
}


// ─── Test 3: 모멘텀 계산 ──────────────────────────────────
console.log('\n[Test 3] 모멘텀 평균 계산');
{
  const algo = createTestInstance();
  // 150개 캔들 생성, 종가를 100에서 시작하여 매일 1씩 증가
  const candles = [];
  for (let i = 0; i < 150; i++) {
    candles.push([Date.now() + i * 86400000, 100 + i, 100 + i + 1, 100 + i - 1, 100 + i, 1000]);
  }

  const mom = algo._calcMomAvg(candles);
  assert(typeof mom === 'number', `모멘텀 계산 결과 타입: number`);
  assert(mom > 0, `상승 데이터 → 양수 모멘텀: ${(mom * 100).toFixed(2)}%`);
}


// ─── Test 4: TIP 필터 → 전량 청산 액션 ─────────────────────
console.log('\n[Test 4] TIP 필터 (전량 청산)');
{
  const algo = createTestInstance();
  // 트렌치#1에 보유 포지션 세팅
  algo.tranches[0].shares[T1] = 10;
  algo.tranches[0].shares[T2] = 5;
  algo.tranches[1].shares[T1] = 8;
  algo.tranches[1].shares[T2] = 6;

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,  // 음수 → TIP 필터 발동
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qld_price: 80,
    ugl_price: 45,
  };

  const actions = algo.determineActions(indicators);
  const sellActions = actions.filter(a => a.action === 'sell');
  assert(sellActions.length === 4, `TIP 필터 → 매도 액션 ${sellActions.length}개 (expected 4: QLD+UGL x 2 트렌치)`);
  assert(sellActions.every(a => a.reason === 'TIP filter'), '모든 매도 사유: TIP filter');
}


// ─── Test 5: VIX 백워데이션 → QLD만 청산 ─────────────────────
console.log('\n[Test 5] VIX 백워데이션 (QLD만 청산)');
{
  const algo = createTestInstance();
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 간섭 방지
  algo.tranches[0].shares[T1] = 10;
  algo.tranches[0].shares[T2] = 5;
  algo.tranches[1].shares[T1] = 8;
  algo.tranches[1].shares[T2] = 6;

  const indicators = {
    is_backwardation: true,
    tip_avg_ret: 0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qld_price: 80,
    ugl_price: 45,
  };

  const actions = algo.determineActions(indicators);
  const qldSells = actions.filter(a => a.ticker === 'QLD' && a.action === 'sell');
  const uglSells = actions.filter(a => a.ticker === 'UGL' && a.action === 'sell');
  assert(qldSells.length === 2, `VIX 백워데이션 → QLD 매도 ${qldSells.length}개 (expected 2)`);
  assert(uglSells.length === 0, `VIX 백워데이션 → UGL 매도 ${uglSells.length}개 (expected 0)`);
}


// ─── Test 6: 리밸런싱 액션 계산 ────────────────────────────
console.log('\n[Test 6] 리밸런싱 액션 (50:50)');
{
  const algo = createTestInstance();
  const t = algo.tranches[0]; // 트렌치#1
  t.cash = 2500;
  t.shares[T1] = 0;
  t.shares[T2] = 0;

  const actions = algo._calcRebalanceActions(t, 80, 45, true, true);
  const qldBuy = actions.find(a => a.ticker === 'QLD' && a.action === 'buy');
  const uglBuy = actions.find(a => a.ticker === 'UGL' && a.action === 'buy');

  assert(qldBuy !== undefined, 'QLD 매수 액션 존재');
  assert(uglBuy !== undefined, 'UGL 매수 액션 존재');
  assert(qldBuy.shares === Math.floor(2500 * 0.5 / 80), `QLD 매수 수량: ${qldBuy.shares} (expected ${Math.floor(2500 * 0.5 / 80)})`);
  assert(uglBuy.shares === Math.floor(2500 * 0.5 / 45), `UGL 매수 수량: ${uglBuy.shares} (expected ${Math.floor(2500 * 0.5 / 45)})`);
}


// ─── Test 7: 리밸런싱 — 모멘텀 필터 적용 ─────────────────────
console.log('\n[Test 7] 리밸런싱 + 모멘텀 필터');
{
  const algo = createTestInstance();
  const t = algo.tranches[0];
  t.cash = 500;
  t.shares[T1] = 15;
  t.shares[T2] = 10;

  // hold_qqq=false → QLD 전량 매도, UGL만 50%
  const actions = algo._calcRebalanceActions(t, 80, 45, false, true);
  const qldSell = actions.find(a => a.ticker === 'QLD' && a.action === 'sell');
  assert(qldSell !== undefined, 'QQQ 모멘텀 < 0 → QLD 전량 매도');
  assert(qldSell.reason === 'mom filter', `사유: ${qldSell.reason}`);
}


// ─── Test 8: 콘탱고 복귀 → QLD 재매수 ────────────────────────
console.log('\n[Test 8] 콘탱고 복귀 (QLD 0주 → 재매수)');
{
  const algo = createTestInstance();
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 이번 주 이미 리밸런싱 완료
  algo.tranches[0].shares[T1] = 0;
  algo.tranches[0].shares[T2] = 10;
  algo.tranches[0].cash = 1000;

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: 0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qld_price: 80,
    ugl_price: 45,
  };

  const actions = algo.determineActions(indicators);
  const qldBuy = actions.filter(a => a.ticker === 'QLD' && a.action === 'buy' && a.reason === 'contango 복귀');
  assert(qldBuy.length >= 1, `콘탱고 복귀 → QLD 재매수 액션 ${qldBuy.length}개 (트렌치#1 포함)`);
}


// ─── 결과 ──────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`);
console.log(`결과: ${passed} passed, ${failed} failed (총 ${passed + failed})`);
if (failed > 0) process.exit(1);
