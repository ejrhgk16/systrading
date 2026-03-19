import dotenv from 'dotenv';
dotenv.config({ override: true });

import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../db/firebaseConfig.js';
import { ws_client, rest_client } from '../common/client.js';
import { consoleLogger } from '../common/logger.js';
import algo3 from '../alogs_crypto/algo3Class.js';

const mockAccountStatus = {
    getAllocated: () => 10000,
    addPnl: async (pnl) => {},
};

async function run() {
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    ws_client.subscribeV5('order', 'linear');
    await ws_client.connectWSAPI();

    const algo = new algo3('BTCUSDT', mockAccountStatus, 2);
    await algo.set();

    // 포지션 보유 중 상태로 강제 세팅
    const remainingQty = 0.016; // 실제 남아있는 포지션 수량 (BTC)

    algo.isOpenOrderFilled = true;
    algo.positionType = 'long';
    algo.orderSize = remainingQty;
    algo.exit_size_1 = Math.round((remainingQty / 3) * algo.qtyMultiplier) / algo.qtyMultiplier;
    algo.exit_size_2 = Math.round((remainingQty / 3) * algo.qtyMultiplier) / algo.qtyMultiplier;
    algo.exit_size_3 = Math.round((remainingQty - algo.exit_size_1 - algo.exit_size_2) * algo.qtyMultiplier) / algo.qtyMultiplier;
    algo.exit_count = 1; // 1차 이미 체결된 상태

    // Bybit에 실제 걸려있는 StopOrder 조회 → orderLinkId 매핑
    const openOrders = await rest_client.getActiveOrders({ category: 'linear', symbol: 'BTCUSDT', orderFilter: 'StopOrder' });
    consoleLogger.info('Bybit 실제 StopOrder 목록:', openOrders?.result?.list?.map(o => ({ orderLinkId: o.orderLinkId, qty: o.qty, triggerPrice: o.triggerPrice })));

    const stopOrders = openOrders?.result?.list ?? [];
    const atrStop = stopOrders.find(o => o.orderLinkId?.includes('atr_stop'));
    const exit2   = stopOrders.find(o => o.orderLinkId?.includes('exit2'));
    const exit3   = stopOrders.find(o => o.orderLinkId?.includes('exit3'));

    algo.setNewOrderId(); // 새 진입용 ID 생성 (open/atr_stop)
    if (atrStop) algo.orderId_atr_stop = atrStop.orderLinkId;
    if (exit2)   algo.orderId_exit_2   = exit2.orderLinkId;
    if (exit3)   algo.orderId_exit_3   = exit3.orderLinkId;

    consoleLogger.info('updateStop() 호출 전 상태:', {
        exit_count: algo.exit_count,
        orderId_exit_2: algo.orderId_exit_2,
        orderId_exit_3: algo.orderId_exit_3,
    });

    // updateStop 실행 — RSI > 70이면 resetExitOrders 트리거
    await algo.updateStop();

    consoleLogger.info('updateStop() 호출 후 상태:', {
        exit_count: algo.exit_count,
        orderId_exit_1: algo.orderId_exit_1,
        orderId_exit_2: algo.orderId_exit_2,
        orderId_exit_3: algo.orderId_exit_3,
        exit_size_1: algo.exit_size_1,
        exit_size_2: algo.exit_size_2,
        exit_size_3: algo.exit_size_3,
    });

    setTimeout(() => process.exit(0), 3000);
}

run().catch(e => { consoleLogger.error(e); process.exit(1); });
