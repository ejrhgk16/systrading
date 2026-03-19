import * as util from '../common/util.js';
import * as indicator from '../common/indicatior.js';

export async function getSpxVixData() {
  try {
    // SPX RSI 계산 (14일 RSI를 위해 30일치 데이터 확보)
    const spx_candles = await util.getCandles_yahoo('^SPX', 30);
    const spx_rsi = indicator.calculateRSI(spx_candles, 3, 0); 

    // VIX 최신 데이터
    const vix_candles = await util.getCandles_yahoo('^VIX', 3);
    const latest_vix = vix_candles[vix_candles.length - 1];

    // VIX3M 최신 데이터
    const vix3m_candles = await util.getCandles_yahoo('^VIX3M', 3);
    const latest_vix3m = vix3m_candles[vix3m_candles.length - 1];
    
    const vix_close = latest_vix[4];
    const vix3m_close = latest_vix3m[4];
    const term_structure = vix3m_close > vix_close ? 'Contango' : 'Backwardation';

    const result = {
        spx_rsi: Math.round(spx_rsi * 100) / 100,
        vix_term_structure: term_structure
    }
    const msg = util.setMsgFormat(result, 'SPX_VIX')
    util.sendTelegram(msg)

    return result;

  } catch (error) {
    console.error("데이터를 가져오는 중 오류 발생:", error);
  }
}
