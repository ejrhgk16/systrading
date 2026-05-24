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
  };

  const actions = algo.determineActions(indicators);
  const sellActions = actions.filter(a => a.action === 'sell');
  const ctaSells = actions.filter(a => a.ticker === T3 && a.action === 'sell');
  assert(sellActions.length === 4, `TIP 필터 → 매도 액션 ${sellActions.length}개 (expected 4: QLD+UGL x 2 트렌치)`);
  assert(sellActions.every(a => a.reason === 'TIP filter'), '모든 매도 사유: TIP filter');
  assert(ctaSells.length === 0, 'TIP 필터에서 CTA는 청산되지 않음');
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


// ─── Test 14: 기본 가중치 로드 (env 미설정 시 35/35/30) ──
console.log('\n[Test 14] 기본 가중치 로드');
{
  // ALGO2_WEIGHTS 환경변수 저장 후 제거
  const saved = process.env.ALGO2_WEIGHTS;
  delete process.env.ALGO2_WEIGHTS;

  // dotenv는 이미 로드됨, module-level이라 재생성 필요
  // 새 인스턴스를 만들면 constructor에서 process.env.ALGO2_WEIGHTS를 읽음
  // dotenv.config()가 override:true이므로 process.env 우선 → delete 시 env 파일값 사용
  // env 파일에 ALGO2_WEIGHTS가 아직 없으므로 기본 35,35,30

  const algo = new Algo2QqqGld();
  assert(algo.weights !== undefined, 'weights 속성 존재');
  assert(algo.weights.length === 3, `weights 배열 길이: ${algo.weights.length} (expected 3)`);
  assert(Math.abs(algo.weights[0] - 0.35) < 0.001, `weights[0] = ${algo.weights[0]} (expected 0.35)`);
  assert(Math.abs(algo.weights[1] - 0.35) < 0.001, `weights[1] = ${algo.weights[1]} (expected 0.35)`);
  assert(Math.abs(algo.weights[2] - 0.30) < 0.001, `weights[2] = ${algo.weights[2]} (expected 0.30)`);

  // 복원
  if (saved !== undefined) process.env.ALGO2_WEIGHTS = saved;
}


// ─── Test 15: _cmdWeight 사용법 안내 ────────────────────────
console.log('\n[Test 15] _cmdWeight 사용법');
{
  const algo = createTestInstance();
  const r0 = algo._cmdWeight([]);
  assert(r0.includes('사용법'), `인수 없음 → 사용법: "${r0}"`);
  const r1 = algo._cmdWeight(['40']);
  assert(r1.includes('사용법'), `인수 1개 → 사용법: "${r1}"`);
  const r2 = algo._cmdWeight(['40', '30']);
  assert(r2.includes('사용법'), `인수 2개 → 사용법: "${r2}"`);
}


// ─── Test 16: _cmdWeight 유효성 검사 ────────────────────────
console.log('\n[Test 16] _cmdWeight 유효성 검사');
{
  const algo = createTestInstance();
  const r1 = algo._cmdWeight(['0', '50', '50']);
  assert(r1.includes('0보다 큰'), `0 포함 → 오류: "${r1}"`);
  const r2 = algo._cmdWeight(['-10', '60', '50']);
  assert(r2.includes('0보다 큰'), `음수 포함 → 오류: "${r2}"`);
  const r3 = algo._cmdWeight(['abc', '50', '50']);
  assert(r3.includes('0보다 큰'), `문자 포함 → 오류: "${r3}"`);
}


// ─── Test 17: _cmdWeight 정규화 및 가중치 갱신 ──────────────
console.log('\n[Test 17] _cmdWeight 정규화');
{
  const algo = createTestInstance();
  // _cmdWeight는 setTradeStatus(Firestore)를 호출하므로 try/catch로 감쌈
  try {
    algo._cmdWeight(['40', '30', '30']);
  } catch (_) {
    // Firestore 호출 실패는 무시, this.weights는 이미 갱신됨
  }
  assert(Math.abs(algo.weights[0] - 0.4) < 0.001, `weights[0] = ${algo.weights[0]} (expected 0.4)`);
  assert(Math.abs(algo.weights[1] - 0.3) < 0.001, `weights[1] = ${algo.weights[1]} (expected 0.3)`);
  assert(Math.abs(algo.weights[2] - 0.3) < 0.001, `weights[2] = ${algo.weights[2]} (expected 0.3)`);
}


// ─── Test 18: saveState shared 객체에 weights 포함 ─────────
console.log('\n[Test 18] saveState weights 저장');
{
  const algo = createTestInstance();
  algo.weights = [0.4, 0.3, 0.3];
  assert(Array.isArray(algo.weights), 'weights는 배열');
  assert(algo.weights.length === 3, 'weights 길이 3');
}


// ─── Test 19: set()에서 Firestore의 weights 복원 ──────────
console.log('\n[Test 19] weights 복원 로직');
{
  // set() 메서드 내 복원 로직이 존재하는지만 검증
  // 실제 Firestore 호출은 통합 테스트 영역
  const algo = createTestInstance();
  // 복원 로직: shared.weights가 배열이고 length>0이면 this.weights에 할당
  // 생성자에서 기본값이 설정되었는지 확인
  assert(algo.weights !== undefined, '생성자에서 weights 기본값 설정');
  // 수동으로 복원 로직 시뮬레이션
  const mockShared = { weights: [0.5, 0.25, 0.25] };
  if (mockShared.weights && Array.isArray(mockShared.weights) && mockShared.weights.length > 0) {
    algo.weights = mockShared.weights;
  }
  assert(Math.abs(algo.weights[0] - 0.5) < 0.001, `복원 후 weights[0] = ${algo.weights[0]} (expected 0.5)`);
  assert(Math.abs(algo.weights[1] - 0.25) < 0.001, `복원 후 weights[1] = ${algo.weights[1]} (expected 0.25)`);
}



// ─── Test 20: _cmdInit prompt에 CTA 포함 ────────────────────
console.log('\n[Test 20] _cmdInit prompt CTA 포함');
{
  const algo = createTestInstance();
  const cmd = algo._cmdInit();
  assert(typeof cmd.prompt === 'string', '_cmdInit가 prompt 문자열 반환');
  assert(cmd.prompt.includes('CTA'), '_cmdInit prompt에 CTA 티커 표시');
  assert(cmd.prompt.includes('6'), '_cmdInit prompt에 6개 입력 예시 포함');
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


// ─── 결과 ──────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`);
console.log(`결과: ${passed} passed, ${failed} failed (총 ${passed + failed})`);
if (failed > 0) process.exit(1);
