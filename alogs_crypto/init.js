import algo3 from './algo3Class.js';
import Algo3AccountStatus from '../account/algo3AccountStatus.js';
import { ws_client } from '../common/client.js';
import { fileLogger, consoleLogger } from '../common/logger.js';
import { runWithTimeout, scheduleWithWatchdog } from '../common/util.js';

export async function initCrypto() {
  const algo3Symbols = ['BTCUSDT', 'ETHUSDT'];
  const algo3AccountStatus = new Algo3AccountStatus(algo3Symbols.length);
  const algo3Objs = algo3Symbols.reduce((acc, symbol) => {
    acc[symbol] = new algo3(symbol, algo3AccountStatus);
    return acc;
  }, {});

  await algo3AccountStatus.load();
  await Promise.all(Object.values(algo3Objs).map(obj => obj.set()));

  const cronTask4h = scheduleWithWatchdog('1 0 */4 * * *', () =>
    runWithTimeout(
      () => Promise.all(Object.values(algo3Objs).map(obj => obj.scheduleFunc())),
      '4시간 캔들용 작업'
    )
  );

  ws_client.subscribeV5('order', 'linear');
  await ws_client.connectWSAPI();

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

  return {
    map: { ca3: algo3Objs },
    cron: { '4h': cronTask4h },
  };
}
