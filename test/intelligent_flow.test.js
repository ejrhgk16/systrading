
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { ws_client } from '../common/client.js';
import algo2 from '../alogs_crypto/algo2Class.js';
import { fileLogger, consoleLogger } from '../common/logger.js';
import { auth } from '../db/firebaseConfig.js';
import { signInWithEmailAndPassword } from "firebase/auth";
import * as util from '../common/util.js'; // Mocking을 위해 모듈 전체를 import

// ====================================================================
// |         지능형 데이터 조작을 통한 전체 흐름 테스트             |
// |   - 첫 호출에는 진입용 데이터, 두 번째 호출에는 정상 데이터를 반환  |
// ====================================================================
consoleLogger.warn('🚨 지능형 흐름 테스트: 실제 주문이 발생합니다. 테스트 계정 사용을 권장합니다.');

// --- 데이터 조작(Mocking) 설정 ---
const originalGetKline = util.getKline; // 원래 함수 저장
let btcKlineCallCount = 0;

// getKline 함수를 대체할 Mock 함수
util.getKline = (symbol, interval, limit) => {
  if (symbol === 'BTCUSDT') {
    btcKlineCallCount++;
    if (btcKlineCallCount === 1) {
      consoleLogger.info(`[Smart Mock] getKline 1번째 호출. 진입을 위해 조작된 데이터를 반환합니다.`);
      const fakeCandles = Array.from({ length: 125 }, (_, i) => 
        [Date.now() - (125 - i) * 60000, 30000 + i * 10, 30020 + i * 10, 29995 + i * 10, 30015 + i * 10, 100, 3000000]
      );
      fakeCandles[fakeCandles.length - 1][4] = 99999; // 볼린저밴드 상단 돌파 강제
      return Promise.resolve(fakeCandles);
    }
    consoleLogger.info(`[Smart Mock] getKline ${btcKlineCallCount}번째 호출. 익절가 계산을 위해 정상 범위의 데이터를 반환합니다.`);
    const normalCandles = Array.from({ length: 125 }, (_, i) => {
      const price = 68000 + Math.sin(i / 10) * 100;
      return [Date.now() - (125-i)*60000, price, price+50, price-50, price, 100, 6800000]
    });
    return Promise.resolve(normalCandles);
  }
  return originalGetKline(symbol, interval, limit); // 다른 심볼은 원래 함수 호출
};
// -------------------------------------

const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

async function testMainFlow() {
  // 1. Firebase 인증
  try {
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    consoleLogger.info("Firebase 로그인 성공!");
  } catch (error) {
    consoleLogger.error("Firebase 인증 실패. 테스트를 중단합니다.", error);
    return;
  }

  // 2. algo2 객체 생성 및 초기화
  const algo2Objs = symbols.reduce((acc, symbol) => {
    acc[symbol] = new algo2(symbol);
    return acc;
  }, {});
  await Promise.all(Object.values(algo2Objs).map(obj => obj.set()));

  // 3. 웹소켓 연결 및 이벤트 리스너 설정
  ws_client.subscribeV5('order', 'linear');
  await ws_client.connectWSAPI();

  ws_client.on('update', (res) => {
    if (res?.topic === "order") {
      const data = res?.data || [];
      data.forEach(element => {
        if (element.symbol && algo2Objs[element.symbol]) {
          consoleLogger.info(`[WebSocket Event] ${element.symbol}의 주문 업데이트 수신`);
          algo2Objs[element.symbol].orderEventHandle(element);
        }
      });
    }
  });

  ws_client.on('response', (response) => consoleLogger.log('Websocket Response:', response));
  ws_client.on('close', () => consoleLogger.warn('Websocket connection closed.'));
  ws_client.on('exception', (err) => consoleLogger.error('Websocket Exception:', err));

  // 4. 강제 진입을 위해 scheduleFunc 즉시 실행
  consoleLogger.info("--- [테스트] BTCUSDT 강제 진입을 위해 scheduleFunc를 즉시 실행합니다. ---");
  try {
    await algo2Objs['BTCUSDT'].scheduleFunc();
    consoleLogger.info("--- [테스트] 진입 주문 전송 시도 완료. 이제 웹소켓의 체결 이벤트를 기다립니다... ---");
  } catch (error) {
    consoleLogger.error("즉시 실행 중 오류 발생:", error);
  }

  // 60초 후 테스트 자동 종료
  setTimeout(() => {
    consoleLogger.info("--- 테스트 시간이 만료되어 자동으로 종료합니다. ---");
    process.exit(0);
  }, 60000);
}

testMainFlow();
