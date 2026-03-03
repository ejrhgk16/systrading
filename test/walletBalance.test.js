/**
 * totalWalletBalance 동작 검증 테스트
 * - 포지션 진입 전/후/미실현손익 발생/청산 후 각 시점 비교
 * - 목적: totalWalletBalance에 미실현 손익이 포함되는지 확인
 *
 * 실행: node test/walletBalance.test.js
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { rest_client } from '../common/client.js';
import { consoleLogger } from '../common/logger.js';

// ===== 설정 =====
const SYMBOL = 'ETHUSDT';  // 최소 수량이 작은 심볼
const QTY = '0.01';        // 최소 수량 (~$20 수준)
const WAIT_MS = 8000;      // 미실현 손익 발생 대기 시간 (ms)
// ================

function printBalance(label, account) {
    consoleLogger.info(`\n========== ${label} ==========`);
    consoleLogger.info(`totalWalletBalance  : ${account.totalWalletBalance}`);
    consoleLogger.info(`totalEquity         : ${account.totalEquity}`);
    consoleLogger.info(`totalMarginBalance  : ${account.totalMarginBalance}`);
    consoleLogger.info(`totalPerpUPL        : ${account.totalPerpUPL}`);
    consoleLogger.info(`totalAvailableBalance: ${account.totalAvailableBalance}`);
    consoleLogger.info(`totalInitialMargin  : ${account.totalInitialMargin}`);
}

async function getBalance() {
    const res = await rest_client.getWalletBalance({ accountType: 'UNIFIED' });
    return res.result.list[0];
}

async function wait(ms) {
    consoleLogger.info(`${ms / 1000}초 대기 중...`);
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    try {
        // 1. 진입 전
        const before = await getBalance();
        printBalance('1. 진입 전', before);

        // 2. 소량 매수
        consoleLogger.info(`\n>>> ${SYMBOL} ${QTY} 시장가 매수`);
        const buyRes = await rest_client.submitOrder({
            category: 'linear',
            symbol: SYMBOL,
            side: 'Buy',
            orderType: 'Market',
            qty: QTY,
        });
        consoleLogger.info('매수 결과:', buyRes.result);

        // 3. 진입 직후
        const afterEntry = await getBalance();
        printBalance('2. 진입 직후 (미실현손익 ≈ 0)', afterEntry);

        // 4. 가격 변동 대기
        await wait(WAIT_MS);

        // 5. 미실현 손익 발생 후
        const duringPos = await getBalance();
        printBalance(`3. ${WAIT_MS / 1000}초 후 (미실현손익 발생)`, duringPos);

        // 6. 전량 청산
        consoleLogger.info(`\n>>> ${SYMBOL} 전량 시장가 청산`);
        const sellRes = await rest_client.submitOrder({
            category: 'linear',
            symbol: SYMBOL,
            side: 'Sell',
            orderType: 'Market',
            qty: QTY,
            reduceOnly: true,
        });
        consoleLogger.info('청산 결과:', sellRes.result);

        // 7. 청산 후
        await wait(2000);
        const afterClose = await getBalance();
        printBalance('4. 청산 후', afterClose);

        // 8. 비교 요약
        consoleLogger.info('\n========== 비교 요약 ==========');
        consoleLogger.info('항목                  | 진입전    | 진입직후  | 손익발생후 | 청산후');
        consoleLogger.info('----------------------|-----------|-----------|------------|-------');
        consoleLogger.info(`totalWalletBalance    | ${before.totalWalletBalance} | ${afterEntry.totalWalletBalance} | ${duringPos.totalWalletBalance} | ${afterClose.totalWalletBalance}`);
        consoleLogger.info(`totalPerpUPL          | ${before.totalPerpUPL} | ${afterEntry.totalPerpUPL} | ${duringPos.totalPerpUPL} | ${afterClose.totalPerpUPL}`);
        consoleLogger.info(`totalEquity           | ${before.totalEquity} | ${afterEntry.totalEquity} | ${duringPos.totalEquity} | ${afterClose.totalEquity}`);

        consoleLogger.info('\n========== 결론 ==========');
        const walletChangedDuringPos = before.totalWalletBalance !== duringPos.totalWalletBalance;
        if (walletChangedDuringPos) {
            consoleLogger.warn('⚠ totalWalletBalance가 미실현 손익에 따라 변함 → 사이징 기준으로 부적합');
        } else {
            consoleLogger.info('✓ totalWalletBalance는 미실현 손익 무관하게 유지됨 → 사이징 기준으로 적합');
        }

    } catch (e) {
        consoleLogger.error('테스트 오류:', e);
    }

    process.exit(0);
}

run();
