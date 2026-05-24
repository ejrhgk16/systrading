import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getCandles_yahoo, sendTelegram } from '../common/util.js';
import { getTradeStatus, setTradeStatus, addTradeLog, getSubDoc, setSubDoc } from '../db/firestoreFunc.js';
import { consoleLogger, fileLogger } from '../common/logger.js';
import { Tranche } from './algo2Class_tranche.js';


// ─── 메인 전략 클래스 ────────────────────────────────────────

export class Algo2QqqGld {

  // ─── 티커 상수 ──────────────────────────────────────────────
  static TICKER_QQQ = 'QQQ';
  static TICKER_GLD = 'GLD';
  static TICKER_TIP = 'TIP';
  static TICKER_VIX = '^VIX';
  static TICKER_VIX3M = '^VIX3M';
  static TICKER_QQQ_LV = 'TQQQ';   // QQQ 3x 레버리지
  static TICKER_GLD_LV = 'UGL';   // GLD 2x 레버리지
  static TICKER_CTA = 'CTA';
  static TICKER_CTA_LV = 'CTA';   // 레버리지 ETF 없음, 현물 그대로

  constructor() {
    this.name = 'algo2_qqq_gld';

    /** @type {Tranche[]} */
    this.tranches = [];
    // 공유 상태
    this.lastRebalIsoWeek = null;
    this.lastSignals = null;

    // 오늘 생성된 액션 (조회용)
    this.pendingActions = [];

    // 가중치 로드: .env 기본값, Firestore 저장값 우선 (set()에서 덮어씀)
    this.weights = (process.env.ALGO2_WEIGHTS || '35,35,30')
        .split(',').map(Number).map(w => w / 100);
  }

  // ─── 필수 인터페이스 ─────────────────────────────────────────

  async set() {
    // 4개 트렌치 Firestore에서 복원 (trade_status/qqq_gld/tranches/{1~4})
    this.tranches = [];
    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    for (let i = 1; i <= 4; i++) {
      const data = await getSubDoc('qqq_gld', 'tranches', String(i));
      if (data) {
        this.tranches.push(Tranche.fromData(data, TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV));
      }
    }

    // 공유 상태 복원 (trade_status/qqq_gld 문서 자체)
    const shared = await getTradeStatus('qqq_gld');
    if (shared) {
      this.lastRebalIsoWeek = shared.last_rebal_iso_week ?? null;
      this.lastSignals = shared.last_signals ?? null;
      this.pendingActions = this._normalizePendingActions(shared.pending_actions ?? []);
      if (shared.weights && Array.isArray(shared.weights) && shared.weights.length > 0) {
        this.weights = shared.weights;
      }
    }

    const initialized = this.tranches.length === 4;
    if (this.pendingActions.length > 0) {
      consoleLogger.info(`${this.name} pendingActions ${this.pendingActions.length}건 복원됨`);
    }
    consoleLogger.info(`${this.name} 초기 설정 완료. ${initialized ? '트렌치 복원됨' : 'init 필요'}`);
  }

  async scheduleFunc() {
    try {
      const indicators = await this.fetchIndicators();
      consoleLogger.info(`${this.name} 시그널:`, indicators);

      const actions = this.determineActions(indicators);

      // equity 갱신
      const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
      for (const t of this.tranches) {
        t.updateEquity({ [TICKER_QQQ_LV]: indicators.qqq_lv_price, [TICKER_GLD_LV]: indicators.gld_lv_price, [TICKER_CTA_LV]: indicators.cta_price });
      }


      await this.saveState(indicators);
      if (actions.length > 0) {
        await this.sendSignalTelegram(indicators, actions);
      }
    } catch (error) {
      consoleLogger.error(`${this.name} scheduleFunc error:`, error);
      fileLogger.error(`${this.name} scheduleFunc error:`, error);
    }
  }

  // ─── 내부 메서드 ─────────────────────────────────────────────

  async fetchIndicators() {
    const { TICKER_QQQ, TICKER_GLD, TICKER_TIP, TICKER_VIX, TICKER_VIX3M, TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    const [qqqCandles, gldCandles, tipCandles, vixCandles, vix3mCandles, qqqLvCandles, gldLvCandles, ctaCandles] =
      await Promise.all([
        getCandles_yahoo(TICKER_QQQ, 200),
        getCandles_yahoo(TICKER_GLD, 200),
        getCandles_yahoo(TICKER_TIP, 200),
        getCandles_yahoo(TICKER_VIX, 5),
        getCandles_yahoo(TICKER_VIX3M, 5),
        getCandles_yahoo(TICKER_QQQ_LV, 5),
        getCandles_yahoo(TICKER_GLD_LV, 5),
        getCandles_yahoo(TICKER_CTA_LV, 200),
      ]);

    // VIX 백워데이션: 오늘 종가 기준 (장 마감 후 실행이므로 확정된 데이터)
    const vixClose = vixCandles[vixCandles.length - 1][4];
    const vix3mClose = vix3mCandles[vix3mCandles.length - 1][4];
    const is_backwardation = vixClose > vix3mClose;

    // 모멘텀 계산: 오늘 종가 기준
    const tip_avg_ret = this._calcMomAvg(tipCandles);
    const qqq_mom_avg = this._calcMomAvg(qqqCandles);
    const gld_mom_avg = this._calcMomAvg(gldCandles);
    const cta_mom_avg = this._calcMomAvg(ctaCandles);

    const qqq_lv_price = qqqLvCandles[qqqLvCandles.length - 1][4];
    const gld_lv_price = gldLvCandles[gldLvCandles.length - 1][4];
    const cta_price = ctaCandles[ctaCandles.length - 1][4];

    return {
      is_backwardation, tip_avg_ret, qqq_mom_avg, gld_mom_avg, cta_mom_avg,
      vix: vixClose, vix3m: vix3mClose, qqq_lv_price, gld_lv_price, cta_price,
      date: new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * 21/63/126일 수익률 평균 계산 (오늘 종가 기준, 장 마감 후 실행)
   */
  _calcMomAvg(candles) {
    const closes = candles.map(c => c[4]);
    const n = closes.length;
    const idx = n - 1;
    if (idx < 126) {
      consoleLogger.warn(`${this.name} 모멘텀 계산용 데이터 부족: ${n}개`);
      return 0;
    }

    const ret21 = (closes[idx] - closes[idx - 21]) / closes[idx - 21];
    const ret63 = (closes[idx] - closes[idx - 63]) / closes[idx - 63];
    const ret126 = (closes[idx] - closes[idx - 126]) / closes[idx - 126];

    return (ret21 + ret63 + ret126) / 3;
  }

  _getISOWeek(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  _normalizePendingActions(actions = []) {
    if (!Array.isArray(actions)) return [];

    return actions
      .filter((action) =>
        action &&
        Number.isFinite(action.tranche_num) &&
        typeof action.ticker === 'string' &&
        (action.action === 'buy' || action.action === 'sell') &&
        Number.isFinite(action.shares) &&
        action.shares > 0 &&
        Number.isFinite(action.price) &&
        action.price > 0 &&
        typeof action.reason === 'string'
      )
      .map((action) => ({
        tranche_num: Number(action.tranche_num),
        ticker: action.ticker,
        action: action.action,
        shares: Number(action.shares),
        price: Number(action.price),
        reason: action.reason,
      }));
  }

  _setPendingActions(actions) {
    this.pendingActions = this._normalizePendingActions(actions);
    return this.pendingActions;
  }

  _isSamePendingAction(left, right) {
    const target = right?._original ?? right;
    if (!left || !target) return false;

    return left.tranche_num === target.tranche_num &&
      left.ticker === target.ticker &&
      left.action === target.action &&
      left.shares === target.shares &&
      left.price === target.price &&
      left.reason === target.reason;
  }

  async _savePendingActions() {
    await setTradeStatus('qqq_gld', {
      pending_actions: this._normalizePendingActions(this.pendingActions),
      updated_at: new Date().toISOString(),
    });
  }

  async clearPendingActions() {
    this.pendingActions = [];
    await this._savePendingActions();
  }

  async removePendingAction(action) {
    const before = this.pendingActions.length;
    this.pendingActions = this.pendingActions.filter((pending) => !this._isSamePendingAction(pending, action));

    if (this.pendingActions.length !== before) {
      await this._savePendingActions();
    }
  }

  /**
   * 오늘 해야 할 매매 액션 리스트 생성
   */
  determineActions(indicators) {
    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    const actions = [];
    const { is_backwardation, tip_avg_ret, qqq_mom_avg, gld_mom_avg, qqq_lv_price, gld_lv_price, cta_price } = indicators;

    // [1] TIP 필터: 모든 트렌치 QQQ_LV+GLD_LV 전량 청산 (CTA는 제외)
    if (tip_avg_ret < 0) {
      for (const t of this.tranches) {
        if (t.shares[TICKER_QQQ_LV] > 0) {
          actions.push({
            tranche_num: t.tranche_num, ticker: TICKER_QQQ_LV, action: 'sell',
            shares: t.shares[TICKER_QQQ_LV], price: qqq_lv_price, reason: 'TIP filter',
          });
        }
        if (t.shares[TICKER_GLD_LV] > 0) {
          actions.push({
            tranche_num: t.tranche_num, ticker: TICKER_GLD_LV, action: 'sell',
            shares: t.shares[TICKER_GLD_LV], price: gld_lv_price, reason: 'TIP filter',
          });
        }
      }
      return this._setPendingActions(actions);
    }

    // [2] VIX 백워데이션: 모든 트렌치 QQQ_LV만 청산 (CTA는 제외)
    if (is_backwardation) {
      for (const t of this.tranches) {
        if (t.shares[TICKER_QQQ_LV] > 0) {
          actions.push({
            tranche_num: t.tranche_num, ticker: TICKER_QQQ_LV, action: 'sell',
            shares: t.shares[TICKER_QQQ_LV], price: qqq_lv_price, reason: 'VIX backwardation',
          });
        }
      }
    }

    // [3] 주간 트렌치 리밸런싱
    const isoWeek = this._getISOWeek();
    const isRebalWeek = this.lastRebalIsoWeek !== isoWeek;
    const rebalTrancheNum = isRebalWeek ? (isoWeek % 4) + 1 : null;

    if (isRebalWeek) {
      const t = this.tranches.find(tr => tr.tranche_num === rebalTrancheNum);
      if (t) {
        const holdQqq = !is_backwardation;
        const holdGld = true;
        const holds = [holdQqq, holdGld, true];  // CTA 항상 true
        const prices = { [TICKER_QQQ_LV]: qqq_lv_price, [TICKER_GLD_LV]: gld_lv_price, [TICKER_CTA_LV]: cta_price };
        const rebalActions = this._calcRebalanceActions(t, prices, holds);
        actions.push(...rebalActions);
      }
    }

    // [4] 콘탱고 복귀: QQQ_LV 0주인 트렌치 전체에 가중치 비율로 재매수 (리밸런싱 대상 제외)
    if (!is_backwardation) {
      for (const t of this.tranches) {
        if (t.tranche_num === rebalTrancheNum) continue;
        if (t.shares[TICKER_QQQ_LV] === 0) {
          const tEquity = t.cash + (t.shares[TICKER_GLD_LV] * gld_lv_price) + (t.shares[TICKER_CTA_LV] * cta_price);
          const targetShares = Math.floor(tEquity * this.weights[0] / qqq_lv_price);
          if (targetShares > 0) {
            actions.push({
              tranche_num: t.tranche_num, ticker: TICKER_QQQ_LV, action: 'buy',
              shares: targetShares, price: qqq_lv_price, reason: 'contango 복귀',
            });
          }
        }
      }
    }

    // [5] TIP 복귀: GLD_LV 0주인 트렌치 전체에 가중치 비율로 재매수 (리밸런싱 대상 제외)
    for (const t of this.tranches) {
      if (t.tranche_num === rebalTrancheNum) continue;
      if (t.shares[TICKER_GLD_LV] === 0) {
        const tEquity = t.cash + (t.shares[TICKER_QQQ_LV] * qqq_lv_price) + (t.shares[TICKER_CTA_LV] * cta_price);
        const targetShares = Math.floor(tEquity * this.weights[1] / gld_lv_price);
        if (targetShares > 0) {
          actions.push({
            tranche_num: t.tranche_num, ticker: TICKER_GLD_LV, action: 'buy',
            shares: targetShares, price: gld_lv_price, reason: 'TIP 복귀',
          });
        }
      }
    }

    return this._setPendingActions(actions);
  }

  _calcRebalanceActions(tranche, prices, holds) {
    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    const tickers = [TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV];
    const actions = [];
    const eq = tranche.cash + tickers.reduce((s, t) => s + tranche.shares[t] * (prices[t] || 0), 0);

    for (let i = 0; i < tickers.length; i++) {
      const tk = tickers[i];
      const targetShares = (holds[i] && prices[tk] > 0) ? Math.floor(eq * this.weights[i] / prices[tk]) : 0;

      if (tranche.shares[tk] > targetShares) {
        actions.push({
          tranche_num: tranche.tranche_num, ticker: tk, action: 'sell',
          shares: tranche.shares[tk] - targetShares, price: prices[tk],
          reason: holds[i] ? 'rebalance' : 'mom filter',
        });
      }
      if (tranche.shares[tk] < targetShares && holds[i]) {
        actions.push({
          tranche_num: tranche.tranche_num, ticker: tk, action: 'buy',
          shares: targetShares - tranche.shares[tk], price: prices[tk],
          reason: 'rebalance',
        });
      }
    }
    return actions;
  }

  async sendSignalTelegram(indicators, actions) {
    const { is_backwardation, tip_avg_ret, qqq_mom_avg, gld_mom_avg, cta_mom_avg, vix, vix3m, date } = indicators;

    const isoWeek = this._getISOWeek();
    const targetTrancheNum = (isoWeek % 4) + 1;
    const isRebalWeek = this.lastRebalIsoWeek !== isoWeek;

    const vixStructure = is_backwardation
      ? `백워데이션 (VIX=${vix.toFixed(1)} > VIX3M=${vix3m.toFixed(1)})`
      : `콘탱고 (VIX=${vix.toFixed(1)} < VIX3M=${vix3m.toFixed(1)})`;

    const tipStatus = tip_avg_ret < 0 ? '위험' : '정상';
    let msg = `*QQQ+GLD 트렌치 시그널* (${date})\n\n`;
    msg += `시그널:\n`;
    msg += `  VIX 구조: ${vixStructure}\n`;
    msg += `  TIP 모멘텀: ${(tip_avg_ret * 100).toFixed(1)}% (${tipStatus})\n`;
    msg += `  QQQ 모멘텀: ${(qqq_mom_avg * 100).toFixed(1)}%\n`;
    msg += `  GLD 모멘텀: ${(gld_mom_avg * 100).toFixed(1)}%\n`;
    msg += `  CTA 모멘텀: ${(cta_mom_avg * 100).toFixed(1)}%\n\n`;

    if (isRebalWeek) {
      msg += `금주 리밸런싱: 트렌치 #${targetTrancheNum} (ISO week ${isoWeek} % 4 = ${isoWeek % 4})\n\n`;
    } else {
      msg += `금주 리밸런싱: 없음 (이미 실행됨)\n\n`;
    }

    if (actions.length > 0) {
      msg += `필요 액션:\n`;
      for (const a of actions) {
        const actionKr = a.action === 'buy' ? '매수' : '매도';
        msg += `  [트렌치#${a.tranche_num}] ${a.ticker} ${actionKr} ${a.shares}주 @ ~$${a.price.toFixed(2)} (${a.reason})\n`;
      }
    } else {
      msg += `필요 액션: 없음\n`;
    }

    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    msg += `\n포트폴리오:\n`;
    let totalEquity = 0;
    for (const t of this.tranches) {
      totalEquity += t.equity;
      msg += `  트렌치#${t.tranche_num}: $${t.equity.toFixed(0)} (${TICKER_QQQ_LV} ${t.shares[TICKER_QQQ_LV]}주 + ${TICKER_GLD_LV} ${t.shares[TICKER_GLD_LV]}주 + ${TICKER_CTA_LV} ${t.shares[TICKER_CTA_LV]}주 + 현금 $${t.cash.toFixed(0)})\n`;
    }
    msg += `  합계: $${totalEquity.toFixed(0)}`;

    await sendTelegram(msg);
  }

  async saveState(indicators) {
    // 트렌치별 저장
    for (const t of this.tranches) {
      await setSubDoc('qqq_gld', 'tranches', String(t.tranche_num), t.toData());
    }

    // 공유 상태 저장
    const isoWeek = this._getISOWeek();
    const isRebalWeek = this.lastRebalIsoWeek !== isoWeek;

    const shared = {
      last_rebal_iso_week: isRebalWeek ? isoWeek : this.lastRebalIsoWeek,
      last_signals: {
        is_backwardation: indicators.is_backwardation,
        tip_avg_ret: indicators.tip_avg_ret,
        qqq_mom_avg: indicators.qqq_mom_avg,
        gld_mom_avg: indicators.gld_mom_avg,
        qqq_lv_price: indicators.qqq_lv_price,
        gld_lv_price: indicators.gld_lv_price,
        cta_mom_avg: indicators.cta_mom_avg,
        cta_price: indicators.cta_price,
        date: indicators.date,
      },
      pending_actions: this._normalizePendingActions(this.pendingActions),
      weights: this.weights,
      updated_at: new Date().toISOString(),
    };
    await setTradeStatus('qqq_gld', shared);

    if (isRebalWeek) this.lastRebalIsoWeek = isoWeek;
    this.lastSignals = shared.last_signals;
  }

  // ─── CLI 커맨드 (command.js에서 호출) ───────────────────────

  /** ta status 용 한 줄 요약 */
  getStatusSummary() {
    const totalEquity = this.tranches.reduce((s, t) => s + t.equity, 0);
    let msg = `  총자산: $${totalEquity.toFixed(0)}, 트렌치 ${this.tranches.length}개\n`;
    if (this.weights) {
      msg += `  가중치: ${(this.weights[0]*100).toFixed(0)}/${(this.weights[1]*100).toFixed(0)}/${(this.weights[2]*100).toFixed(0)}\n`;
    }
    return msg;
  }

  _cmdWeight(args) {
    if (args.length < 3) return '사용법: ta2 weight <QQQ비중> <GLD비중> <CTA비중> (예: ta2 weight 35 35 30)';

    const w = args.slice(0, 3).map(Number);
    if (w.some(v => isNaN(v) || v <= 0)) return '비중은 0보다 큰 숫자로 입력';

    const sum = w.reduce((a, b) => a + b, 0);
    this.weights = w.map(v => v / sum);  // 자동 정규화

    setTradeStatus('qqq_gld', { weights: this.weights, updated_at: new Date().toISOString() });

    return `가중치 변경: QQQ ${(this.weights[0]*100).toFixed(0)}%, GLD ${(this.weights[1]*100).toFixed(0)}%, CTA ${(this.weights[2]*100).toFixed(0)}%`;
  }

  _cmdStatus(args) {
    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    const trancheNum = args[0] ? parseInt(args[0]) : null;

    if (trancheNum) {
      const t = this.tranches.find(tr => tr.tranche_num === trancheNum);
      if (!t) return `트렌치 #${trancheNum} 없음`;
      return `트렌치#${t.tranche_num}: equity=$${t.equity.toFixed(0)}, ${TICKER_QQQ_LV} ${t.shares[TICKER_QQQ_LV]}주(avg $${t.avg_price[TICKER_QQQ_LV].toFixed(2)}), ${TICKER_GLD_LV} ${t.shares[TICKER_GLD_LV]}주(avg $${t.avg_price[TICKER_GLD_LV].toFixed(2)}), ${TICKER_CTA_LV} ${t.shares[TICKER_CTA_LV]}주(avg $${t.avg_price[TICKER_CTA_LV].toFixed(2)}), 현금 $${t.cash.toFixed(0)}`;
    }

    let result = '=== QQQ+GLD 트렌치 현황 ===\n';
    let totalEquity = 0;
    for (const t of this.tranches) {
      totalEquity += t.equity;
      result += `  트렌치#${t.tranche_num}: $${t.equity.toFixed(0)} (${TICKER_QQQ_LV} ${t.shares[TICKER_QQQ_LV]}주 + ${TICKER_GLD_LV} ${t.shares[TICKER_GLD_LV]}주 + ${TICKER_CTA_LV} ${t.shares[TICKER_CTA_LV]}주 + 현금 $${t.cash.toFixed(0)})\n`;
    }
    result += `  합계: $${totalEquity.toFixed(0)}\n`;

    if (this.lastSignals) {
      const s = this.lastSignals;
      const vixStr = s.is_backwardation ? '백워데이션 (VIX > VIX3M)' : '콘탱고 (VIX < VIX3M)';
      const tipStatus = s.tip_avg_ret < 0 ? '위험' : '정상';
      result += `\n시그널 (${s.date}):\n`;
      result += `  VIX 구조: ${vixStr}\n`;
      result += `  TIP: ${(s.tip_avg_ret * 100).toFixed(1)}% (${tipStatus})\n`;
      result += `  QQQ: ${(s.qqq_mom_avg * 100).toFixed(1)}%\n`;
      result += `  GLD: ${(s.gld_mom_avg * 100).toFixed(1)}%\n`;
      result += `  CTA: ${(s.cta_mom_avg * 100).toFixed(1)}%\n`;
      result += `  ${TICKER_QQQ_LV}: $${s.qqq_lv_price?.toFixed(2)}, ${TICKER_GLD_LV}: $${s.gld_lv_price?.toFixed(2)}, ${TICKER_CTA_LV}: $${s.cta_price?.toFixed(2)}\n`;
    }
    return result;
  }

  /** 초기 포트폴리오 세팅 — 서브 프롬프트 */
  _cmdInit() {
    return {
      prompt: `${Algo2QqqGld.TICKER_QQQ_LV}수량 ${Algo2QqqGld.TICKER_QQQ_LV}현재가 ${Algo2QqqGld.TICKER_GLD_LV}수량 ${Algo2QqqGld.TICKER_GLD_LV}현재가 ${Algo2QqqGld.TICKER_CTA}수량 ${Algo2QqqGld.TICKER_CTA}현재가 순서로 입력 (예: 39 85.5 40 52.3 60 28.1)`,
      handler: async (input) => {
        const parts = input.trim().split(/\s+/);
        if (parts.length < 6) return '입력값 부족 (예: 39 85.5 40 52.3 60 28.1)';

        const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA } = Algo2QqqGld;
        const qqqLvShares = parseInt(parts[0]);
        const qqqLvPrice = parseFloat(parts[1]);
        const gldLvShares = parseInt(parts[2]);
        const gldLvPrice = parseFloat(parts[3]);
        const ctaShares = parseInt(parts[4]);
        const ctaPrice = parseFloat(parts[5]);

        if ([qqqLvShares, qqqLvPrice, gldLvShares, gldLvPrice, ctaShares, ctaPrice].some(v => isNaN(v) || v < 0)) {
          return '잘못된 입력값, 숫자 확인';
        }

        const qqqLvBase = Math.floor(qqqLvShares / 4);
        const qqqLvRem = qqqLvShares % 4;
        const gldLvBase = Math.floor(gldLvShares / 4);
        const gldLvRem = gldLvShares % 4;
        const ctaBase = Math.floor(ctaShares / 4);
        const ctaRem = ctaShares % 4;

        this.tranches = [];
        const results = [];

        for (let i = 0; i < 4; i++) {
          const tQqqLv = qqqLvBase + (i < qqqLvRem ? 1 : 0);
          const tGldLv = gldLvBase + (i < gldLvRem ? 1 : 0);
          const tCta = ctaBase + (i < ctaRem ? 1 : 0);
          const t = new Tranche(i + 1, 0, TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA);
          t.shares[TICKER_QQQ_LV] = tQqqLv;
          t.shares[TICKER_GLD_LV] = tGldLv;
          t.shares[TICKER_CTA] = tCta;
          t.avg_price[TICKER_QQQ_LV] = qqqLvPrice;
          t.avg_price[TICKER_GLD_LV] = gldLvPrice;
          t.avg_price[TICKER_CTA] = ctaPrice;
          t.updateEquity({ [TICKER_QQQ_LV]: qqqLvPrice, [TICKER_GLD_LV]: gldLvPrice, [TICKER_CTA]: ctaPrice });
          this.tranches.push(t);

          await setSubDoc('qqq_gld', 'tranches', String(i + 1), t.toData());
          results.push(`  트렌치#${i + 1}: ${TICKER_QQQ_LV} ${tQqqLv}주 + ${TICKER_GLD_LV} ${tGldLv}주 + ${TICKER_CTA} ${tCta}주 = $${t.equity.toFixed(0)}`);
        }

        const totalEquity = this.tranches.reduce((s, t) => s + t.equity, 0);
        await this.clearPendingActions();
        let msg = `=== 초기 세팅 완료 ===\n`;
        msg += results.join('\n');
        msg += `\n  합계: $${totalEquity.toFixed(0)}`;
        consoleLogger.info(`${this.name} init 완료. 총 $${totalEquity.toFixed(0)}`);
        return msg;
      },
    };
  }

  /** 현금 추가 투입 — 서브 프롬프트 */
  _cmdAdd() {
    if (this.tranches.length !== 4) return 'init 먼저 실행';
    return {
      prompt: '추가 금액 입력 (예: 2400)',
      handler: async (input) => {
        const amount = parseFloat(input.trim());
        if (isNaN(amount) || amount <= 0) return '금액 확인';

        const perTranche = amount / 4;
        const results = [];

        for (const t of this.tranches) {
          const before = t.cash;
          t.cash += perTranche;
          await setSubDoc('qqq_gld', 'tranches', String(t.tranche_num), t.toData());
          results.push(`  트렌치#${t.tranche_num}: 현금 $${before.toFixed(0)} → $${t.cash.toFixed(0)} (+$${perTranche.toFixed(0)})`);
        }

        let msg = `=== 현금 $${amount.toFixed(0)} 추가 완료 (트렌치당 $${perTranche.toFixed(0)}) ===\n`;
        msg += results.join('\n');
        await this.clearPendingActions();
        consoleLogger.info(`${this.name} add $${amount} 완료`);
        return msg;
      },
    };
  }

  /** 강제 실행 — lastRebalIsoWeek 리셋 후 scheduleFunc 호출 */
  async _cmdRun() {
    const before = this.lastRebalIsoWeek;
    this.lastRebalIsoWeek = null;
    const isoWeek = this._getISOWeek();
    const targetTranche = (isoWeek % 4) + 1;
    consoleLogger.info(`${this.name} 강제 실행: lastRebalIsoWeek ${before} → null, 트렌치#${targetTranche} 리밸런싱 대상`);
    await this.scheduleFunc();
    return `강제 실행 완료 (W${isoWeek}, 트렌치#${targetTranche})`;
  }

  /** 현재 상태 기준 pending 재계산 + 저장 */
  async _cmdCheck() {
    if (this.tranches.length !== 4) return 'init 먼저 실행';

    const indicators = await this.fetchIndicators();
    const actions = this.determineActions(indicators);
    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;

    for (const t of this.tranches) {
      t.updateEquity({ [TICKER_QQQ_LV]: indicators.qqq_lv_price, [TICKER_GLD_LV]: indicators.gld_lv_price, [TICKER_CTA_LV]: indicators.cta_price });
    }

    await this.saveState(indicators);

    let msg = `pending 체크 완료 (${indicators.date})`;
    if (actions.length === 0) return `${msg}\n대기 액션 없음`;

    for (const action of actions) {
      const actionKr = action.action === 'buy' ? '매수' : '매도';
      msg += `\n  [트렌치#${action.tranche_num}] ${action.ticker} ${actionKr} ${action.shares}주 @ ~$${action.price.toFixed(2)} (${action.reason})`;
    }
    return msg;
  }

  /** 수동 체결 조정 — 서브 프롬프트 */
  _cmdAdjust() {
    if (this.tranches.length !== 4) return 'init 먼저 실행';
    return {
      prompt: '트렌치번호 ticker(TQQQ/UGL/CTA) buy/sell 수량 체결가 순서로 입력',
      handler: async (input) => {
        const parts = input.trim().split(/\s+/);
        if (parts.length < 5) return '입력 부족: <트렌치번호> <ticker> <buy/sell> <수량> <체결가>';

        const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA } = Algo2QqqGld;
        const trancheNum = parseInt(parts[0]);
        const ticker = parts[1]?.toUpperCase();
        const action = parts[2];
        const shares = parseInt(parts[3]);
        const price = parseFloat(parts[4]);

        if (![1, 2, 3, 4].includes(trancheNum)) return '트렌치 번호 (1~4)';
        if (ticker !== TICKER_QQQ_LV && ticker !== TICKER_GLD_LV && ticker !== TICKER_CTA) return `ticker (${TICKER_QQQ_LV}/${TICKER_GLD_LV}/${TICKER_CTA})`;
        if (action !== 'buy' && action !== 'sell') return 'action (buy/sell)';
        if (isNaN(shares) || shares <= 0) return '수량 확인';
        if (isNaN(price) || price <= 0) return '체결가 확인';

        const t = this.tranches.find(tr => tr.tranche_num === trancheNum);
        if (!t) return `트렌치 #${trancheNum} 없음`;

        const beforeCash = t.cash;
        const beforeAvgPrice = t.avg_price[ticker];

        let pnl = 0;
        if (action === 'buy') {
          t.buy(ticker, shares, price);
        } else {
          if (t.shares[ticker] < shares) return `트렌치#${trancheNum} ${ticker} 보유 부족 (${t.shares[ticker]}주 < ${shares}주)`;
          pnl = (price - beforeAvgPrice) * shares;
          t.sell(ticker, shares, price);
        }

        t.updateEquity(price, price);
        await setSubDoc('qqq_gld', 'tranches', String(trancheNum), t.toData());
        await addTradeLog('algo2_qqq_gld', {
          ticker, action, shares, price,
          reason: 'manual adjust',
          tranche_num: trancheNum, pnl,
        });

        if (action === 'sell') {
          const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
          return `[조정] 트렌치#${trancheNum} ${ticker} 매도 ${shares}주 | 평단 $${beforeAvgPrice.toFixed(2)} → 체결 $${price.toFixed(2)} | 실현손익 ${pnlStr} | 현금 $${beforeCash.toFixed(0)}→$${t.cash.toFixed(0)}`;
        }
        return `[조정] 트렌치#${trancheNum} ${ticker} 매수 ${shares}주 @ $${price.toFixed(2)} | 현금 $${beforeCash.toFixed(0)}→$${t.cash.toFixed(0)}`;
      },
    };
  }

  /** 현금 인출 — 서브 프롬프트 */
  _cmdSub() {
    if (this.tranches.length !== 4) return 'init 먼저 실행';
    return {
      prompt: '인출 금액 입력 (예: 2400)',
      handler: async (input) => {
        const amount = parseFloat(input.trim());
        if (isNaN(amount) || amount <= 0) return '금액 확인';

        const perTranche = amount / 4;
        const results = [];

        for (const t of this.tranches) {
          if (t.cash < perTranche) {
            return `트렌치#${t.tranche_num} 현금 부족 ($${t.cash.toFixed(0)} < $${perTranche.toFixed(0)})`;
          }
        }

        for (const t of this.tranches) {
          const before = t.cash;
          t.cash -= perTranche;
          await setSubDoc('qqq_gld', 'tranches', String(t.tranche_num), t.toData());
          results.push(`  트렌치#${t.tranche_num}: 현금 $${before.toFixed(0)} → $${t.cash.toFixed(0)} (-$${perTranche.toFixed(0)})`);
        }

        let msg = `=== 현금 $${amount.toFixed(0)} 인출 완료 (트렌치당 $${perTranche.toFixed(0)}) ===\n`;
        msg += results.join('\n');
        await this.clearPendingActions();
        consoleLogger.info(`${this.name} sub $${amount} 완료`);
        return msg;
      },
    };
  }

  /** 액션 → 트렌치 상태 반영 + Firestore 저장 */
  async _applyAction(action, price) {
    const t = this.tranches.find(tr => tr.tranche_num === action.tranche_num);
    if (!t) return `트렌치 #${action.tranche_num} 없음`;

    const beforeCash = t.cash;
    const beforeAvgPrice = t.avg_price[action.ticker];

    let pnl = 0;
    if (action.action === 'buy') {
      t.buy(action.ticker, action.shares, price);
    } else {
      pnl = (price - beforeAvgPrice) * action.shares;
      t.sell(action.ticker, action.shares, price);
    }
    const qqqLvP = this.lastSignals?.qqq_lv_price || price;
    const gldLvP = this.lastSignals?.gld_lv_price || price;
    const ctaP = this.lastSignals?.cta_price || price;
    const { TICKER_QQQ_LV, TICKER_GLD_LV, TICKER_CTA_LV } = Algo2QqqGld;
    t.updateEquity({ [TICKER_QQQ_LV]: qqqLvP, [TICKER_GLD_LV]: gldLvP, [TICKER_CTA_LV]: ctaP });

    await setSubDoc('qqq_gld', 'tranches', String(action.tranche_num), t.toData());
    await addTradeLog('algo2_qqq_gld', {
      ticker: action.ticker, action: action.action,
      shares: action.shares, price, reason: action.reason,
      tranche_num: action.tranche_num, pnl,
    });
    await this.removePendingAction(action);

    let result;
    if (action.action === 'sell') {
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      result = `[청산완료] 트렌치#${action.tranche_num} ${action.ticker} ${action.shares}주 | 평단 $${beforeAvgPrice.toFixed(2)} → 체결 $${price.toFixed(2)} | 실현손익 ${pnlStr} | 현금 $${t.cash.toFixed(0)}`;
    } else {
      result = `[매수완료] 트렌치#${action.tranche_num} ${action.ticker} ${action.shares}주 @ $${price.toFixed(2)} | 현금 $${beforeCash.toFixed(0)}→$${t.cash.toFixed(0)}`;
    }
    consoleLogger.info(`${this.name} ${result}`);
    return result;
  }
}
