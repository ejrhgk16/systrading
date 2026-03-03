
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { ws_client } from '../common/client.js';
import algo2 from '../alogs_crypto/algo2Class.js';
import { consoleLogger } from '../common/logger.js';
import { auth } from '../db/firebaseConfig.js';
import { signInWithEmailAndPassword } from "firebase/auth";

// ====================================================================
// |     지표 조작(calculateBB)을 통한 가장 안정적인 흐름 테스트      |
// ====================================================================
consoleLogger.warn('🚨 최종 흐름 테스트: 실제 주문이 발생합니다. 테스트 계정 사용을 권장합니다.');

// 사용자 요청에 따라 SOL, XRP만 테스트하도록 수정합니다.
const symbols = ["SOLUSDT", "XRPUSDT"];

async function testMainFlow() {
  // 1. Firebase 인증
  try {
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    consoleLogger.info("Firebase 로그인 성공!");
  } catch (error) {
    consoleLogger.error('Firebase 인증 실패:', error); return; 
  }

  // 2. algo2 객체 생성 및 초기화
  const algo2Objs = symbols.reduce((acc, symbol) => ({ ...acc, [symbol]: new algo2(symbol) }), {});
  await Promise.all(Object.values(algo2Objs).map(obj => obj.set()));

  // 3. 웹소켓 연결 및 이벤트 리스너 설정
  ws_client.subscribeV5('execution', 'linear');
  ws_client.subscribeV5('order', 'linear');

  ws_client.on('update', (res) => {
    if (res?.topic === "order") {
      (res?.data || []).forEach(element => {
        if (element.symbol && algo2Objs[element.symbol]) {
          consoleLogger.info(`[WebSocket Event] ${element.symbol} 주문 업데이트 수신`);
          algo2Objs[element.symbol].orderEventHandle(element);
        }
      });
    }
  });

  ws_client.on('response', (response) => {
    consoleLogger.info('Websocket Response:', response);
    if(response?.req_id=="execution,order"){
      try {
        consoleLogger.info("--- [테스트] SOLUSDT 강제 진입을 위해 scheduleFunc를 즉시 실행합니다. ---");
        algo2Objs['SOLUSDT'].open_test();
        consoleLogger.info("--- [테스트] 진입 주문 전송 시도 완료. 웹소켓 체결 이벤트를 기다립니다... ---");
      } catch (error) {
        consoleLogger.error('즉시 실행 중 오류 발생:', error);
      }
    }
  });

  ws_client.on('close', () => consoleLogger.warn('Websocket connection closed.'));
  ws_client.on('exception', (err) => consoleLogger.error('Websocket Exception:', err));
  await ws_client.connectWSAPI();

  // 90초 후 테스트 자동 종료
  setTimeout(() => {
    consoleLogger.info("--- 테스트 시간이 만료되어 자동으로 종료합니다. ---");
    process.exit(0);
  }, 90000);
}

testMainFlow();
