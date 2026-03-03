import dotenv from 'dotenv';
dotenv.config({ override: true });

import { rest_client, ws_client, WS_KEY_MAP } from '../common/client.js';
import { getKline, runWithTimeout } from '../common/util.js';
import { calculateAlligator } from '../common/indicatior.js';
import { getTradeStatus, setTradeStatus } from '../db/firestoreFunc.js';
import { consoleLogger } from '../common/logger.js';
import { auth } from '../db/firebaseConfig.js';
import { signInWithEmailAndPassword } from 'firebase/auth';

//firebase status에서 positiontype, openorderfilled 확인

// ===== 설정 변수 =====
const SYMBOL = 'ETHUSDT';
const STD = 2;
const PLACE_EXIT1 = true;
const PLACE_EXIT2 = true;
const PLACE_EXIT3 = true;
// ====================

const name = `alog2_${SYMBOL}_bb${STD}`;
const docId = `algo2_${name}_trade_status`;

const priceMultiplier = Math.pow(10, Number(process.env[SYMBOL + '_decimal_price']));
const qtyMultiplier  = Math.pow(10, Number(process.env[SYMBOL + '_decimal_qty']));

async function run() {
    consoleLogger.info('Firebase 로그인 시도...');
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    consoleLogger.info('Firebase 로그인 성공.');

    const state = await getTradeStatus(docId);
    if (!state) {
        consoleLogger.error(`Firestore 상태 없음: ${docId}`);
        process.exit(1);
    }
    consoleLogger.info('Firestore 상태 로드:', JSON.stringify(state, null, 2));

    // 실제 포지션 조회 (Bybit API)
    const posRes = await rest_client.getPositionInfo({ category: 'linear', symbol: SYMBOL });
    const pos = posRes.result?.list?.[0];

    if (!pos || parseFloat(pos.size) === 0) {
        consoleLogger.error('포지션 없음. Bybit에 열린 포지션이 없습니다.');
        process.exit(1);
    }

    consoleLogger.info(`포지션 조회 - size: ${pos.size}, side: ${pos.side}, avgPrice: ${pos.avgPrice}`);

    const positionType = pos.side === 'Buy' ? 'long' : 'short';
    const orderSize = parseFloat(pos.size);

    const exit_size_1 = Math.round((orderSize / 3) * qtyMultiplier) / qtyMultiplier;
    const exit_size_2 = Math.round((orderSize / 3) * qtyMultiplier) / qtyMultiplier;
    const exit_size_3 = Math.round((orderSize - exit_size_1 - exit_size_2) * qtyMultiplier) / qtyMultiplier;

    consoleLogger.info(`수량 계산 - total: ${orderSize}, exit1: ${exit_size_1}, exit2: ${exit_size_2}, exit3: ${exit_size_3}`);

    // 지표 계산
    const data = await getKline(SYMBOL, '240', 200);
    const alligatorObj = calculateAlligator(data, 0);

    const lips_8   = Math.round(alligatorObj.lips  * priceMultiplier) / priceMultiplier;
    const teeth_13 = Math.round(alligatorObj.teeth * priceMultiplier) / priceMultiplier;
    const jaw_21   = Math.round(alligatorObj.jaw   * priceMultiplier) / priceMultiplier;

    const prices = [lips_8, teeth_13, jaw_21];
    if (positionType === 'long') {
        prices.sort((a, b) => b - a); // 내림차순 (높은 가격부터)
    } else {
        prices.sort((a, b) => a - b); // 오름차순 (낮은 가격부터)
    }

    const exit_price_1 = prices[0];
    const exit_price_2 = prices[1];
    const exit_price_3 = prices[2];

    consoleLogger.info(`계산된 청산가 - 1차: ${exit_price_1}, 2차: ${exit_price_2}, 3차: ${exit_price_3}`);

    const side = positionType === 'long' ? 'Sell' : 'Buy';
    const triggerDirection = positionType === 'long' ? '2' : '1'; // 2: Fall, 1: Rise

    const ts = new Date().getTime();
    const orderId_exit_1 = `${name}_exit1_${ts}`;
    const orderId_exit_2 = `${name}_exit2_${ts}`;
    const orderId_exit_3 = `${name}_exit3_${ts}`;

    consoleLogger.info(`새 주문 ID - exit1: ${orderId_exit_1}, exit2: ${orderId_exit_2}, exit3: ${orderId_exit_3}`);

    await ws_client.connectWSAPI();

    if (PLACE_EXIT1) {
        const exit1Params = {
            category: 'linear',
            symbol: SYMBOL,
            side,
            qty: exit_size_1.toString(),
            triggerPrice: exit_price_1.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: orderId_exit_1,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.info('1차 청산 주문 요청:', exit1Params);
        await runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit1Params),
            `${name} create exit1`, 60000
        );
    }

    if (PLACE_EXIT2) {
        const exit2Params = {
            category: 'linear',
            symbol: SYMBOL,
            side,
            qty: exit_size_2.toString(),
            triggerPrice: exit_price_2.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: orderId_exit_2,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.info('2차 청산 주문 요청:', exit2Params);
        await runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit2Params),
            `${name} create exit2`, 60000
        );
    }

    if (PLACE_EXIT3) {
        const exit3Params = {
            category: 'linear',
            symbol: SYMBOL,
            side,
            qty: exit_size_3.toString(),
            triggerPrice: exit_price_3.toString(),
            triggerDirection,
            triggerBy: 'MarkPrice',
            orderType: 'Market',
            reduceOnly: true,
            orderLinkId: orderId_exit_3,
            timeInForce: 'GoodTillCancel',
        };
        consoleLogger.info('3차 청산 주문 요청:', exit3Params);
        await runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit3Params),
            `${name} create exit3`, 60000
        );
    }

    // Firebase 상태 저장
    const updatedState = {
        ...state,
        positionType,
        orderSize,
        exit_size_1,
        exit_size_2,
        exit_size_3,
        exit_price_1,
        exit_price_2,
        exit_price_3,
        isOpenOrderFilled: true,
        orderId_exit_1,
        orderId_exit_2,
        orderId_exit_3,
    };
    await setTradeStatus(docId, updatedState);
    consoleLogger.info('Firestore 상태 업데이트 완료:', JSON.stringify(updatedState, null, 2));

    process.exit(0);
}

run().catch(e => {
    consoleLogger.error('stopOrder 실행 오류:', e);
    process.exit(1);
});
