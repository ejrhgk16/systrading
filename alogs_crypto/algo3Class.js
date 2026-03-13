// 전략: 변동성(볼밴) + ATR 기반 사이징/스탑
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { ws_client, WS_KEY_MAP } from '../common/client.js';
import { calculateDMI, calculateBB, calculateAlligator, calculateATR } from '../common/indicatior.js';
import { getKline, setMsgFormat, sendTelegram, runWithTimeout } from '../common/util.js';
import { getTradeStatus, setTradeStatus, addTradeLog } from '../db/firestoreFunc.js';
import { fileLogger, consoleLogger } from '../common/logger.js';

export default class algo3 {

    constructor(symbol, accountStatus, std = 2) {
        this.name = `algo3_${symbol}_bb${std}`;
        this.symbol = symbol;
        this.std = std;
        this.accountStatus = accountStatus; // 공유 Algo3AccountStatus 인스턴스

        this.qtyMultiplier = 0;
        this.priceMultiplier = 0;
        this.leverage = 3;
        this.max_risk_per_trade = 0.05;
        this.atr_multiplier = 2;

        this.orderSize = 0.0;
        this.openPrice = 0.0;
        this.atr_stop_price = 0.0; // 진입 시 고정

        this.exit_price_1 = 0.0;
        this.exit_price_2 = 0.0;
        this.exit_price_3 = 0.0;

        this.exit_size_1 = 0.0;
        this.exit_size_2 = 0.0;
        this.exit_size_3 = 0.0;

        this.orderId_open = null;
        this.orderId_atr_stop = null;
        this.orderId_exit_1 = null;
        this.orderId_exit_2 = null;
        this.orderId_exit_3 = null;

        this.isOpenOrderFilled = false;
        this.exit_count = 0;
        this.positionType = null;
        this.entry_allow = false;
    }

    async set() {
        this.qtyMultiplier   = Math.pow(10, Number(process.env[this.symbol + '_decimal_qty']));
        this.priceMultiplier = Math.pow(10, Number(process.env[this.symbol + '_decimal_price']));
        this.leverage        = Number(process.env['algo3_leverage'] || 3);

        this.setNewOrderId();

        const docId = this.getTradeStatusDocId();
        const isNew = process.env['algo3_isNew'] === 'true';

        if (isNew) {
            consoleLogger.info(`${this.name} algo3_isNew=true → Firestore 무시, 새 상태로 초기화`);
        } else {
            const data = await getTradeStatus(docId);
            if (data) {
                Object.assign(this, data);
            }
        }

        await setTradeStatus(docId, this.getState());
        consoleLogger.info(`${this.name} 초기 설정 완료`, this.getState());
    }

    async open() {
        const data = await getKline(this.symbol, '240', 200);

        const latestCandle = data[data.length - 1];
        const current_open = latestCandle[1];

        const bbObj   = calculateBB(data, 20, this.std, 1);
        const adxObj  = calculateDMI(data, 14, 1);
        const adxObj2 = calculateDMI(data, 14, 2);
        const alligatorObj = calculateAlligator(data, 0);
        const atr = calculateATR(data, 14, 1);

        const lips_8   = alligatorObj.lips;
        const teeth_13 = alligatorObj.teeth;
        const jaw_21   = alligatorObj.jaw;

        this.entry_allow = (adxObj.adx > 20 && adxObj.adx > adxObj2.adx);

        if (current_open > bbObj.upper) {
            if (current_open > lips_8 && current_open > teeth_13 && current_open > jaw_21) {
                this.positionType = 'long';
            }
        } else if (current_open < bbObj.lower) {
            if (current_open < lips_8 && current_open < teeth_13 && current_open < jaw_21) {
                this.positionType = 'short';
            }
        } else {
            this.positionType = null;
        }

        consoleLogger.info(`${this.name} -- current_open: ${current_open}, positionType(bb): ${this.positionType}, entry_allow(adx): ${this.entry_allow}`);

        if (this.positionType == null || !this.entry_allow) return;

        const allocated = this.accountStatus.getAllocated();

        // ATR 기반 사이징
        const rawOrderSize = this.calculatePositionSize(current_open, atr, allocated);
        this.orderSize = Math.round(rawOrderSize * this.qtyMultiplier) / this.qtyMultiplier;

        this.exit_size_1 = Math.round((this.orderSize / 3) * this.qtyMultiplier) / this.qtyMultiplier;
        this.exit_size_2 = Math.round((this.orderSize / 3) * this.qtyMultiplier) / this.qtyMultiplier;
        this.exit_size_3 = Math.round((this.orderSize - this.exit_size_1 - this.exit_size_2) * this.qtyMultiplier) / this.qtyMultiplier;

        // ATR 스탑 가격 고정 (진입 시점)
        if (this.positionType === 'long') {
            this.atr_stop_price = Math.round((current_open - atr * this.atr_multiplier) * this.priceMultiplier) / this.priceMultiplier;
        } else {
            this.atr_stop_price = Math.round((current_open + atr * this.atr_multiplier) * this.priceMultiplier) / this.priceMultiplier;
        }

        this.openPrice = current_open;
        this.setNewOrderId();

        const orderParams = {
            category: 'linear',
            symbol: this.symbol,
            orderType: 'Market',
            qty: this.orderSize.toString(),
            side: this.positionType === 'long' ? 'Buy' : 'Sell',
            orderLinkId: this.orderId_open,
        };

        consoleLogger.order(`${this.name} open 주문 요청 !!`, orderParams);

        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', orderParams),
            `${this.name} open order`, 60000
        ).catch((e) => {
            fileLogger.error('open error:', e);
            consoleLogger.error('open error:', e);
            this.reset();
            this.open();
        });
    }

    async openOrderFilledCallback() {
        const data = await getKline(this.symbol, '240', 200);
        const alligatorObj = calculateAlligator(data, 0);

        const lips_8   = Math.round(alligatorObj.lips  * this.priceMultiplier) / this.priceMultiplier;
        const teeth_13 = Math.round(alligatorObj.teeth * this.priceMultiplier) / this.priceMultiplier;
        const jaw_21   = Math.round(alligatorObj.jaw   * this.priceMultiplier) / this.priceMultiplier;

        const prices = [lips_8, teeth_13, jaw_21];
        if (this.positionType === 'long') {
            prices.sort((a, b) => b - a);
        } else {
            prices.sort((a, b) => a - b);
        }

        this.exit_price_1 = prices[0];
        this.exit_price_2 = prices[1];
        this.exit_price_3 = prices[2];

        const side = this.positionType === 'long' ? 'Sell' : 'Buy';
        const triggerDirection = this.positionType === 'long' ? '2' : '1'; // 2:Fall, 1:Rise

        // ATR 스탑 (전체 수량, 고정 가격)
        const atrStopParams = {
            category: 'linear',
            symbol: this.symbol,
            side,
            qty: this.orderSize.toString(),
            triggerPrice: this.atr_stop_price.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: this.orderId_atr_stop,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.order(`${this.name} ATR 스탑 설정`, atrStopParams);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', atrStopParams),
            `${this.name} create atr_stop`, 60000
        );

        // Alligator 1차 익절
        const exit1Params = {
            category: 'linear',
            symbol: this.symbol,
            side,
            qty: this.exit_size_1.toString(),
            triggerPrice: this.exit_price_1.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: this.orderId_exit_1,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.order(`${this.name} 1차 청산 설정`, exit1Params);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit1Params),
            `${this.name} create exit1`, 60000
        );

        // Alligator 2차 익절
        const exit2Params = {
            category: 'linear',
            symbol: this.symbol,
            side,
            qty: this.exit_size_2.toString(),
            triggerPrice: this.exit_price_2.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: this.orderId_exit_2,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.order(`${this.name} 2차 청산 설정`, exit2Params);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit2Params),
            `${this.name} create exit2`, 60000
        );

        // Alligator 3차 익절
        const exit3Params = {
            category: 'linear',
            symbol: this.symbol,
            side,
            qty: this.exit_size_3.toString(),
            triggerPrice: this.exit_price_3.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: this.orderId_exit_3,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.order(`${this.name} 3차 청산 설정`, exit3Params);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit3Params),
            `${this.name} create exit3`, 60000
        );
    }

    async updateStop() {
        const data = await getKline(this.symbol, '240', 200);
        const alligatorObj = calculateAlligator(data, 0);

        const lips_8   = Math.round(alligatorObj.lips  * this.priceMultiplier) / this.priceMultiplier;
        const teeth_13 = Math.round(alligatorObj.teeth * this.priceMultiplier) / this.priceMultiplier;
        const jaw_21   = Math.round(alligatorObj.jaw   * this.priceMultiplier) / this.priceMultiplier;

        const prices = [lips_8, teeth_13, jaw_21];
        if (this.positionType === 'long') {
            prices.sort((a, b) => b - a);
        } else {
            prices.sort((a, b) => a - b);
        }

        this.exit_price_1 = prices[0];
        this.exit_price_2 = prices[1];
        this.exit_price_3 = prices[2];

        // ATR 스탑은 진입 시 고정 → amend 불필요
        // Alligator 익절만 매 캔들 amend
        if (this.exit_count < 1) {
            const amend1 = { category: 'linear', symbol: this.symbol, triggerPrice: this.exit_price_1.toString(), orderLinkId: this.orderId_exit_1 };
            consoleLogger.order(`${this.name} 1차 청산 amend`, amend1);
            runWithTimeout(() => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.amend', amend1), `${this.name} amend exit1`, 60000);
        }

        if (this.exit_count < 2) {
            const amend2 = { category: 'linear', symbol: this.symbol, triggerPrice: this.exit_price_2.toString(), orderLinkId: this.orderId_exit_2 };
            consoleLogger.order(`${this.name} 2차 청산 amend`, amend2);
            runWithTimeout(() => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.amend', amend2), `${this.name} amend exit2`, 60000);
        }

        if (this.exit_count < 3) {
            const amend3 = { category: 'linear', symbol: this.symbol, triggerPrice: this.exit_price_3.toString(), orderLinkId: this.orderId_exit_3 };
            consoleLogger.order(`${this.name} 3차 청산 amend`, amend3);
            runWithTimeout(() => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.amend', amend3), `${this.name} amend exit3`, 60000);
        }
    }

    async orderEventHandle(dataObj) {
        if (dataObj?.orderStatus !== 'Filled') return;

        addTradeLog('algo3_' + this.symbol, {
            ...dataObj,
            openPrice: this.openPrice,
            atr_stop_price: this.atr_stop_price,
            exit_price_1: this.exit_price_1,
            exit_price_2: this.exit_price_2,
            exit_price_3: this.exit_price_3,
        });

        consoleLogger.order(`${this.name} ${dataObj.orderLinkId} 체결 -- side: ${dataObj.side}, price: ${dataObj.price}, qty: ${dataObj.qty}, pnl: ${dataObj.closedPnl}`);

        if (dataObj.orderLinkId === this.orderId_open) {
            this.isOpenOrderFilled = true;
            await this.openOrderFilledCallback();
        }

        if (dataObj.orderLinkId === this.orderId_atr_stop) {
            // ATR 스탑 체결 → 전량 청산됨 → 남은 alligator 주문 취소
            await this.accountStatus.addPnl(dataObj?.closedPnl);
            this.cancelOrders([this.orderId_exit_1, this.orderId_exit_2, this.orderId_exit_3]);
            this.reset();
        }

        if (dataObj.orderLinkId === this.orderId_exit_1) {
            await this.accountStatus.addPnl(dataObj?.closedPnl);
            this.exit_count++;
        }

        if (dataObj.orderLinkId === this.orderId_exit_2) {
            await this.accountStatus.addPnl(dataObj?.closedPnl);
            this.exit_count++;
        }

        if (dataObj.orderLinkId === this.orderId_exit_3) {
            // 마지막 익절 → ATR 스탑 취소
            await this.accountStatus.addPnl(dataObj?.closedPnl);
            this.cancelOrders([this.orderId_atr_stop]);
            this.reset();
        }

        setTradeStatus(this.getTradeStatusDocId(), this.getState());

        sendTelegram(setMsgFormat({
            orderLinkId: dataObj?.orderLinkId,
            side: dataObj?.side,
            closedPnl: dataObj?.closedPnl,
        }, this.name));
    }

    cancelOrders(orderLinkIds) {
        for (const orderLinkId of orderLinkIds) {
            if (!orderLinkId) continue;
            // ATR stop / alligator exits 모두 trigger 주문 → orderFilter: 'StopOrder' 필수
            const params = { category: 'linear', symbol: this.symbol, orderLinkId, orderFilter: 'StopOrder' };
            runWithTimeout(
                () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.cancel', params),
                `${this.name} cancel ${orderLinkId}`, 60000
            ).catch(e => consoleLogger.warn(`${this.name} cancel ${orderLinkId} 실패:`, e));
        }
    }

    reset() {
        this.orderSize = 0.0;
        this.openPrice = 0.0;
        this.atr_stop_price = 0.0;

        this.exit_size_1 = 0.0;
        this.exit_size_2 = 0.0;
        this.exit_size_3 = 0.0;

        this.exit_price_1 = 0.0;
        this.exit_price_2 = 0.0;
        this.exit_price_3 = 0.0;

        this.positionType = null;
        this.entry_allow = false;
        this.exit_count = 0;
        this.isOpenOrderFilled = false;

        this.orderId_open = null;
        this.orderId_atr_stop = null;
        this.orderId_exit_1 = null;
        this.orderId_exit_2 = null;
        this.orderId_exit_3 = null;
    }

    setNewOrderId() {
        const ts = new Date().getTime();
        this.orderId_open     = `${this.name}_open_${ts}`;
        this.orderId_atr_stop = `${this.name}_atr_stop_${ts}`;
        this.orderId_exit_1   = `${this.name}_exit1_${ts}`;
        this.orderId_exit_2   = `${this.name}_exit2_${ts}`;
        this.orderId_exit_3   = `${this.name}_exit3_${ts}`;
    }

    calculatePositionSize(entry_price, atr, allocated) {
        const max_loss = allocated * this.max_risk_per_trade;
        const atr_stop_distance = atr * this.atr_multiplier;
        const qty_by_risk = max_loss / atr_stop_distance;
        const max_qty = (allocated * this.leverage) / entry_price;
        return Math.min(qty_by_risk, max_qty);
    }

    getTradeStatusDocId() {
        return `algo3_${this.name}_trade_status`;
    }

    // accountStatus 참조는 Firestore에 저장하지 않음
    getState() {
        const { accountStatus, ...state } = this;
        return state;
    }

    async scheduleFunc() {
        try {
            if (!this.isOpenOrderFilled) {
                await this.open();
            } else {
                await this.updateStop();
            }
        } catch (error) {
            consoleLogger.error('scheduleFunc error:', error);
            fileLogger.error('scheduleFunc error:', error);
        }
    }
}
