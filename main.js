import dotenv from 'dotenv';
dotenv.config({ override: true });

import { ws_client } from './common/client.js';
import algo3 from './alogs_crypto/algo3Class.js';
import Algo3AccountStatus from './account/algo3AccountStatus.js';
import { fileLogger, consoleLogger } from './common/logger.js';
import { getSpxVixData } from './alogs_tradifi/algo1Class_spx_vix.js';
import { Algo2QqqGld } from './alogs_tradifi/algo2Class_qqq_gld.js';
import { runWithTimeout, scheduleWithWatchdog, CRON_JOB_TIMEOUT_MS } from './common/util.js';
import { initCLI } from './common/cli.js';

import { auth } from './db/firebaseConfig.js';
import { signInWithEmailAndPassword } from "firebase/auth";


const algo3Symbols = ['BTCUSDT', 'ETHUSDT'];
const algo3AccountStatus = new Algo3AccountStatus(algo3Symbols.length);
const algo3Objs = algo3Symbols.reduce((acc, symbol) => {
  acc[symbol] = new algo3(symbol, algo3AccountStatus);
  return acc;
}, {});

const qqgGldAlgo = new Algo2QqqGld();


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

  await algo3AccountStatus.load();
  await Promise.all(Object.values(algo3Objs).map(obj => obj.set()));
  await qqgGldAlgo.set();

  scheduleWithWatchdog('1 0 */4 * * *', () =>
    runWithTimeout(
      () => Promise.all(Object.values(algo3Objs).map(obj => obj.scheduleFunc())),
      '4시간 캔들용 작업'
    )
  );

  // scheduleWithWatchdog('30 21 * * *', () =>
  //   runWithTimeout(() => getSpxVixData(), 'getSpxVixData 작업')
  // );

  // QQQ+GLD 트렌치 전략: 매일 UTC 22:00 (미국장 마감 후)
  scheduleWithWatchdog('30 21 * * *', () =>
    runWithTimeout(() => qqgGldAlgo.scheduleFunc(), 'QQQ+GLD 트렌치', CRON_JOB_TIMEOUT_MS)
  );

  // CLI 초기화 (ta2=tradifi algo2, qg=QQQ+GLD 단축어)
  initCLI({ ta2: qqgGldAlgo, qg: qqgGldAlgo });

  ws_client.subscribeV5('order', 'linear');
  await ws_client.connectWSAPI();
}

main();


ws_client.on('update', async (res) => {
  try {
    if (res?.topic !== 'order') return;
    res.data.forEach(element => {
      const orderLinkId_algo3 = `algo3_${element.symbol}_bb`;
      if (element.orderLinkId.indexOf(orderLinkId_algo3) > -1) {
        const obj = algo3Objs[element.symbol];
        if (obj) obj.orderEventHandle(element);
        else consoleLogger.warn(`algo3: 심볼(${element.symbol})에 해당하는 객체 없음`);
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
