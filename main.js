import dotenv from 'dotenv';
dotenv.config({ override: true });

import {rest_client, ws_client, ws_api_client, WS_KEY_MAP} from './common/client.js';
import alogo2 from './alogs_crypto/alog2Class.js';
import { fileLogger, consoleLogger } from './common/logger.js';
import { getSpxVixData } from './alogs_finance/alog1Class_spx_vix.js';
import { runWithTimeout, scheduleWithWatchdog } from './common/util.js';

import { auth } from './db/firebaseConfig.js';
import { signInWithEmailAndPassword } from "firebase/auth";


const symbols = ['BTCUSDT', 'ETHUSDT'];

const alog2Objs_bb2 = symbols.reduce((acc, symbol) => {
  acc[symbol] = new alogo2(symbol, 2);
  return acc;
}, {});



async function main() {

  consoleLogger.info("env_version : ", process.env.env_ver)

  try {
    consoleLogger.info("Firebase 로그인을 시도합니다...");
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    consoleLogger.info("Firebase 로그인 성공.");
  } catch (error) {
    consoleLogger.error("Firebase 로그인 실패:", error);
    process.exit(1);
  }

  await Promise.all(Object.values(alog2Objs_bb2).map(obj => obj.set()));

  scheduleWithWatchdog('1 0 */4 * * *', () =>
    runWithTimeout(
      () => Promise.all(Object.values(alog2Objs_bb2).map(obj => obj.scheduleFunc())),
      '4시간 캔들용 작업'
    )
  );

  scheduleWithWatchdog('30 21 * * *', () =>
    runWithTimeout(() => getSpxVixData(), 'getSpxVixData 작업')
  );

  ws_client.subscribeV5('order', 'linear');
  await ws_client.connectWSAPI();
}

main();


ws_client.on('update', async (res) => {
  try {
    if (res?.topic !== 'order') return;
    res.data.forEach(element => {
      const orderLinkId_alog2_bb2 = `alog2_${element.symbol}_bb2`;
      if ((element.orderLinkId).indexOf(orderLinkId_alog2_bb2) > -1) {
        const obj = alog2Objs_bb2[element.symbol];
        if (obj) {
          obj.orderEventHandle(element);
        } else {
          consoleLogger.warn(`수신된 주문 이벤트의 심볼(${element.symbol})에 해당하는 객체를 찾을 수 없습니다.`);
        }
      }
    });
  } catch (e) {
    consoleLogger.error('ws_client \'update\' 이벤트 처리 중 오류 발생:', e);
    fileLogger.error('ws_client \'update\' 이벤트 처리 중 오류 발생:', e);
  }
});

ws_client.on('close', (event) => {
  consoleLogger.warn('ws connection closed. Event:', event);
  fileLogger.warn('ws connection closed. Event:', event);
});

ws_client.on('error', (err) => {
  consoleLogger.error('ws connection error:', err);
  fileLogger.error('ws connection error:', err);
});

ws_client.on('open', ({ wsKey }) => {
  consoleLogger.info(`ws connection open for ${wsKey}`);
});

ws_client.on('response', () => {});

ws_client.on('reconnect', ({ wsKey }) => {
  const msg = `ws automatically reconnecting.... ${wsKey}`;
  consoleLogger.info(msg);
  fileLogger.info(msg);
});

ws_client.on('reconnected', ({ wsKey }) => {
  const msg = `ws has reconnected ${wsKey}`;
  consoleLogger.info(msg);
  fileLogger.info(msg);
});
