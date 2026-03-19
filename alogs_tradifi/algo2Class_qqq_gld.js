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

  constructor() {
    this.name = 'algo2_qqq_gld';

    /** @type {Tranche[]} */
    this.tranches = [];

    // 공유 상태
    this.lastRebalIsoWeek = null;
    this.lastSignals = null;

    // 오늘 생성된 액션 (조회용)
    this.pendingActions = [];
  }

  // ─── 필수 인터페이스 ─────────────────────────────────────────

  async set() {
    // 4개 트렌치 Firestore에서 복원 (trade_status/qqq_gld/tranches/{1~4})
    this.tranches = [];
    const { TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;
    for (let i = 1; i <= 4; i++) {
      const data = await getSubDoc('qqq_gld', 'tranches', String(i));
      if (data) {
        this.tranches.push(Tranche.fromData(data, TICKER_QQQ_LV, TICKER_GLD_LV));
      }
    }

    // 공유 상태 복원 (trade_status/qqq_gld 문서 자체)
    const shared = await getTradeStatus('qqq_gld');
    if (shared) {
      this.lastRebalIsoWeek = shared.last_rebal_iso_week ?? null;
      this.lastSignals = shared.last_signals ?? null;
    }

    const initialized = this.tranches.length === 4;
    consoleLogger.info(`${this.name} 초기 설정 완료. ${initialized ? '트렌치 복원됨' : 'init 필요'}`);
  }

  async scheduleFunc() {
    try {
      const indicators = await this.fetchIndicators();
      consoleLogger.info(`${this.name} 시그널:`, indicators);

      const actions = this.determineActions(indicators);

      // equity 갱신
      for (const t of this.tranches) {
        t.updateEquity(indicators.qqq_lv_price, indicators.gld_lv_price);
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
    const { TICKER_QQQ, TICKER_GLD, TICKER_TIP, TICKER_VIX, TICKER_VIX3M, TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;
    const [qqqCandles, gldCandles, tipCandles, vixCandles, vix3mCandles, qqqLvCandles, gldLvCandles] =
      await Promise.all([
        getCandles_yahoo(TICKER_QQQ, 200),
        getCandles_yahoo(TICKER_GLD, 200),
        getCandles_yahoo(TICKER_TIP, 200),
        getCandles_yahoo(TICKER_VIX, 5),
        getCandles_yahoo(TICKER_VIX3M, 5),
        getCandles_yahoo(TICKER_QQQ_LV, 5),
        getCandles_yahoo(TICKER_GLD_LV, 5),
      ]);

    // VIX 백워데이션: 오늘 종가 기준 (장 마감 후 실행이므로 확정된 데이터)
    const vixClose = vixCandles[vixCandles.length - 1][4];
    const vix3mClose = vix3mCandles[vix3mCandles.length - 1][4];
    const is_backwardation = vixClose > vix3mClose;

    // 모멘텀 계산: 오늘 종가 기준
    const tip_avg_ret = this._calcMomAvg(tipCandles);
    const qqq_mom_avg = this._calcMomAvg(qqqCandles);
    const gld_mom_avg = this._calcMomAvg(gldCandles);

    const qqq_lv_price = qqqLvCandles[qqqLvCandles.length - 1][4];
    const gld_lv_price = gldLvCandles[gldLvCandles.length - 1][4];

    return {
      is_backwardation, tip_avg_ret, qqq_mom_avg, gld_mom_avg,
      vix: vixClose, vix3m: vix3mClose, qqq_lv_price, gld_lv_price,
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

  /**
   * 오늘 해야 할 매매 액션 리스트 생성
   */
  determineActions(indicators) {
    const { TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;
    const actions = [];
    const { is_backwardation, tip_avg_ret, qqq_mom_avg, gld_mom_avg, qqq_lv_price, gld_lv_price } = indicators;

    // [1] TIP 필터: 모든 트렌치 QQQ_LV+GLD_LV 전량 청산
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
      this.pendingActions = actions;
      return actions;
    }

    // [2] VIX 백워데이션: 모든 트렌치 QQQ_LV만 청산
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
        const hold_qqq = (qqq_mom_avg >= 0) && !is_backwardation;
        const hold_gld = gld_mom_avg >= 0;
        const rebalActions = this._calcRebalanceActions(t, qqq_lv_price, gld_lv_price, hold_qqq, hold_gld);
        actions.push(...rebalActions);
      }
    }

    // [4] 콘탱고 복귀: QQQ_LV 0주인 트렌치 전체에 50% 재매수 (리밸런싱 대상 제외)
    if (!is_backwardation && qqq_mom_avg >= 0) {
      for (const t of this.tranches) {
        if (t.tranche_num === rebalTrancheNum) continue;
        if (t.shares[TICKER_QQQ_LV] === 0) {
          const tEquity = t.cash + (t.shares[TICKER_GLD_LV] * gld_lv_price);
          const targetShares = Math.floor(tEquity * 0.5 / qqq_lv_price);
          if (targetShares > 0) {
            actions.push({
              tranche_num: t.tranche_num, ticker: TICKER_QQQ_LV, action: 'buy',
              shares: targetShares, price: qqq_lv_price, reason: 'contango 복귀',
            });
          }
        }
      }
    }

    // [5] TIP 복귀: GLD_LV 0주인 트렌치 전체에 50% 재매수 (리밸런싱 대상 제외, tip_avg_ret >= 0은 [1]에서 보장)
    if (gld_mom_avg >= 0) {
      for (const t of this.tranches) {
        if (t.tranche_num === rebalTrancheNum) continue;
        if (t.shares[TICKER_GLD_LV] === 0) {
          const tEquity = t.cash + (t.shares[TICKER_QQQ_LV] * qqq_lv_price);
          const targetShares = Math.floor(tEquity * 0.5 / gld_lv_price);
          if (targetShares > 0) {
            actions.push({
              tranche_num: t.tranche_num, ticker: TICKER_GLD_LV, action: 'buy',
              shares: targetShares, price: gld_lv_price, reason: 'TIP 복귀',
            });
          }
        }
      }
    }

    this.pendingActions = actions;
    return actions;
  }

  _calcRebalanceActions(tranche, qqqLvPrice, gldLvPrice, holdQqqLv, holdGldLv) {
    const { TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;
    const actions = [];
    const eq = tranche.cash + (tranche.shares[TICKER_QQQ_LV] * qqqLvPrice) + (tranche.shares[TICKER_GLD_LV] * gldLvPrice);

    const targetQqqLvShares = (holdQqqLv && qqqLvPrice > 0) ? Math.floor(eq * 0.5 / qqqLvPrice) : 0;
    const targetGldLvShares = (holdGldLv && gldLvPrice > 0) ? Math.floor(eq * 0.5 / gldLvPrice) : 0;

    // 매도
    if (tranche.shares[TICKER_QQQ_LV] > targetQqqLvShares) {
      actions.push({
        tranche_num: tranche.tranche_num, ticker: TICKER_QQQ_LV, action: 'sell',
        shares: tranche.shares[TICKER_QQQ_LV] - targetQqqLvShares, price: qqqLvPrice,
        reason: holdQqqLv ? 'rebalance' : 'mom filter',
      });
    }
    if (tranche.shares[TICKER_GLD_LV] > targetGldLvShares) {
      actions.push({
        tranche_num: tranche.tranche_num, ticker: TICKER_GLD_LV, action: 'sell',
        shares: tranche.shares[TICKER_GLD_LV] - targetGldLvShares, price: gldLvPrice,
        reason: holdGldLv ? 'rebalance' : 'mom filter',
      });
    }

    // 매수
    if (tranche.shares[TICKER_QQQ_LV] < targetQqqLvShares && holdQqqLv) {
      actions.push({
        tranche_num: tranche.tranche_num, ticker: TICKER_QQQ_LV, action: 'buy',
        shares: targetQqqLvShares - tranche.shares[TICKER_QQQ_LV], price: qqqLvPrice,
        reason: 'rebalance',
      });
    }
    if (tranche.shares[TICKER_GLD_LV] < targetGldLvShares && holdGldLv) {
      actions.push({
        tranche_num: tranche.tranche_num, ticker: TICKER_GLD_LV, action: 'buy',
        shares: targetGldLvShares - tranche.shares[TICKER_GLD_LV], price: gldLvPrice,
        reason: 'rebalance',
      });
    }

    return actions;
  }

  async sendSignalTelegram(indicators, actions) {
    const { is_backwardation, tip_avg_ret, qqq_mom_avg, gld_mom_avg, vix, vix3m, date } = indicators;

    const isoWeek = this._getISOWeek();
    const targetTrancheNum = (isoWeek % 4) + 1;
    const isRebalWeek = this.lastRebalIsoWeek !== isoWeek;

    const vixStructure = is_backwardation
      ? `백워데이션 (VIX=${vix.toFixed(1)} > VIX3M=${vix3m.toFixed(1)})`
      : `콘탱고 (VIX=${vix.toFixed(1)} < VIX3M=${vix3m.toFixed(1)})`;

    const tipStatus = tip_avg_ret < 0 ? '위험' : '정상';
    const qqqStatus = qqq_mom_avg < 0 ? '미보유' : '보유';
    const gldStatus = gld_mom_avg < 0 ? '미보유' : '보유';

    let msg = `*QQQ+GLD 트렌치 시그널* (${date})\n\n`;
    msg += `시그널:\n`;
    msg += `  VIX 구조: ${vixStructure}\n`;
    msg += `  TIP 모멘텀: ${(tip_avg_ret * 100).toFixed(1)}% (${tipStatus})\n`;
    msg += `  QQQ 모멘텀: ${(qqq_mom_avg * 100).toFixed(1)}% (${qqqStatus})\n`;
    msg += `  GLD 모멘텀: ${(gld_mom_avg * 100).toFixed(1)}% (${gldStatus})\n\n`;

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

    const { TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;
    msg += `\n포트폴리오:\n`;
    let totalEquity = 0;
    for (const t of this.tranches) {
      totalEquity += t.equity;
      msg += `  트렌치#${t.tranche_num}: $${t.equity.toFixed(0)} (${TICKER_QQQ_LV} ${t.shares[TICKER_QQQ_LV]}주 + ${TICKER_GLD_LV} ${t.shares[TICKER_GLD_LV]}주 + 현금 $${t.cash.toFixed(0)})\n`;
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
        date: indicators.date,
      },
      updated_at: new Date().toISOString(),
    };
    await setTradeStatus('qqq_gld', shared);

    if (isRebalWeek) this.lastRebalIsoWeek = isoWeek;
    this.lastSignals = shared.last_signals;
  }

  // ─── CLI 커맨드 ──────────────────────────────────────────────

  handleCommand(subCmd, args) {
    if (subCmd === 'status') return this._cmdStatus(args);
    if (subCmd === 'pending') return this._cmdPending();
    if (subCmd === 'confirm') return this._cmdConfirm();
    if (subCmd === 'init') return this._cmdInit();
    if (subCmd === 'add') return this._cmdAdd();
    if (subCmd === 'sub') return this._cmdSub();
    if (subCmd === 'run') return this._cmdRun();
    return `알 수 없는 커맨드: ${subCmd}\n사용법: ta2 [status|pending|confirm|init|add|sub|run]`;
  }

  _cmdStatus(args) {
    const { TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;
    const trancheNum = args[0] ? parseInt(args[0]) : null;

    if (trancheNum) {
      const t = this.tranches.find(tr => tr.tranche_num === trancheNum);
      if (!t) return `트렌치 #${trancheNum} 없음`;
      return `트렌치#${t.tranche_num}: equity=$${t.equity.toFixed(0)}, ${TICKER_QQQ_LV} ${t.shares[TICKER_QQQ_LV]}주(avg $${t.avg_price[TICKER_QQQ_LV].toFixed(2)}), ${TICKER_GLD_LV} ${t.shares[TICKER_GLD_LV]}주(avg $${t.avg_price[TICKER_GLD_LV].toFixed(2)}), 현금 $${t.cash.toFixed(0)}`;
    }

    let result = '=== QQQ+GLD 트렌치 현황 ===\n';
    let totalEquity = 0;
    for (const t of this.tranches) {
      totalEquity += t.equity;
      result += `  트렌치#${t.tranche_num}: $${t.equity.toFixed(0)} (${TICKER_QQQ_LV} ${t.shares[TICKER_QQQ_LV]}주 + ${TICKER_GLD_LV} ${t.shares[TICKER_GLD_LV]}주 + 현금 $${t.cash.toFixed(0)})\n`;
    }
    result += `  합계: $${totalEquity.toFixed(0)}`;
    if (this.lastSignals) {
      result += `\n  최근 시그널: ${this.lastSignals.date}`;
    }
    return result;
  }

  _cmdPending() {
    if (this.pendingActions.length === 0) return '대기 액션 없음';
    let result = '=== 대기 액션 ===\n';
    this.pendingActions.forEach((a, i) => {
      const actionKr = a.action === 'buy' ? '매수' : '매도';
      result += `  #${i + 1} [트렌치#${a.tranche_num}] ${a.ticker} ${actionKr} ${a.shares}주 @ ~$${a.price.toFixed(2)} (${a.reason})\n`;
    });
    return result;
  }

  /** 체결 확인 — 서브 프롬프트 */
  _cmdConfirm() {
    if (this.pendingActions.length === 0) return '대기 액션 없음';

    let prompt = '=== 대기 액션 ===\n';
    this.pendingActions.forEach((a, i) => {
      const actionKr = a.action === 'buy' ? '매수' : '매도';
      prompt += `  #${i + 1} [트렌치#${a.tranche_num}] ${a.ticker} ${actionKr} ${a.shares}주 @ ~$${a.price.toFixed(2)} (${a.reason})\n`;
    });
    prompt += '\n번호 체결가 또는 all 입력 (예: 1 79.50 또는 all)';

    return {
      prompt,
      handler: async (input) => {
        const trimmed = input.trim();

        if (trimmed === 'all') {
          const results = [];
          for (const a of [...this.pendingActions]) {
            results.push(await this._applyAction(a, a.price));
          }
          this.pendingActions = [];
          results.push(`\n=== 전체 ${results.length}건 반영 완료 ===`);
          return results.join('\n');
        }

        const parts = trimmed.split(/\s+/);
        const idx = parseInt(parts[0]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= this.pendingActions.length) {
          return `번호 입력 (1~${this.pendingActions.length})`;
        }

        const action = this.pendingActions[idx];
        const price = parts[1] ? parseFloat(parts[1]) : action.price;
        if (isNaN(price) || price <= 0) return '체결가 입력 필요 (예: 1 79.50)';

        const result = await this._applyAction(action, price);
        this.pendingActions.splice(idx, 1);
        return result + `\n남은 대기: ${this.pendingActions.length}건`;
      },
    };
  }

  /** 초기 포트폴리오 세팅 — 서브 프롬프트 */
  _cmdInit() {
    return {
      prompt: `${Algo2QqqGld.TICKER_QQQ_LV}수량 ${Algo2QqqGld.TICKER_QQQ_LV}현재가 ${Algo2QqqGld.TICKER_GLD_LV}수량 ${Algo2QqqGld.TICKER_GLD_LV}현재가 순서로 입력 (예: 39 85.5 40 52.3)`,
      handler: async (input) => {
        const parts = input.trim().split(/\s+/);
        if (parts.length < 4) return '입력값 부족 (예: 39 85.5 40 52.3)';

        const qqqLvShares = parseInt(parts[0]);
        const qqqLvPrice = parseFloat(parts[1]);
        const gldLvShares = parseInt(parts[2]);
        const gldLvPrice = parseFloat(parts[3]);

        if ([qqqLvShares, qqqLvPrice, gldLvShares, gldLvPrice].some(v => isNaN(v) || v < 0)) {
          return '잘못된 입력값, 숫자 확인';
        }

        const qqqLvBase = Math.floor(qqqLvShares / 4);
        const qqqLvRemainder = qqqLvShares % 4;
        const gldLvBase = Math.floor(gldLvShares / 4);
        const gldLvRemainder = gldLvShares % 4;

        this.tranches = [];
        const results = [];
        const { TICKER_QQQ_LV, TICKER_GLD_LV } = Algo2QqqGld;

        for (let i = 0; i < 4; i++) {
          const tQqqLv = qqqLvBase + (i < qqqLvRemainder ? 1 : 0);
          const tGldLv = gldLvBase + (i < gldLvRemainder ? 1 : 0);
          const t = new Tranche(i + 1, 0, TICKER_QQQ_LV, TICKER_GLD_LV);
          t.shares[TICKER_QQQ_LV] = tQqqLv;
          t.shares[TICKER_GLD_LV] = tGldLv;
          t.avg_price[TICKER_QQQ_LV] = qqqLvPrice;
          t.avg_price[TICKER_GLD_LV] = gldLvPrice;
          t.updateEquity(qqqLvPrice, gldLvPrice);
          this.tranches.push(t);

          await setSubDoc('qqq_gld', 'tranches', String(i + 1), t.toData());
          results.push(`  트렌치#${i + 1}: ${Algo2QqqGld.TICKER_QQQ_LV} ${tQqqLv}주 + ${Algo2QqqGld.TICKER_GLD_LV} ${tGldLv}주 = $${t.equity.toFixed(0)}`);
        }

        const totalEquity = this.tranches.reduce((s, t) => s + t.equity, 0);
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
        consoleLogger.info(`${this.name} sub $${amount} 완료`);
        return msg;
      },
    };
  }

  /** 액션 → 트렌치 상태 반영 + Firestore 저장 */
  async _applyAction(action, price) {
    const t = this.tranches.find(tr => tr.tranche_num === action.tranche_num);
    if (!t) return `트렌치 #${action.tranche_num} 없음`;

    const beforeShares = t.shares[action.ticker];
    const beforeCash = t.cash;

    let pnl = 0;
    if (action.action === 'buy') {
      t.buy(action.ticker, action.shares, price);
    } else {
      pnl = (price - t.avg_price[action.ticker]) * action.shares;
      t.sell(action.ticker, action.shares, price);
    }

    const afterShares = t.shares[action.ticker];
    const qqqLvP = this.lastSignals?.qqq_lv_price || price;
    const gldLvP = this.lastSignals?.gld_lv_price || price;
    t.updateEquity(qqqLvP, gldLvP);

    await setSubDoc('qqq_gld', 'tranches', String(action.tranche_num), t.toData());
    await addTradeLog('algo2_qqq_gld', {
      ticker: action.ticker, action: action.action,
      shares: action.shares, price, reason: action.reason,
      tranche_num: action.tranche_num, pnl,
    });

    const actionKr = action.action === 'buy' ? '매수' : '매도';
    const pnlStr = action.action === 'sell' ? `, PnL: $${pnl.toFixed(2)}` : '';
    const result = `[반영완료] 트렌치#${action.tranche_num} ${action.ticker} ${actionKr} ${action.shares}주 @ $${price.toFixed(2)} (${beforeShares}→${afterShares}주, 현금 $${beforeCash.toFixed(0)}→$${t.cash.toFixed(0)}${pnlStr})`;
    consoleLogger.info(`${this.name} ${result}`);
    return result;
  }
}
