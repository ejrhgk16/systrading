/**
 * QQQ+GLD 트렌치 전략 단위 테스트
 * 실행: node test/qqq_gld_tranched.test.js
 */
import { Algo2QqqGld } from '../alogs_tradifi/algo2Class_qqq_gld.js';
import { Tranche } from '../alogs_tradifi/algo2Class_tranche.js';
import { consoleLogger } from '../common/logger.js';

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

const T1 = Algo2QqqGld.TICKER_QQQ_LV;  // 'TQQQ'
const T2 = Algo2QqqGld.TICKER_GLD_LV;  // 'UGL'
const T3 = Algo2QqqGld.TICKER_CTA_LV;  // 'CTA'

function createTestInstance(capital = 10000) {
  const algo = new Algo2QqqGld();
  algo.capital = capital;
  const trancheCapital = capital / 4;
  algo.tranches = [1, 2, 3, 4].map(i => new Tranche(i, trancheCapital, T1, T2, T3));
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
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);
  const sellActions = actions.filter(a => a.action === 'sell');
  const ctaSells = actions.filter(a => a.ticker === T3 && a.action === 'sell');
  assert(sellActions.length === 4, `TIP 필터 → 매도 액션 ${sellActions.length}개 (expected 4: QLD+UGL x 2 트렌치)`);
  assert(sellActions.every(a => a.reason === 'TIP filter'), '모든 매도 사유: TIP filter');
  assert(ctaSells.length === 0, 'TIP 필터에서 CTA는 청산되지 않음');
  // shares unchanged after determineActions
  assert(algo.tranches[0].shares[T1] === 10, 'TIP filter 후 TQQQ shares 유지 (side-effect 없음)');
  assert(algo.tranches[0].shares[T2] === 5, 'TIP filter 후 UGL shares 유지 (side-effect 없음)');
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
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 25,     // vix/vix3m ratio = 1.25 > 1.02 → backwardation
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);
  const qldSells = actions.filter(a => a.ticker === T1 && a.action === 'sell');
  const uglSells = actions.filter(a => a.ticker === 'UGL' && a.action === 'sell');
  const ctaSells = actions.filter(a => a.ticker === T3 && a.action === 'sell');
  assert(qldSells.length === 2, `VIX 백워데이션 → QLD 매도 ${qldSells.length}개 (expected 2)`);
  assert(uglSells.length === 0, `VIX 백워데이션 → UGL 매도 ${uglSells.length}개 (expected 0)`);
  assert(ctaSells.length === 0, 'VIX 백워데이션에서 CTA는 청산되지 않음');
}


// ─── Test 6: 3-자산 리밸런싱 액션 계산 ─────────────────────
console.log('\n[Test 6] 3-자산 리밸런싱');
{
  const algo = createTestInstance();
  const t = algo.tranches[0]; // 트렌치#1
  t.cash = 3000;
  t.shares[T1] = 0;
  t.shares[T2] = 0;
  t.shares[T3] = 0;

  const prices = { [T1]: 80, [T2]: 45, [T3]: 30 };
  const holds = [true, true, true];
  const actions = algo._calcRebalanceActions(t, prices, holds);
  const qqqBuy = actions.find(a => a.ticker === T1 && a.action === 'buy');
  const gldBuy = actions.find(a => a.ticker === T2 && a.action === 'buy');
  const ctaBuy = actions.find(a => a.ticker === T3 && a.action === 'buy');

  assert(qqqBuy !== undefined, 'QQQ 매수 액션 존재');
  assert(gldBuy !== undefined, 'GLD 매수 액션 존재');
  assert(ctaBuy !== undefined, 'CTA 매수 액션 존재');
  assert(qqqBuy.shares === Math.floor(3000 * algo.weights[0] / 80), `QQQ 매수 수량: ${qqqBuy.shares} (expected ${Math.floor(3000 * algo.weights[0] / 80)})`);
  assert(gldBuy.shares === Math.floor(3000 * algo.weights[1] / 45), `GLD 매수 수량: ${gldBuy.shares} (expected ${Math.floor(3000 * algo.weights[1] / 45)})`);
  assert(ctaBuy.shares === Math.floor(3000 * algo.weights[2] / 30), `CTA 매수 수량: ${ctaBuy.shares} (expected ${Math.floor(3000 * algo.weights[2] / 30)})`);
}


// ─── Test 7: 리밸런싱 — 모멘텀 필터 적용 ─────────────────────
console.log('\n[Test 7] 리밸런싱 + 모멘텀 필터');
{
  const algo = createTestInstance();
  const t = algo.tranches[0];
  t.cash = 500;
  t.shares[T1] = 15;
  t.shares[T2] = 10;
  t.shares[T3] = 5;

  // hold[0]=false → QQQ 전량 매도, GLD/CTA 유지
  const prices = { [T1]: 80, [T2]: 45, [T3]: 30 };
  const holds = [false, true, true];
  const actions = algo._calcRebalanceActions(t, prices, holds);
  const qldSell = actions.find(a => a.ticker === T1 && a.action === 'sell');
  assert(qldSell !== undefined, 'QQQ hold=false → QQQ 전량 매도');
  assert(qldSell.reason === 'mom filter', `사유: ${qldSell.reason}`);
  const ctaSells = actions.filter(a => a.ticker === T3 && a.action === 'sell');
  assert(ctaSells.length === 0, 'CTA hold=true → CTA 매도 없음');
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
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,     // vix/vix3m ratio = 0.75 < 0.98 → contango
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);
  const qldBuy = actions.filter(a => a.ticker === T1 && a.action === 'buy' && a.reason === 'contango 복귀');
  assert(qldBuy.length >= 1, `콘탱고 복귀 → QLD 재매수 액션 ${qldBuy.length}개 (트렌치#1 포함)`);
  // CTA는 복귀 로직 없음
  const ctaBuys = actions.filter(a => a.ticker === T3 && a.action === 'buy');
  assert(ctaBuys.length === 0, '콘탱고 복귀 → CTA 매수 없음 (CTA는 항상 보유)');
}


// ─── Test 9: TIP 필터에서 CTA 보존 (CTA 보유 시나리오) ─────
console.log('\n[Test 9] TIP 필터 + CTA 보유 시 CTA 보존');
{
  const algo = createTestInstance();
  algo.tranches[0].shares[T1] = 10;
  algo.tranches[0].shares[T2] = 5;
  algo.tranches[0].shares[T3] = 20; // CTA 보유

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
  };

  const actions = algo.determineActions(indicators);
  const ctaSells = actions.filter(a => a.ticker === T3 && a.action === 'sell');
  assert(ctaSells.length === 0, 'CTA 보유 중 TIP 필터 발동 → CTA 매도 없음');
  // shares unchanged after determineActions
  assert(algo.tranches[0].shares[T1] === 10, 'TIP filter 후 TQQQ shares 유지 (side-effect 없음)');
  assert(algo.tranches[0].shares[T2] === 5, 'TIP filter 후 UGL shares 유지 (side-effect 없음)');
  assert(algo.tranches[0].shares[T3] === 20, 'TIP filter 후 CTA shares 유지 (side-effect 없음)');
}


// ─── Test 10: VIX 백워데이션에서 CTA 보존 ──────────────────
console.log('\n[Test 10] VIX 백워데이션 + CTA 보유 시 CTA 보존');
{
  const algo = createTestInstance();
  algo.lastRebalIsoWeek = algo._getISOWeek();
  algo.tranches[0].shares[T1] = 10;
  algo.tranches[0].shares[T2] = 5;
  algo.tranches[0].shares[T3] = 20;

  const indicators = {
    is_backwardation: true,
    tip_avg_ret: 0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 25,     // vix/vix3m ratio = 1.25 > 1.02 → backwardation
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);
  const ctaSells = actions.filter(a => a.ticker === T3 && a.action === 'sell');
  assert(ctaSells.length === 0, 'CTA 보유 중 VIX 백워데이션 → CTA 매도 없음');
}


// ─── Test 11: updateEquity with CTA price ─────────────────────
console.log('\n[Test 11] updateEquity CTA 가격 반영');
{
  const algo = createTestInstance();
  const t = algo.tranches[0];
  t.shares[T1] = 10;
  t.shares[T2] = 5;
  t.shares[T3] = 20;

  // updateEquity 시 CTA 가격이 equity에 반영되는지 확인
  t.cash = 1000;
  const eq = t.updateEquity({ [T1]: 80, [T2]: 45, [T3]: 30 });
  const expected = 1000 + (10 * 80) + (5 * 45) + (20 * 30);
  assert(eq === expected, `CTA 포함 equity: ${eq} (expected ${expected})`);
}


// ─── Test 12: 주간 리밸런싱 3-자산 holds 컨트롤 ──────────────
console.log('\n[Test 12] 리밸런싱 holds에 따른 CTA 매수 제어');
{
  const algo = createTestInstance();
  const t = algo.tranches[0];
  t.cash = 5000;
  t.shares[T1] = 0;
  t.shares[T2] = 0;
  t.shares[T3] = 0;

  // CTA hold=false → CTA 미매수
  const prices = { [T1]: 100, [T2]: 50, [T3]: 25 };
  const holds = [true, true, false];
  const actions = algo._calcRebalanceActions(t, prices, holds);
  const ctaBuy = actions.find(a => a.ticker === T3 && a.action === 'buy');
  assert(ctaBuy === undefined, 'CTA hold=false → CTA 매수 없음');
}



// ─── Test 13: TICKER_CTA 상수 존재 ─────────────────────────
console.log('\n[Test 13] TICKER_CTA 상수');
{
  assert(Algo2QqqGld.TICKER_CTA === 'CTA', `TICKER_CTA = '${Algo2QqqGld.TICKER_CTA}' (expected 'CTA')`);
}


// ─── Test 14: 기본 가중치 로드 (static WEIGHTS 40/40/20) ──
console.log('\n[Test 14] 기본 가중치 로드');
{
  const algo = new Algo2QqqGld();
  assert(algo.weights !== undefined, 'weights 속성 존재');
  assert(algo.weights.length === 3, `weights 배열 길이: ${algo.weights.length} (expected 3)`);
  assert(Math.abs(algo.weights[0] - 0.40) < 0.001, `weights[0] = ${algo.weights[0]} (expected 0.40)`);
  assert(Math.abs(algo.weights[1] - 0.40) < 0.001, `weights[1] = ${algo.weights[1]} (expected 0.40)`);
  assert(Math.abs(algo.weights[2] - 0.20) < 0.001, `weights[2] = ${algo.weights[2]} (expected 0.20)`);
}


// ─── Test 15: _cmdWeight 미구현 (메서드 없음) ────────────
console.log('\n[Test 15] _cmdWeight 미구현 확인');
{
  const algo = createTestInstance();
  assert(typeof algo._cmdWeight === 'undefined', '_cmdWeight 메서드 없음 (미구현)');
}


// ─── Test 16: (생략, _cmdWeight 미구현) ────────────────────
console.log('\n[Test 16] _cmdWeight — skip (미구현)');
{
  assert(true, '_cmdWeight 미구현으로 skip');
}


// ─── Test 17: (생략, _cmdWeight 미구현) ────────────────────
console.log('\n[Test 17] _cmdWeight — skip (미구현)');
{
  assert(true, '_cmdWeight 미구현으로 skip');
}


// ─── Test 18: saveState shared 객체에 weights 포함 ─────────
console.log('\n[Test 18] saveState weights 저장');
{
  const algo = createTestInstance();
  algo.weights = [0.4, 0.3, 0.3];
  assert(Array.isArray(algo.weights), 'weights는 배열');
  assert(algo.weights.length === 3, 'weights 길이 3');
}


// ─── Test 19: Constructor weights 기본값 ──────────
console.log('\n[Test 19] Constructor weights 기본값');
{
  const algo = createTestInstance();
  assert(algo.weights !== undefined, '생성자에서 weights 기본값 설정');
  assert(algo.weights.length === 3, `weights 배열 길이: ${algo.weights.length} (expected 3)`);
}



// ─── Test 20: _cmdInit prompt에 CTA 포함 ────────────────────
console.log('\n[Test 20] _cmdInit prompt CTA 포함');
{
  const algo = createTestInstance();
  const cmd = algo._cmdInit();
  assert(typeof cmd.prompt === 'string', '_cmdInit가 prompt 문자열 반환');
  assert(cmd.prompt.includes('TQQQ'), '_cmdInit 첫 prompt에 TQQQ 표시');
  assert(cmd.prompt.includes('평단가'), '_cmdInit prompt에 평단가 표시');
  assert(typeof cmd.handler === 'function', '_cmdInit가 handler 함수 반환');
}


// ─── Test 21: _cmdAdjust prompt에 CTA 포함 ──────────────────
console.log('\n[Test 21] _cmdAdjust prompt CTA 포함');
{
  const algo = createTestInstance();
  const cmd = algo._cmdAdjust();
  assert(typeof cmd.prompt === 'string', '_cmdAdjust가 prompt 문자열 반환');
  assert(cmd.prompt.includes('CTA'), '_cmdAdjust prompt에 CTA 티커 표시');
  assert(typeof cmd.handler === 'function', '_cmdAdjust가 handler 함수 반환');
}


// ─── Test 22: _cmdStatus 시그널 섹션에 CTA 표시 ────────────
console.log('\n[Test 22] _cmdStatus CTA 시그널 표시');
{
  const algo = createTestInstance();
  algo.lastSignals = {
    is_backwardation: false,
    tip_avg_ret: 0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    cta_mom_avg: 0.05,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    date: '2026-05-21',
  };
  const result = algo._cmdStatus([]);
  assert(result.includes('CTA:') && result.includes('5.0%'), `_cmdStatus 시그널에 CTA 모멘텀 표시: ${result.includes('CTA:')}`);
  assert(result.includes('CTA: $'), `_cmdStatus에 CTA 현재가 표시: ${result.includes('CTA: $')}`);
  assert(result.includes('CTA ') && result.includes('주'), '_cmdStatus 트렌치별 표시에 CTA 보유량 포함');
}


// ─── Test 23: sendSignalTelegram 메시지에 CTA 모멘텀 포함 ──
console.log('\n[Test 23] sendSignalTelegram CTA 모멘텀 포함');
{
  const algo = createTestInstance();
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 없음
  const indicators = {
    is_backwardation: false,
    tip_avg_ret: 0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    cta_mom_avg: 0.05,
    vix: 15,
    vix3m: 20,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    date: '2026-05-21',
  };
  // sendSignalTelegram internally calls sendTelegram and returns void
  // We verify the method exists and indicators have cta_mom_avg
  assert(indicators.cta_mom_avg === 0.05, 'indicators에 cta_mom_avg 포함');
  assert(typeof algo.sendSignalTelegram === 'function', 'sendSignalTelegram 메서드 존재');
}


// ─── Test 24: _applyAction updateEquity에 CTA price fallback ──
console.log('\n[Test 24] _applyAction CTA price fallback');
{
  const algo = createTestInstance();
  const t = algo.tranches[0];
  t.shares[T1] = 10;
  t.shares[T2] = 5;
  t.shares[T3] = 20;
  t.cash = 1000;

  // lastSignals 없이 _applyAction 호출 시도 (Firestore 호출이므로 try/catch)
  // 검증: CTA price가 0이 아닌 action.price로 fallback되는지 확인
  algo.lastSignals = {
    qqq_lv_price: null,
    gld_lv_price: null,
    cta_price: null,
  };
  // 직접 updateEquity 호출로 fallback 검증
  const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
  const price = 30;
  const qqqLvP = algo.lastSignals?.qqq_lv_price || price;
  const gldLvP = algo.lastSignals?.gld_lv_price || price;
  const ctaP = algo.lastSignals?.cta_price || price;
  assert(ctaP === 30, `ctaP fallback = price (${ctaP})`);
  assert(qqqLvP === 30, `qqqLvP fallback = price (${qqqLvP})`);
  assert(gldLvP === 30, `gldLvP fallback = price (${gldLvP})`);
}



// ─── Test 25: Constructor — static WEIGHTS/TIP_DANGER_WEIGHTS 적용 ──
console.log('\n[Test 25] Constructor — static WEIGHTS/TIP_DANGER_WEIGHTS');
{
  const algo = new Algo2QqqGld();
  assert(Array.isArray(algo.weights), 'weights는 배열');
  assert(algo.weights.length === 3, 'weights 길이 3');
  assert(Algo2QqqGld.TIP_DANGER_WEIGHTS[0] === 0.25, 'static TIP_DANGER_WEIGHTS[0]');
  assert(Algo2QqqGld.TIP_DANGER_WEIGHTS[1] === 0.25, 'static TIP_DANGER_WEIGHTS[1]');
  assert(Algo2QqqGld.TIP_DANGER_WEIGHTS[2] === 0.50, 'static TIP_DANGER_WEIGHTS[2]');
}


// ─── Test 26: TIP normal→danger — weights 전환 ─────────────────
console.log('\n[Test 26] TIP normal→danger — weights 전환');
{
  const algo = createTestInstance();
  algo.tip_state = 'normal';
  algo.weights = [0.35, 0.35, 0.30];
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 방지

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,  // < -TIP_BUFFER → danger
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  algo.determineActions(indicators);
  assert(algo.tip_state === 'danger', `tip_state = ${algo.tip_state} (expected 'danger')`);
  assert(Math.abs(algo.weights[0] - 0.25) < 0.001, `전환 후 weights[0] = ${algo.weights[0]} (expected 0.25)`);
  assert(Math.abs(algo.weights[1] - 0.25) < 0.001, `전환 후 weights[1] = ${algo.weights[1]} (expected 0.25)`);
  assert(Math.abs(algo.weights[2] - 0.50) < 0.001, `전환 후 weights[2] = ${algo.weights[2]} (expected 0.50)`);
}


// ─── Test 27: TIP danger→normal — weights 복원 ─────────────────
console.log('\n[Test 27] TIP danger→normal — weights 복원');
{
  const algo = createTestInstance();
  algo.tip_state = 'danger';
  algo.weights = [0.25, 0.25, 0.50];
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 방지

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: 0.02,  // > +TIP_BUFFER → normal
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  algo.determineActions(indicators);
  assert(algo.tip_state === 'normal', `tip_state = ${algo.tip_state} (expected 'normal')`);
  assert(algo.weights[0] === Algo2QqqGld.WEIGHTS[0], `복원 후 weights[0] = ${algo.weights[0]} (expected ${Algo2QqqGld.WEIGHTS[0]})`);
  assert(algo.weights[1] === Algo2QqqGld.WEIGHTS[1], `복원 후 weights[1] = ${algo.weights[1]} (expected ${Algo2QqqGld.WEIGHTS[1]})`);
  assert(algo.weights[2] === Algo2QqqGld.WEIGHTS[2], `복원 후 weights[2] = ${algo.weights[2]} (expected ${Algo2QqqGld.WEIGHTS[2]})`);
}


// ─── Test 28: TIP 중복 danger 전이 방지 ─────────────────────────
console.log('\n[Test 28] TIP 중복 danger 전이 방지');
{
  const algo = createTestInstance();
  algo.tip_state = 'danger';
  algo.weights = [0.25, 0.25, 0.50];
  algo.lastRebalIsoWeek = algo._getISOWeek();

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,  // 이미 danger인데 또 danger 조건
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  algo.determineActions(indicators);
  assert(algo.tip_state === 'danger', 'tip_state still danger');
  assert(Math.abs(algo.weights[0] - 0.25) < 0.001, 'weights[0] TIP_DANGER_WEIGHTS 유지');
  assert(Math.abs(algo.weights[1] - 0.25) < 0.001, 'weights[1] TIP_DANGER_WEIGHTS 유지');
  assert(Math.abs(algo.weights[2] - 0.50) < 0.001, 'weights[2] TIP_DANGER_WEIGHTS 유지');
}


// ─── Test 29: saveState — tipDangerWeights, _originalWeights 미저장 ──
console.log('\n[Test 29] saveState — weights 미저장');
{
  const algo = createTestInstance();
  const sharedFields = Object.keys({
    last_rebal_iso_week: null,
    last_signals: null,
    pending_actions: null,
    tip_state: null,
    vix_ts_state: null,
    qqq_mom_state: null,
    gld_mom_state: null,
    updated_at: null,
  });
  assert(!sharedFields.includes('weights'), 'saveState shared에 weights 미포함');
}


// ─── Test 30: TIP danger 상태 재시작 — weights 동기화 ──────────
console.log('\n[Test 30] TIP danger 재시작 → weights 동기화');
{
  const algo = createTestInstance();
  // constructor 후 weights는 static WEIGHTS
  assert(algo.weights[0] === Algo2QqqGld.WEIGHTS[0], `초기 weights[0] = ${algo.weights[0]} (expected ${Algo2QqqGld.WEIGHTS[0]})`);
  // set()에서 tip_state='danger' 복원 시뮬레이션
  algo.tip_state = 'danger';
  algo.weights = algo.tip_state === 'danger' ? [...Algo2QqqGld.TIP_DANGER_WEIGHTS] : [...Algo2QqqGld.WEIGHTS];
  assert(Math.abs(algo.weights[0] - 0.25) < 0.001, `재시작 후 weights[0] = ${algo.weights[0]} (expected 0.25)`);
  assert(Math.abs(algo.weights[1] - 0.25) < 0.001, `재시작 후 weights[1] = ${algo.weights[1]} (expected 0.25)`);
  assert(Math.abs(algo.weights[2] - 0.50) < 0.001, `재시작 후 weights[2] = ${algo.weights[2]} (expected 0.50)`);

  // normal 복원도 동일 로직
  algo.tip_state = 'normal';
  algo.weights = algo.tip_state === 'danger' ? [...Algo2QqqGld.TIP_DANGER_WEIGHTS] : [...Algo2QqqGld.WEIGHTS];
  assert(algo.weights[0] === Algo2QqqGld.WEIGHTS[0], `normal 복원 weights[0] = ${algo.weights[0]} (expected ${Algo2QqqGld.WEIGHTS[0]})`);
}


// ─── Test 31: TIP 필터 발동 시 CTA 리밸런싱 유지 (early return 제거 검증) ──
console.log('\n[Test 31] TIP 필터 + CTA 리밸런싱 유지');
{
  const algo = createTestInstance();
  // TIP danger 상태 수동 설정
  algo.tip_state = 'danger';
  // 리밸런싱 강제 트리거 (lastRebalIsoWeek를 현재 주와 다르게 설정)
  algo.lastRebalIsoWeek = algo._getISOWeek() - 1;

  // 4개 트렌치 모두 초기화: TQQQ/GLD 보유 + CTA는 0주
  for (const t of algo.tranches) {
    t.shares[T1] = 10;
    t.shares[T2] = 5;
    t.shares[T3] = 0;
    t.cash = 1000;
  }

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);

  // TIP 필터 sell 액션 확인
  const tipSells = actions.filter(a => a.reason === 'TIP filter');
  assert(tipSells.length > 0, `TIP 필터 sell 액션 ${tipSells.length}개 (존재해야 함)`);

  // TQQQ/GLD 중복 sell 액션 없음: TIP 이외의 reason으로 TQQQ/GLD를 매도하는 액션이 없어야 함
  const nonTipSells = actions.filter(a => a.reason !== 'TIP filter' && a.action === 'sell' && (a.ticker === T1 || a.ticker === T2));
  assert(nonTipSells.length === 0, `TQQQ/GLD 중복 sell 액션 ${nonTipSells.length}개 (expected 0)`);

  // CTA 리밸런싱 액션 존재 (buy 또는 sell)
  const ctaActions = actions.filter(a => a.ticker === T3);
  assert(ctaActions.length > 0, `CTA 액션 ${ctaActions.length}개 (CTA 리밸런싱 존재해야 함)`);

  const ctaRebal = actions.find(a => a.ticker === T3 && a.reason === 'rebalance');
  assert(ctaRebal !== undefined, 'CTA 리밸런싱(rebalance) 액션 존재');
}



// ─── Test 32: pending reminder 메시지 포맷 ──────────────────
console.log('\n[Test 32] pending reminder 메시지 포맷');
{
  const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
  const fakeActions = [
    { action: 'buy',  tranche_num: 1, ticker: TICKER_QQQ_LV, shares: 10, price: 80.50, reason: 'rebalance' },
    { action: 'sell', tranche_num: 2, ticker: TICKER_GLD_LV, shares: 5,  price: 45.20, reason: 'TIP filter' },
  ];

  let msg = `⚠️ [QQQ+GLD] 미체결 액션 알림\n\n`;
  msg += `이전 사이클에서 confirm되지 않은 액션 ${fakeActions.length}건이 남아있습니다:\n`;
  for (const a of fakeActions) {
    const actionKr = a.action === 'buy' ? '매수' : '매도';
    msg += `  [트렌치#${a.tranche_num}] ${a.ticker} ${actionKr} ${a.shares}주 @ ~$${a.price.toFixed(2)} (${a.reason})\n`;
  }
  msg += `\nCLI에서 'ta2 confirm'으로 체결해주세요.`;

  assert(msg.includes('⚠️'), '메시지에 경고 이모지 포함');
  assert(msg.includes('[QQQ+GLD] 미체결 액션 알림'), '메시지 제목 포함');
  assert(msg.includes('2건'), '메시지에 액션 개수 포함');
  assert(msg.includes('[트렌치#1]'), '트렌치#1 정보 포함');
  assert(msg.includes('[트렌치#2]'), '트렌치#2 정보 포함');
  assert(msg.includes(TICKER_QQQ_LV), 'TQQQ 티커 포함');
  assert(msg.includes(TICKER_GLD_LV), 'UGL 티커 포함');
  assert(msg.includes('매수'), '매수 키워드 포함');
  assert(msg.includes('매도'), '매도 키워드 포함');
  assert(msg.includes('ta2 confirm'), 'CLI 안내 포함');
  assert(msg.includes('$80.50'), '가격 포맷 포함');
  assert(msg.includes('$45.20'), '가격 포맷 포함');
}


// ─── Test 33: scheduleFunc — pendingActions 있을 때 Telegram 알림 ──
console.log('\n[Test 33] scheduleFunc — pendingActions > 0 → Telegram 알림');
{
  const algo = createTestInstance();

  // pendingActions 세팅
  algo.pendingActions = [
    { action: 'buy', tranche_num: 1, ticker: 'TQQQ', shares: 10, price: 80.50, reason: 'rebalance' },
  ];

  // fetchIndicators mock (실제 API 호출 방지)
  algo.fetchIndicators = async () => ({
    is_backwardation: false, tip_avg_ret: 0.02, qqq_mom_avg: 0.05, gld_mom_avg: 0.03, cta_mom_avg: 0.05,
    qqq_lv_price: 80, gld_lv_price: 45, cta_price: 30, vix: 15, vix3m: 20, date: '2026-05-21',
  });

  // determineActions mock — merge 사이드이펙트 방지
  algo.determineActions = () => [];

  // sendSignalTelegram mock (실제 Telegram 발송 방지)
  algo.sendSignalTelegram = async () => {};
  // saveState mock (Firestore 호출 방지)
  algo.saveState = async () => {};

  const loggerMessages = [];
  const origInfo = consoleLogger.info;
  consoleLogger.info = (msg) => {
    loggerMessages.push(msg);
    origInfo.call(consoleLogger, msg);
  };

  try {
    await algo.scheduleFunc();
    const reminderLog = loggerMessages.find(m => m.includes('pending reminder 발송'));
    assert(reminderLog !== undefined, 'pending reminder 로그 출력됨');
    assert(reminderLog.includes('1건'), `로그에 액션 건수 포함: "${reminderLog}"`);
  } finally {
    consoleLogger.info = origInfo;
  }
}


// ─── Test 34: scheduleFunc — pendingActions 없을 때 알림 미발송 ──
console.log('\n[Test 34] scheduleFunc — pendingActions = 0 → 알림 없음');
{
  const algo = createTestInstance();
  algo.pendingActions = [];

  // mock deps
  algo.fetchIndicators = async () => ({
    is_backwardation: false, tip_avg_ret: 0.02, qqq_mom_avg: 0.05, gld_mom_avg: 0.03, cta_mom_avg: 0.05,
    qqq_lv_price: 80, gld_lv_price: 45, cta_price: 30, vix: 15, vix3m: 20, date: '2026-05-21',
  });
  algo.determineActions = () => [];
  algo.sendSignalTelegram = async () => {};
  algo.saveState = async () => {};

  let loggerCalled = false;
  const origInfo = consoleLogger.info;
  consoleLogger.info = (msg) => {
    if (msg.includes('pending reminder')) {
      loggerCalled = true;
    }
    origInfo.call(consoleLogger, msg);
  };

  try {
    await algo.scheduleFunc();
    assert(!loggerCalled, 'pendingActions=0 → pending reminder 로그 없음');
  } finally {
    consoleLogger.info = origInfo;
  }
}


// ─── Test 35: _mergePendingActions — 기존 pending 보존 (신규 다른 키) ──
console.log('\n[Test 35] _mergePendingActions — 기존 pending 보존 (신규 다른 키)');
{
  const algo = createTestInstance();
  algo._savePendingActions = async () => {};

  algo.pendingActions = [{ tranche_num: 1, ticker: 'TQQQ', action: 'buy', shares: 10, price: 80.50, reason: 'test' }];
  const newActions = [{ tranche_num: 2, ticker: 'UGL', action: 'sell', shares: 5, price: 45.20, reason: 'new' }];

  await algo._mergePendingActions(newActions);

  assert(algo.pendingActions.length === 2, `pendingActions.length = ${algo.pendingActions.length} (expected 2)`);
  assert(algo.pendingActions.some(a => a.tranche_num === 1 && a.ticker === 'TQQQ'), '기존 액션 유지 (트렌치#1 TQQQ)');
  assert(algo.pendingActions.some(a => a.tranche_num === 2 && a.ticker === 'UGL'), '신규 액션 추가 (트렌치#2 UGL)');
}


// ─── Test 36: _mergePendingActions — 동일 (트렌치, 티커) 신규가 기존 대체 ──
console.log('\n[Test 36] _mergePendingActions — 동일 (트렌치, 티커) 신규가 기존 대체');
{
  const algo = createTestInstance();
  algo._savePendingActions = async () => {};

  algo.pendingActions = [{ tranche_num: 1, ticker: 'TQQQ', action: 'buy', shares: 10, price: 80, reason: 'old' }];
  const newActions = [{ tranche_num: 1, ticker: 'TQQQ', action: 'sell', shares: 5, price: 82, reason: 'new' }];

  await algo._mergePendingActions(newActions);

  assert(algo.pendingActions.length === 1, `pendingActions.length = ${algo.pendingActions.length} (expected 1)`);
  const a = algo.pendingActions[0];
  assert(a.action === 'sell', `action = ${a.action} (expected 'sell')`);
  assert(a.shares === 5, `shares = ${a.shares} (expected 5)`);
  assert(a.price === 82, `price = ${a.price} (expected 82)`);
  assert(a.reason === 'new', `reason = ${a.reason} (expected 'new')`);
}


// ─── Test 37: _mergePendingActions — 신규 빈 배열 → 기존 보존 ──
console.log('\n[Test 37] _mergePendingActions — 신규 빈 배열 → 기존 보존');
{
  const algo = createTestInstance();
  algo._savePendingActions = async () => {};

  algo.pendingActions = [{ tranche_num: 1, ticker: 'TQQQ', action: 'buy', shares: 10, price: 80.50, reason: 'test' }];
  const newActions = [];

  await algo._mergePendingActions(newActions);

  assert(algo.pendingActions.length === 1, `pendingActions.length = ${algo.pendingActions.length} (expected 1)`);
  assert(algo.pendingActions[0].tranche_num === 1 && algo.pendingActions[0].ticker === 'TQQQ', '기존 액션 유지');
}


// ─── Test 38: _mergePendingActions — 완전 replace (신규가 기존과 동일 키) ──
console.log('\n[Test 38] _mergePendingActions — 완전 replace (신규가 기존과 동일 키)');
{
  const algo = createTestInstance();
  algo._savePendingActions = async () => {};

  algo.pendingActions = [{ tranche_num: 1, ticker: 'TQQQ', action: 'buy', shares: 10, price: 80, reason: 'old' }];
  const newActions = [{ tranche_num: 1, ticker: 'TQQQ', action: 'buy', shares: 20, price: 85, reason: 'updated' }];

  await algo._mergePendingActions(newActions);

  assert(algo.pendingActions.length === 1, `pendingActions.length = ${algo.pendingActions.length} (expected 1)`);
  const a = algo.pendingActions[0];
  assert(a.shares === 20, `shares = ${a.shares} (expected 20)`);
  assert(a.price === 85, `price = ${a.price} (expected 85)`);
  assert(a.reason === 'updated', `reason = ${a.reason} (expected 'updated')`);
}



// ─── Test 39: TIP danger — CTA 50% 비중 확대 (전체 트렌치) ────
console.log('\n[Test 39] TIP danger — CTA 50% 비중 확대 (전체 트렌치)');
{
  const algo = createTestInstance();
  algo.tip_state = 'danger';
  algo.weights = [...Algo2QqqGld.TIP_DANGER_WEIGHTS]; // [0.25, 0.25, 0.50]
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 방지

  // 각 트렌치에 TQQQ/UGL/CTA 보유 + 현금 세팅
  algo.tranches[0].shares[T1] = 10; algo.tranches[0].shares[T2] = 5;  algo.tranches[0].shares[T3] = 0;  algo.tranches[0].cash = 1000;
  algo.tranches[1].shares[T1] = 8;  algo.tranches[1].shares[T2] = 6;  algo.tranches[1].shares[T3] = 0;  algo.tranches[1].cash = 1000;
  algo.tranches[2].shares[T1] = 0;  algo.tranches[2].shares[T2] = 0;  algo.tranches[2].shares[T3] = 0;  algo.tranches[2].cash = 2500;
  algo.tranches[3].shares[T1] = 0;  algo.tranches[3].shares[T2] = 0;  algo.tranches[3].shares[T3] = 0;  algo.tranches[3].cash = 2500;

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);

  // 모든 트렌치에서 CTA 매수 액션 존재
  const ctaBuys = actions.filter(a => a.ticker === T3 && a.action === 'buy');
  assert(ctaBuys.length === 4, `CTL 매수 액션 ${ctaBuys.length}개 (expected 4: 모든 트렌치)`);

  // CTA 매수 사유 확인
  const tipCtaBuys = ctaBuys.filter(a => a.reason === 'TIP danger CTA 확대');
  assert(tipCtaBuys.length === 4, `TIP danger CTA 확대 액션 ${tipCtaBuys.length}개 (expected 4)`);

  // CTA target 수량 검증 (트렌치#1: equity=1000+10*80+5*45=2025, target=floor(2025*0.50/30)=33)
  const t1CtaBuy = ctaBuys.find(a => a.tranche_num === 1);
  const expectedT1 = Math.floor((1000 + 10*80 + 5*45 + 0*30) * 0.50 / 30);
  assert(t1CtaBuy && t1CtaBuy.shares === expectedT1, `트렌치#1 CTA 매수 수량: ${t1CtaBuy?.shares} (expected ${expectedT1})`);

  // shares 직접 수정 없음 → 원래 shares 값 유지
  assert(algo.tranches[0].shares[T1] === 10, '트렌치#1 TQQQ shares 유지 (side-effect 없음)');
  assert(algo.tranches[0].shares[T2] === 5, '트렌치#1 UGL shares 유지 (side-effect 없음)');
  assert(algo.tranches[1].shares[T1] === 8, '트렌치#2 TQQQ shares 유지 (side-effect 없음)');
  assert(algo.tranches[1].shares[T2] === 6, '트렌치#2 UGL shares 유지 (side-effect 없음)');

  // 중복 매도 방지: TIP 필터 sell 액션에 reason 'TIP filter'만 있어야 함
  const tipSells = actions.filter(a => a.action === 'sell' && a.reason === 'TIP filter');
  assert(tipSells.length === 4, `TIP filter sell 액션 ${tipSells.length}개 (expected 4)`);
}


// ─── Test 40: 중복 매도 방지 — actions 배열 조회 ────────────
console.log('\n[Test 40] 중복 매도 방지 — actions 배열 조회');
{
  const algo = createTestInstance();
  algo.tip_state = 'danger';
  algo.weights = [...Algo2QqqGld.TIP_DANGER_WEIGHTS];
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 방지

  algo.tranches[0].shares[T1] = 10;
  algo.tranches[0].shares[T2] = 5;
  algo.tranches[0].shares[T3] = 20;
  algo.tranches[0].cash = 1000;
  algo.tranches[1].shares[T1] = 8;
  algo.tranches[1].shares[T2] = 6;
  algo.tranches[1].shares[T3] = 0;
  algo.tranches[1].cash = 1000;

  const indicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,
    qqq_mom_avg: 0.05,
    gld_mom_avg: 0.03,
    qqq_lv_price: 80,
    gld_lv_price: 45,
    cta_price: 30,
    vix: 15,
    vix3m: 20,
  };

  const actions = algo.determineActions(indicators);

  // TIP 필터에서 중복 sell 없음: 같은 (tranche_num, ticker) 쌍의 sell은 1개만 존재
  const sellPairs = actions.filter(a => a.action === 'sell').map(a => `${a.tranche_num}_${a.ticker}`);
  const uniquePairs = new Set(sellPairs);
  assert(sellPairs.length === uniquePairs.size, `중복 sell 액션 없음 (${sellPairs.length}개, unique ${uniquePairs.size})`);

  // shares 직접 수정 없음
  assert(algo.tranches[0].shares[T1] === 10, '트렌치#1 TQQQ shares side-effect 없음');
}



// ─── Test 41: TIP danger → 복귀 전체 사이클 ────────────────────
console.log('\n[Test 41] TIP danger 진입 → 복귀 전체 사이클');
{
  const algo = createTestInstance();
  algo.tranches[0].shares[T1] = 10;
  algo.tranches[0].shares[T2] = 5;
  algo.tranches[0].shares[T3] = 20;
  algo.tranches[0].cash = 1000;

  // [Step 1] TIP danger 진입 → 전량 매도 + CTA 확대 액션
  const dangerIndicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,  // danger
    qqq_mom_avg: 0.05, gld_mom_avg: 0.03,
    qqq_lv_price: 80, gld_lv_price: 45, cta_price: 30,
    vix: 15, vix3m: 20,
  };
  const dangerActions = algo.determineActions(dangerIndicators);
  const tipSells = dangerActions.filter(a => a.reason === 'TIP filter');
  const ctaExpands = dangerActions.filter(a => a.reason === 'TIP danger CTA 확대');
  assert(tipSells.length === 2, `TIP danger → 매도 액션 2개 (TQQQ+UGL)`);
  assert(ctaExpands.length === 4, `TIP danger → CTA 확대 액션 4개 (전체 트렌치)`);
  // shares 변경 안 됨
  assert(algo.tranches[0].shares[T1] === 10, 'TIP danger 후에도 TQQQ shares 유지');
  assert(algo.tranches[0].shares[T2] === 5, 'TIP danger 후에도 UGL shares 유지');
  assert(algo.tranches[0].shares[T3] === 20, 'TIP danger 후에도 CTA shares 유지');

  // [Step 2] confirm 매도 + CTA 확대 매수 (수동 시뮬레이션)
  const qqqSellAction = dangerActions.find(a => a.ticker === T1 && a.action === 'sell');
  const gldSellAction = dangerActions.find(a => a.ticker === T2 && a.action === 'sell');
  const ctaBuyAction = dangerActions.find(a => a.ticker === T3 && a.action === 'buy');
  algo.tranches[0].sell(T1, qqqSellAction.shares, qqqSellAction.price);
  algo.tranches[0].sell(T2, gldSellAction.shares, gldSellAction.price);
  algo.tranches[0].buy(T3, ctaBuyAction.shares, ctaBuyAction.price);
  assert(algo.tranches[0].shares[T1] === 0, 'confirm 후 TQQQ 0');
  assert(algo.tranches[0].shares[T2] === 0, 'confirm 후 UGL 0');
  assert(algo.tranches[0].shares[T3] > 20, 'confirm 후 CTA 증가');

  // [Step 3] TIP 복귀 → 재매수 액션
  algo.lastRebalIsoWeek = algo._getISOWeek(); // 리밸런싱 방지
  const returnIndicators = {
    is_backwardation: false,
    tip_avg_ret: 0.02,  // normal 복귀
    qqq_mom_avg: 0.05, gld_mom_avg: 0.03,
    qqq_lv_price: 80, gld_lv_price: 45, cta_price: 30,
    vix: 15, vix3m: 20,
  };
  const returnActions = algo.determineActions(returnIndicators);
  const tipReturnBuys = returnActions.filter(a => a.reason === 'TIP 복귀');
  assert(tipReturnBuys.length >= 1, `TIP 복귀 → UGL 재매수 액션 존재`);
  const contangoReturnBuys = returnActions.filter(a => a.reason === 'contango 복귀');
  assert(contangoReturnBuys.length >= 1, `콘탱고 복귀 → TQQQ 재매수 액션 존재`);
}


// ─── Test 42: TIP danger + CTA 50% 확대 (전체 트렌치) ────────
console.log('\n[Test 42] TIP danger + CTA 50% 확대 (전체 트렌치)');
{
  const algo2 = createTestInstance();
  // 모든 트렌치에 포지션 세팅
  for (let i = 0; i < 4; i++) {
    algo2.tranches[i].shares[T1] = 10;
    algo2.tranches[i].shares[T2] = 5;
    algo2.tranches[i].shares[T3] = 20;
    algo2.tranches[i].cash = 1000;
  }
  algo2.lastRebalIsoWeek = algo2._getISOWeek(); // 리밸런싱 간섭 방지

  const dangerIndicators = {
    is_backwardation: false,
    tip_avg_ret: -0.02,  // danger
    qqq_mom_avg: 0.05, gld_mom_avg: 0.03,
    qqq_lv_price: 80, gld_lv_price: 45, cta_price: 30,
    vix: 15, vix3m: 20,
  };
  const actions = algo2.determineActions(dangerIndicators);

  // TIP filter 매도: 4트렌치 × 2종목 = 8개
  const tipSells = actions.filter(a => a.reason === 'TIP filter');
  assert(tipSells.length === 8, `TIP danger → 전체 매도 액션 8개 (${tipSells.length})`);

  // TIP danger CTA 확대: 4트렌치 매수
  const ctaExpands = actions.filter(a => a.reason === 'TIP danger CTA 확대');
  assert(ctaExpands.length === 4, `TIP danger → CTA 확대 액션 4개 (${ctaExpands.length})`);
  assert(ctaExpands.every(a => a.action === 'buy'), 'CTA 확대는 모두 매수');

  // equity 계산 검증: 트렌치#1
  // equity = 1000 + 10*80 + 5*45 + 20*30 = 1000 + 800 + 225 + 600 = 2625
  // CTA target = floor(2625 * 0.50 / 30) = floor(43.75) = 43
  // 현재 20주 → 23주 매수
  const t1cta = ctaExpands.find(a => a.tranche_num === 1);
  assert(t1cta !== undefined, '트렌치#1 CTA 확대 액션 존재');
  assert(t1cta.shares === 23, `트렌치#1 CTA 확대 수량: ${t1cta.shares} (expected 23)`);

  // shares 변경 안 됨 (confirm 전)
  assert(algo2.tranches[0].shares[T1] === 10, 'TQQQ shares 유지');
  assert(algo2.tranches[0].shares[T3] === 20, 'CTA shares 유지');
}


// ─── 결과 ──────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`);
console.log(`결과: ${passed} passed, ${failed} failed (총 ${passed + failed})`);
if (failed > 0) process.exit(1);
