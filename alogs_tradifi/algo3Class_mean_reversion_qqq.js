import dotenv from 'dotenv';
dotenv.config({ override: true });

import { calculateBB, calculateATR } from '../common/indicatior.js';
import { getCandles_yahoo, sendTelegram } from '../common/util.js';
import { getTradeStatus, setTradeStatus, addTradeLog } from '../db/firestoreFunc.js';
import { consoleLogger, fileLogger } from '../common/logger.js';


export class Algo3MeanReversionQqq {

  // ─── 티커 상수 ──────────────────────────────────────────────
  static TICKER_QQQ  = 'QQQ';
  static TICKER_TQQQ = 'TQQQ';
  static TICKER_VIX  = '^VIX';
  static TICKER_VIX3M = '^VIX3M';

  // ─── 전략 파라미터 ──────────────────────────────────────────
  static BB_WINDOW       = 10;
  static ATR_PERIOD      = 7;
  static MAX_SLOTS       = 3;
  static SLOT_ATR_OFFSETS = [0.5, 0.5, 1.0, 2.0, 0.5, 1.0]; // C1~C6 (인덱스 0=C1 ... 5=C6)
  static SLOT_SIZE_RATIOS = [0.2, 0.3, 0.5]; // 슬롯1~3 자본비중

  // ─── VIX 레짐 파라미터 ─────────────────────────────────────
  static VIX_LOW    = 15;
  static VIX_HIGH   = 25;
  static VIX_BUFFER = 0.5;
  static TS_BUFFER  = 0.02;

  // C1~C6: [low-contango, low-bwd, mid-contango, mid-bwd, high-contango, high-bwd]
  static ENTRY_STDS = [0.5, 0.5, 0.5, 2.0, 1.0, 1.0];
  static EXIT_STDS  = [0.5, 0.5, 0.5, 1.0, 1.0, 1.0];

  static DOC_ID = 'mean_rev_qqq';

  constructor() {
    this.name = 'algo3_mean_rev_qqq';

    this.capital = 0;
    this.position = {
      type: 'none',        // 'none' | 'long'
      trade_ticker: 'TQQQ',
      slots: [],           // [{ entry_price, qty }, ...]
      qty: 0,
      avg_price: 0,
      slots_entered: 0,
      pending_slot: null,  // 다음 open에 체결할 슬롯 번호 (null | 2 | 3)
    };
    this.vix_regime = { vix_level: 0, ts_state: 0, regime_num: 1 };
    this.last_indicators = null;

    /** @type {Array} 대기 액션 (ta pending / ta confirm 용) */
    this.pendingActions = [];
  }

  // ─── 필수 인터페이스 ─────────────────────────────────────────

  async set() {
    const data = await getTradeStatus(Algo3MeanReversionQqq.DOC_ID);
    if (data) {
      this.capital         = data.capital ?? 0;
      if (data.position)        this.position        = data.position;
      if (data.vix_regime)      this.vix_regime      = data.vix_regime;
      if (data.last_indicators) this.last_indicators = data.last_indicators;
      if (data.pending_actions) this.pendingActions   = data.pending_actions;

      // 재시작 후 pending_slot이 있으면 pendingActions 복원 (Firestore에 없을 때 fallback)
      if (this.position.pending_slot !== null && this.last_indicators) {
        const slotIdx = this.position.pending_slot - 1;
        const ratio   = Algo3MeanReversionQqq.SLOT_SIZE_RATIOS[slotIdx];
        const qty     = Math.floor(this.capital * ratio / this.last_indicators.tqqq_close);
        if (qty > 0) {
          this.pendingActions = [{
            ticker: 'TQQQ',
            action: 'buy',
            shares: qty,
            price:  this.last_indicators.tqqq_close,
            reason: `slot${this.position.pending_slot} entry (저장가. 'ta3 run'으로 갱신)`,
          }];
        }
      }

      consoleLogger.info(
        `${this.name} 복원 완료. 포지션: ${this.position.type}, ` +
        `자본: $${this.capital.toFixed(0)}, VIX 레짐: C${this.vix_regime.regime_num}`
      );
    } else {
      consoleLogger.info(`${this.name} 초기 상태. 'ta3 init' 필요.`);
    }
  }

  async scheduleFunc() {
    try {
      const indicators = await this.fetchIndicators();
      this.updateVixRegime(indicators.vix, indicators.vix3m);

      // 레짐 변경 후 entry/exit std 재계산
      const regimeNum  = this.vix_regime.regime_num;
      const entry_std  = Algo3MeanReversionQqq.ENTRY_STDS[regimeNum - 1];
      const exit_std   = Algo3MeanReversionQqq.EXIT_STDS[regimeNum - 1];
      indicators.entry_std = entry_std;
      indicators.exit_std  = exit_std;

      const bb1 = calculateBB(indicators._qqqCandles, Algo3MeanReversionQqq.BB_WINDOW, 1);
      if (!bb1) throw new Error('BB 계산 실패');
      const bb_std = bb1.middle - bb1.lower;  // 1 × stdDev
      indicators.bb_mid          = bb1.middle;
      indicators.bb_lower_entry  = bb1.middle - bb_std * entry_std;
      indicators.bb_lower_exit   = bb1.middle - bb_std * exit_std;

      const actions = this.determineActions(indicators);
      await this._mergePendingActions(actions);

      await this.saveState(indicators);

      if (actions.length > 0 || this.position.type === 'long' || this.position.pending_slot !== null) {
        await this.sendSignalTelegram(indicators, actions);
      }
    } catch (error) {
      consoleLogger.error(`${this.name} scheduleFunc error:`, error);
      fileLogger.error(`${this.name} scheduleFunc error:`, error);
    }
  }

  // ─── 내부 메서드 ─────────────────────────────────────────────

  async fetchIndicators() {
    const { TICKER_QQQ, TICKER_TQQQ, TICKER_VIX, TICKER_VIX3M, ATR_PERIOD } = Algo3MeanReversionQqq;

    const [qqqCandles, tqqqCandles, vixCandles, vix3mCandles] = await Promise.all([
      getCandles_yahoo(TICKER_QQQ,  30),  // BB(10) 계산용
      getCandles_yahoo(TICKER_TQQQ, 20),  // ATR(7) 계산용
      getCandles_yahoo(TICKER_VIX,  5),
      getCandles_yahoo(TICKER_VIX3M, 5),
    ]);

    const atr       = calculateATR(tqqqCandles, ATR_PERIOD);
    if (atr === null) throw new Error('ATR 계산 실패');

    const qqq_close  = qqqCandles[qqqCandles.length - 1][4];
    const tqqq_close = tqqqCandles[tqqqCandles.length - 1][4];
    const vix        = vixCandles[vixCandles.length - 1][4];
    const vix3m      = vix3mCandles[vix3mCandles.length - 1][4];

    return {
      _qqqCandles: qqqCandles,  // bb 재계산용 (레짐 업데이트 후 사용)
      atr,
      vix,
      vix3m,
      qqq_close,
      tqqq_close,
      // bb_mid, bb_lower_entry, bb_lower_exit, entry_std, exit_std 는 scheduleFunc에서 채움
      date: new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * VIX 레짐 히스테리시스 상태머신 업데이트
   */
  updateVixRegime(vix, vix3m) {
    const { VIX_LOW, VIX_HIGH, VIX_BUFFER, TS_BUFFER } = Algo3MeanReversionQqq;
    let { vix_level, ts_state } = this.vix_regime;

    // VIX 레벨 (히스테리시스)
    if (vix_level === 0) {
      if (vix > VIX_LOW + VIX_BUFFER)  vix_level = 1;
    } else if (vix_level === 1) {
      if (vix < VIX_LOW  - VIX_BUFFER) vix_level = 0;
      else if (vix > VIX_HIGH + VIX_BUFFER) vix_level = 2;
    } else {
      if (vix < VIX_HIGH - VIX_BUFFER) vix_level = 1;
    }

    // 텀스트럭처 (히스테리시스)
    const ratio = vix / vix3m;
    if (ts_state === 0) {  // 콘탱고
      if (ratio > 1 + TS_BUFFER) ts_state = 1;
    } else {               // 백워데이션
      if (ratio < 1 - TS_BUFFER) ts_state = 0;
    }

    const regime_num = vix_level * 2 + ts_state + 1;
    const prev = this.vix_regime.regime_num;
    this.vix_regime = { vix_level, ts_state, regime_num };

    if (prev !== regime_num) {
      consoleLogger.info(`${this.name} VIX 레짐 변경: C${prev} → C${regime_num}`);
    }
  }

  /**
   * 오늘 해야 할 매매 액션 결정
   */
  determineActions(indicators) {
    const { MAX_SLOTS, SLOT_ATR_OFFSETS, SLOT_SIZE_RATIOS } = Algo3MeanReversionQqq;
    const regimeNum = this.vix_regime.regime_num;                       // 1-based (1~6)
    const slotAtrOffset = SLOT_ATR_OFFSETS[regimeNum - 1];              // 0-based 인덱스
    const { bb_lower_entry, bb_lower_exit, atr, qqq_close, tqqq_close } = indicators;
    const actions = [];

    if (this.position.type === 'long') {

      // ① 청산: QQQ 종가 >= BB 청산하단
      if (qqq_close >= bb_lower_exit) {
        this.position.pending_slot = null;  // 청산 시 pending 취소
        actions.push({
          ticker: 'TQQQ',
          action: 'sell',
          shares: this.position.qty,
          price:  tqqq_close,
          reason: 'BB exit',
        });
        return actions;
      }

      // ② 추가슬롯 체결: 이전 run에서 pending_slot 예약됨
      if (this.position.pending_slot !== null) {
        const slotIdx = this.position.pending_slot - 1;
        const ratio   = SLOT_SIZE_RATIOS[slotIdx];
        const qty     = Math.floor(this.capital * ratio / tqqq_close);
        if (qty > 0) {
          actions.push({
            ticker: 'TQQQ',
            action: 'buy',
            shares: qty,
            price:  tqqq_close,
            reason: `slot${this.position.pending_slot} entry`,
          });
        }
      }

      // ③ 추가슬롯 트리거: 다음 run(다음 날 시가)에 ②로 실행될 예약
      if (
        this.position.slots_entered < MAX_SLOTS &&
        this.position.pending_slot === null &&
        tqqq_close < this.position.avg_price - atr * slotAtrOffset
      ) {
        this.position.pending_slot = this.position.slots_entered + 1;
        consoleLogger.info(
          `${this.name} 슬롯${this.position.pending_slot} 진입 예약 ` +
          `(TQQQ ${tqqq_close.toFixed(2)} < avg ${this.position.avg_price.toFixed(2)} - ATR ${atr.toFixed(2)} × ${slotAtrOffset} [C${regimeNum}])`
        );
      }

    } else {

      // ④ 신규 진입: QQQ 종가 < BB 진입하단
      if (qqq_close < bb_lower_entry) {
        const ratio = SLOT_SIZE_RATIOS[0];  // 슬롯1 = 20%
        const qty   = Math.floor(this.capital * ratio / tqqq_close);
        if (qty > 0) {
          actions.push({
            ticker: 'TQQQ',
            action: 'buy',
            shares: qty,
            price:  tqqq_close,
            reason: 'BB entry slot1',
          });
        }
      }
    }

    return actions;
  }

  /**
   * 새 액션을 pendingActions에 병합 (ticker 기준 dedup)
   * - 동일 ticker의 기존 액션 제거 후 새 액션 추가
   * - merge 후 Firestore에 저장
   * @param {Array} newActions - 추가할 액션 배열
   */
  async _mergePendingActions(newActions) {
    const dedupTickers = new Set(newActions.map(a => a.ticker));

    // 기존 pendingActions 중 dedup 대상(ticker)이 아닌 것만 유지
    const remaining = this.pendingActions.filter(a => !dedupTickers.has(a.ticker));

    // 유지분 + 새 액션
    this.pendingActions = [...remaining, ...newActions];

    // Firestore 동기화
    await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
      pending_actions: this.pendingActions,
      updated_at: new Date().toISOString(),
    }, true);
  }

  async clearPendingActions() {
    this.pendingActions = [];
    await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
      pending_actions: [],
      updated_at: new Date().toISOString(),
    }, true);
  }

  async removePendingAction(action) {
    const before = this.pendingActions.length;
    const target = action._original ?? action;
    this.pendingActions = this.pendingActions.filter((pending) =>
      pending.ticker !== target.ticker ||
      pending.action !== target.action ||
      pending.shares !== target.shares ||
      pending.price !== target.price ||
      pending.reason !== target.reason
    );
    if (this.pendingActions.length !== before) {
      await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
        pending_actions: this.pendingActions,
        updated_at: new Date().toISOString(),
      }, true);
    }
  }

  async saveState(indicators) {
    const data = {
      capital:  this.capital,
      position: this.position,
      pending_actions: this.pendingActions,
      vix_regime: this.vix_regime,
      last_indicators: {
        bb_mid:         indicators.bb_mid,
        bb_lower_entry: indicators.bb_lower_entry,
        bb_lower_exit:  indicators.bb_lower_exit,
        entry_std:      indicators.entry_std,
        exit_std:       indicators.exit_std,
        atr:            indicators.atr,
        vix:            indicators.vix,
        vix3m:          indicators.vix3m,
        qqq_close:      indicators.qqq_close,
        tqqq_close:     indicators.tqqq_close,
        date:           indicators.date,
      },
      updated_at: new Date().toISOString(),
    };
    await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, data, false);
  }

  async sendSignalTelegram(indicators, actions) {
    const { bb_mid, bb_lower_entry, bb_lower_exit, entry_std, exit_std, atr, vix, vix3m, qqq_close, tqqq_close, date } = indicators;
    const r = this.vix_regime;
    const p = this.position;
    const tsStr = r.ts_state === 0 ? '콘탱고' : '백워데이션';

    let msg = `*QQQ 역추세 시그널* (${date})\n\n`;
    msg += `VIX 레짐: C${r.regime_num} (VIX=${vix.toFixed(1)}, VIX3M=${vix3m.toFixed(1)}, ${tsStr})\n`;
    msg += `BB: 중간=$${bb_mid.toFixed(2)}, 진입하단=$${bb_lower_entry.toFixed(2)}(×${entry_std}), 청산하단=$${bb_lower_exit.toFixed(2)}(×${exit_std})\n`;
    msg += `QQQ: $${qqq_close.toFixed(2)}, TQQQ: $${tqqq_close.toFixed(2)}, ATR: $${atr.toFixed(2)}\n\n`;

    if (p.type === 'long') {
      msg += `포지션: TQQQ ${p.qty}주, avg $${p.avg_price.toFixed(2)}, 슬롯 ${p.slots_entered}/${Algo3MeanReversionQqq.MAX_SLOTS}\n`;
      if (p.pending_slot) msg += `슬롯${p.pending_slot} 진입 대기\n`;
    } else {
      msg += `포지션: 없음\n`;
    }

    if (actions.length > 0) {
      msg += `\n필요 액션:\n`;
      for (const a of actions) {
        const kr = a.action === 'buy' ? '매수' : '매도';
        msg += `  TQQQ ${kr} ${a.shares}주 @ ~$${a.price.toFixed(2)} (${a.reason})\n`;
      }
    } else {
      msg += `\n필요 액션: 없음\n`;
    }

    await sendTelegram(msg);
  }

  // ─── Command 인터페이스 (command.js에서 호출) ─────────────────

  /** ta status 용 한 줄 요약 */
  getStatusSummary() {
    const p = this.position;
    if (p.type === 'none') {
      return `  포지션 없음, 자본: $${this.capital.toFixed(0)}\n`;
    }
    return `  TQQQ ${p.qty}주 avg $${p.avg_price.toFixed(2)}, 슬롯${p.slots_entered}/${Algo3MeanReversionQqq.MAX_SLOTS}, 자본: $${this.capital.toFixed(0)}\n`;
  }

  _cmdStatus() {
    const p = this.position;
    const r = this.vix_regime;
    const ind = this.last_indicators;
    const tqqqPrice = ind?.tqqq_close ?? 0;

    let msg = `=== Mean Reversion QQQ 현황 ===\n`;
    msg += `VIX 레짐: C${r.regime_num} (vix_lv=${r.vix_level}, ts=${r.ts_state === 0 ? '콘탱고' : '백워데이션'})\n\n`;

    if (p.type === 'long') {
      const posValue = p.qty * tqqqPrice;
      const totalPnl = (tqqqPrice - p.avg_price) * p.qty;
      const totalEquity = this.capital + posValue;
      const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(0)}` : `-$${Math.abs(totalPnl).toFixed(0)}`;
      const slotsStr = p.slots.map((s, i) => `슬롯${i + 1}(${s.qty}주@$${s.entry_price.toFixed(2)})`).join(', ');
      msg += `포지션: LONG TQQQ ${p.qty}주, avg $${p.avg_price.toFixed(2)}, 현재 ~$${tqqqPrice.toFixed(2)}\n`;
      msg += `  ${slotsStr}\n`;
      if (p.pending_slot) msg += `  pending: 슬롯${p.pending_slot} 진입 대기\n`;
      msg += `평가: $${posValue.toFixed(0)}, PnL: ${pnlStr}, 합계(현금+포지션): $${totalEquity.toFixed(0)}\n`;
    } else {
      msg += `포지션: 없음\n`;
      msg += `자본(현금): $${this.capital.toFixed(0)}\n`;
    }

    if (ind) {
      msg += `\n마지막 지표 (${ind.date}):\n`;
      msg += `  QQQ: $${ind.qqq_close?.toFixed(2)}, TQQQ: $${ind.tqqq_close?.toFixed(2)}\n`;
      msg += `  BB 중간: $${ind.bb_mid?.toFixed(2)}, 진입하단: $${ind.bb_lower_entry?.toFixed(2)}(×${ind.entry_std}), 청산하단: $${ind.bb_lower_exit?.toFixed(2)}(×${ind.exit_std})\n`;
      msg += `  ATR: $${ind.atr?.toFixed(2)}, VIX: ${ind.vix?.toFixed(1)}, VIX3M: ${ind.vix3m?.toFixed(1)}\n`;
    }

    return msg;
  }

  /** 초기 자본 세팅 */
  _cmdInit() {
    return {
      instruction: '운용 자본 입력 (예: 50000):',
      handler: async (input) => {
        const amount = parseFloat(input.trim());
        if (isNaN(amount) || amount <= 0) return '금액 확인';

        this.capital  = amount;
        this.position = {
          type: 'none', trade_ticker: 'TQQQ', slots: [],
          qty: 0, avg_price: 0, slots_entered: 0, pending_slot: null,
        };
        this.pendingActions = [];

        await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
          capital:    this.capital,
          position:   this.position,
          updated_at: new Date().toISOString(),
        }, false);

        return `=== 초기 세팅 완료 === 자본: $${this.capital.toFixed(0)}`;
      },
    };
  }

  /** 현금 추가 */
  _cmdAdd() {
    return {
      instruction: '추가 금액 입력 (예: 10000):',
      handler: async (input) => {
        const amount = parseFloat(input.trim());
        if (isNaN(amount) || amount <= 0) return '금액 확인';

        const before  = this.capital;
        this.capital += amount;
        await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
          capital: this.capital, updated_at: new Date().toISOString(),
        }, true);
        return `현금 추가: $${before.toFixed(0)} → $${this.capital.toFixed(0)} (+$${amount.toFixed(0)})`;
      },
    };
  }

  /** 현금 인출 */
  _cmdSub() {
    return {
      instruction: '인출 금액 입력 (예: 10000):',
      handler: async (input) => {
        const amount = parseFloat(input.trim());
        if (isNaN(amount) || amount <= 0) return '금액 확인';
        if (this.capital < amount) return `현금 부족 ($${this.capital.toFixed(0)} < $${amount.toFixed(0)})`;

        const before  = this.capital;
        this.capital -= amount;
        await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
          capital: this.capital, updated_at: new Date().toISOString(),
        }, true);
        return `현금 인출: $${before.toFixed(0)} → $${this.capital.toFixed(0)} (-$${amount.toFixed(0)})`;
      },
    };
  }

  /** 강제 실행 */
  async _cmdRun() {
    await this.scheduleFunc();
    return `강제 실행 완료`;
  }

  /**
   * 체결 반영 + Firestore 저장
   * @param {object} action - { ticker, action, shares, price, reason }
   * @param {number} price  - 실제 체결가
   */
  async _applyAction(action, price) {
    if (action.action === 'buy') {
      const cost = action.shares * price;

      if (this.position.type === 'none') {
        // 신규 진입 (슬롯1)
        this.position = {
          type:          'long',
          trade_ticker:  'TQQQ',
          slots:         [{ entry_price: price, qty: action.shares }],
          qty:           action.shares,
          avg_price:     price,
          slots_entered: 1,
          pending_slot:  null,
        };
      } else {
        // 추가 슬롯
        const newQty = this.position.qty + action.shares;
        const newAvg = (this.position.avg_price * this.position.qty + price * action.shares) / newQty;
        this.position.slots.push({ entry_price: price, qty: action.shares });
        this.position.qty           = newQty;
        this.position.avg_price     = newAvg;
        this.position.slots_entered += 1;
        this.position.pending_slot  = null;
      }
      this.capital -= cost;

      await addTradeLog('algo3_mean_rev_qqq', {
        action: 'buy', ticker: 'TQQQ', shares: action.shares, price,
        reason: action.reason, slots_entered: this.position.slots_entered,
      });

    } else {
      // 전량 청산
      const avgPrice = this.position.avg_price;
      const proceeds = action.shares * price;
      const pnl      = (price - avgPrice) * action.shares;
      this.capital  += proceeds;

      await addTradeLog('algo3_mean_rev_qqq', {
        action: 'sell_all', ticker: 'TQQQ', shares: action.shares, price,
        pnl, reason: action.reason,
      });

      this.position = {
        type: 'none', trade_ticker: 'TQQQ', slots: [],
        qty: 0, avg_price: 0, slots_entered: 0, pending_slot: null,
      };

      await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
        capital:    this.capital,
        position:   this.position,
        updated_at: new Date().toISOString(),
      }, true);

      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const result = `[청산완료] TQQQ ${action.shares}주 | 평단 $${avgPrice.toFixed(2)} → 체결 $${price.toFixed(2)} | 실현손익 ${pnlStr} | 잔여현금 $${this.capital.toFixed(0)}`;
      consoleLogger.info(`${this.name} ${result}`);
      return result;
    }

    await setTradeStatus(Algo3MeanReversionQqq.DOC_ID, {
      capital:    this.capital,
      position:   this.position,
      updated_at: new Date().toISOString(),
    }, true);

    consoleLogger.info(`${this.name} [매수반영] TQQQ ${action.shares}주 @ $${price.toFixed(2)}`);
    return `[매수완료] TQQQ ${action.shares}주 @ $${price.toFixed(2)} | 잔여현금 $${this.capital.toFixed(0)}`;
  }
}
