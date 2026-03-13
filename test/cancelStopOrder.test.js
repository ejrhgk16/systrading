/**
 * Stop Order (Trigger Order) 취소 방식 비교 테스트
 *
 * 목적:
 *   - 주문 A: orderFilter 없이 cancel → 실제로 취소되는지 확인
 *   - 주문 B: orderFilter: 'StopOrder' 로 cancel → 취소 확인
 *   - 두 결과를 비교해서 어느 방식이 필요한지 검증
 *
 * 실행: node test/cancelStopOrder.test.js
 *
 * WS 응답이 undefined인 이유:
 *   sendWSAPIRequest()의 Promise는 응답 데이터를 resolve하지 않음.
 *   실제 응답은 ws_client.on('response', ...) 이벤트로만 수신 가능.
 *   → 취소 성공 여부는 REST getActiveOrders로 확인.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { rest_client, ws_client, WS_KEY_MAP } from '../common/client.js';
import { runWithTimeout } from '../common/util.js';
import { consoleLogger } from '../common/logger.js';
import { auth } from '../db/firebaseConfig.js';
import { signInWithEmailAndPassword } from 'firebase/auth';

// ===== 설정 =====
const SYMBOL = 'ETHUSDT';
// ================

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCurrentPrice() {
    const res = await rest_client.getTickers({ category: 'linear', symbol: SYMBOL });
    return parseFloat(res.result.list[0].lastPrice);
}

async function getStopOrderStatus(orderLinkId) {
    const res = await rest_client.getActiveOrders({
        category: 'linear',
        symbol: SYMBOL,
        orderLinkId,
        orderFilter: 'StopOrder',
    });
    return res.result?.list?.[0]?.orderStatus ?? null;
}

async function placeStopOrder(orderLinkId, triggerPrice, qty) {
    const params = {
        category: 'linear',
        symbol: SYMBOL,
        side: 'Buy',
        qty: qty.toString(),
        triggerPrice: triggerPrice.toString(),
        triggerDirection: '1',
        triggerBy: 'MarkPrice',
        orderType: 'Market',
        reduceOnly: false,
        orderLinkId,
        timeInForce: 'GoodTillCancel',
    };
    await runWithTimeout(
        () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', params),
        `create ${orderLinkId}`, 15000
    );
}

async function cancelStopOrder(orderLinkId, useOrderFilter) {
    const params = {
        category: 'linear',
        symbol: SYMBOL,
        orderLinkId,
        ...(useOrderFilter ? { orderFilter: 'StopOrder' } : {}),
    };
    try {
        await runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.cancel', params),
            `cancel ${orderLinkId}`, 15000
        );
        return true;
    } catch (e) {
        consoleLogger.warn(`cancel 오류 (orderLinkId: ${orderLinkId}):`, e?.message ?? e);
        return false;
    }
}

async function run() {
    consoleLogger.info('=== Stop Order Cancel 비교 테스트 시작 ===');

    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    consoleLogger.info('Firebase 로그인 성공.');

    await ws_client.connectWSAPI();
    consoleLogger.info('WS API 연결 완료.');

    // WS 응답 확인용 리스너
    ws_client.on('response', (res) => {
        consoleLogger.info('[WS response 이벤트]', JSON.stringify(res));
    });

    const currentPrice = await getCurrentPrice();
    const triggerPrice = Math.round(currentPrice * 1.3 * 100) / 100;
    const qty = '0.01';
    const ts = new Date().getTime();

    const idA = `test_cancel_nofilter_${ts}`;
    const idB = `test_cancel_withfilter_${ts}`;

    consoleLogger.info(`현재가: ${currentPrice}  |  트리거 가격: ${triggerPrice} (현재가 130%)`);
    consoleLogger.info(`주문A (orderFilter 없이 cancel): ${idA}`);
    consoleLogger.info(`주문B (orderFilter:'StopOrder' cancel): ${idB}`);

    // ── 주문 A, B 동시 생성 ──────────────────────────────────────────
    consoleLogger.info('\n[STEP 1] 주문 A, B 생성...');
    await placeStopOrder(idA, triggerPrice, qty);
    await placeStopOrder(idB, triggerPrice, qty);
    await sleep(2000);

    const statusA_before = await getStopOrderStatus(idA);
    const statusB_before = await getStopOrderStatus(idB);
    consoleLogger.info(`[STEP 1] 생성 후 상태 — A: ${statusA_before}, B: ${statusB_before}`);

    if (!statusA_before || !statusB_before) {
        consoleLogger.error('주문 생성 실패. 종료.');
        process.exit(1);
    }

    // ── 주문 A: orderFilter 없이 cancel ─────────────────────────────
    consoleLogger.info('\n[STEP 2] 주문A — orderFilter 없이 cancel 시도...');
    await cancelStopOrder(idA, false);
    await sleep(2000);

    const statusA_after = await getStopOrderStatus(idA);
    const cancelledA = (statusA_after === 'Deactivated' || statusA_after === 'Cancelled' || statusA_after === null);
    consoleLogger.info(`[STEP 2] 주문A 상태: ${statusA_after ?? '(조회 불가/없음)'} → 취소 ${cancelledA ? '성공 ✓' : '실패 ✗'}`);

    // ── 주문 B: orderFilter: 'StopOrder' 로 cancel ──────────────────
    consoleLogger.info('\n[STEP 3] 주문B — orderFilter: StopOrder 로 cancel 시도...');
    await cancelStopOrder(idB, true);
    await sleep(2000);

    const statusB_after = await getStopOrderStatus(idB);
    const cancelledB = (statusB_after === 'Deactivated' || statusB_after === 'Cancelled' || statusB_after === null);
    consoleLogger.info(`[STEP 3] 주문B 상태: ${statusB_after ?? '(조회 불가/없음)'} → 취소 ${cancelledB ? '성공 ✓' : '실패 ✗'}`);

    // ── 결과 요약 ────────────────────────────────────────────────────
    consoleLogger.info('\n========= 결과 요약 =========');
    consoleLogger.info(`orderFilter 없이 cancel     → ${cancelledA ? '취소 성공' : '취소 실패'} (status: ${statusA_after})`);
    consoleLogger.info(`orderFilter: StopOrder cancel → ${cancelledB ? '취소 성공' : '취소 실패'} (status: ${statusB_after})`);

    if (cancelledA && cancelledB) {
        consoleLogger.info('→ 두 방식 모두 작동. orderFilter 없어도 취소 가능.');
    } else if (!cancelledA && cancelledB) {
        consoleLogger.info('→ orderFilter: StopOrder 가 반드시 필요함.');
    } else if (cancelledA && !cancelledB) {
        consoleLogger.warn('→ 예상치 못한 결과. API 동작 확인 필요.');
    } else {
        consoleLogger.error('→ 두 방식 모두 실패. 환경 또는 권한 문제 확인.');
    }

    consoleLogger.info('=== 테스트 완료 ===');
    process.exit(0);
}

run().catch(e => {
    consoleLogger.error('테스트 오류:', e);
    process.exit(1);
});
