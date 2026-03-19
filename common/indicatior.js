import { consoleLogger } from './logger.js';

/**
 * DMI와 ADX 지표를 계산합니다. (캔들 데이터 기반)
 * @param {Array} candles - K-line 데이터 배열. API 응답에서 `result.list`에 해당하며, reverse()된 상태여야 합니다 (오래된 데이터가 앞에).
 * @param {number} period - 계산 기간 (일반적으로 14)
 * @param {number} when - 0:당일 1:전날 2:이일전
 * @returns {{adx: number, pdi: number, mdi: number} | null} - ADX, +DI, -DI 값
 */
export function calculateDMI(candles, period, when) {
  try {
    if (!candles || candles.length < period + when) { // Ensure enough data for smoothing
      consoleLogger.error('DMI 계산을 위한 충분한 K-line 데이터가 없습니다.');
      return null;
    }

    let upMoves = [];
    let downMoves = [];
    let trueRanges = [];

    // 1. +DM, -DM, TR 계산
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];

      const currentHigh = parseFloat(current[2]);
      const currentLow = parseFloat(current[3]);
      const prevClose = parseFloat(prev[4]);
      const prevHigh = parseFloat(prev[2]);
      const prevLow = parseFloat(prev[3]);

      const upMove = currentHigh - prevHigh;
      const downMove = prevLow - currentLow;

      const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
      const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

      upMoves.push(plusDM);
      downMoves.push(minusDM);

      const tr = Math.max(
        currentHigh - currentLow,
        Math.abs(currentHigh - prevClose),
        Math.abs(currentLow - prevClose)
      );
      trueRanges.push(tr);
    }

    // 2. Wilder's Smoothing (지수 이동 평균과 유사)
    const smooth = (arr, period) => {
      let smoothed = [];
      if (arr.length < period) return [];
      let sum = arr.slice(0, period).reduce((acc, val) => acc + val, 0);
      smoothed[period - 1] = sum;
      for (let i = period; i < arr.length; i++) {
        smoothed[i] = (smoothed[i - 1] - (smoothed[i - 1] / period)) + arr[i];
      }
      return smoothed;
    };

    const smoothedPlusDM = smooth(upMoves, period);
    const smoothedMinusDM = smooth(downMoves, period);
    const smoothedTR = smooth(trueRanges, period);

    let pdiValues = []; // +DI
    let mdiValues = []; // -DI
    let dxValues = [];

    // 3. +DI, -DI, DX 계산
    for (let i = period - 1; i < smoothedTR.length; i++) {
      if (smoothedTR[i] === 0) { // Prevent division by zero
        pdiValues.push(0);
        mdiValues.push(0);
        dxValues.push(0);
        continue;
      }
      const pdi = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
      const mdi = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
      pdiValues.push(pdi);
      mdiValues.push(mdi);

      const pdiPlusMdi = pdi + mdi;
      if (pdiPlusMdi === 0) { // Prevent division by zero
        dxValues.push(0);
        continue;
      }
      const dx = (Math.abs(pdi - mdi) / pdiPlusMdi) * 100;
      dxValues.push(dx);
    }

    // 4. ADX 계산 (DX의 이동 평균)
    // 첫 ADX는 DX의 n-period 평균
    let adxValues = [];
    if (dxValues.length >= period) {
      let firstAdxSum = 0;
      for (let i = 0; i < period; i++) {
        firstAdxSum += dxValues[i];
      }
      adxValues[period - 1] = firstAdxSum / period;

      // 이후 ADX는 Wilder's Smoothing 적용
      for (let i = period; i < dxValues.length; i++) {
        adxValues[i] = (adxValues[i - 1] * (period - 1) + dxValues[i]) / period;
      }
    }
    
    // 마지막 값 반환
    const pdiMdiIndex = dxValues.length - 1;
    const adxIndex = adxValues.length - 1;

    if (adxIndex < when || pdiMdiIndex < when) {
        consoleLogger.error(`ADX/DMI 계산 결과가 요청된 "when" 값보다 적습니다.`);
        return null;
    }
    
    return {
      adx: adxValues[adxIndex - when],
      pdi: pdiValues[pdiMdiIndex - when],
      mdi: mdiValues[pdiMdiIndex - when],
    };

  } catch (error) {
    consoleLogger.error('DMI 계산 중 오류 발생:', error);
    return null;
  }
}

/**
 * 볼린저 밴드(Bollinger Bands)를 계산합니다. (캔들 데이터 기반)
 * @param {Array} candles - K-line 데이터 배열. API 응답에서 `result.list`에 해당하며, reverse()된 상태여야 합니다 (오래된 데이터가 앞에).
 * @param {number} period - 이동 평균 기간 (일반적으로 20)
 * @param {number} multiplier - 표준 편차에 곱할 값 (일반적으로 2)
 * @param {number} when - 0:현재 캔들 기준, 1:이전 캔들 기준
 * @returns {{upper: number, middle: number, lower: number} | null} - 볼린저 밴드 상단, 중간, 하단 값
 */
export function calculateBB(candles, period = 20, multiplier = 2, when = 0) {
  try {
    if (!candles || candles.length < period) { // Need at least 'period' candles to start
      consoleLogger.error('BB 계산을 위한 충분한 K-line 데이터가 없습니다.');
      return null;
    }

    const closes = candles.map(c => parseFloat(c[4]));
    let bbResults = [];

    for (let i = period - 1; i < closes.length; i++) {
      const currentWindow = closes.slice(i - period + 1, i + 1);

      // 1. 중간선 (Simple Moving Average)
      const sum = currentWindow.reduce((acc, val) => acc + val, 0);
      const middle = sum / period;

      // 2. 표준 편차 (Standard Deviation)
      const variance = currentWindow.reduce((acc, val) => acc + Math.pow(val - middle, 2), 0) / period;
      const stdDev = Math.sqrt(variance);

      // 3. 상단선 및 하단선
      const upper = middle + (stdDev * multiplier);
      const lower = middle - (stdDev * multiplier);

      bbResults.push({ upper, middle, lower });
    }

    // 마지막 값 반환
    const lastIndex = bbResults.length - 1;
    if (lastIndex < when) {
        consoleLogger.error(`BB 계산 결과가 요청된 "when" 값보다 적습니다.`);
        return null;
    }
    return bbResults[lastIndex - when];

  } catch (error) {
    consoleLogger.error('BB 계산 중 오류 발생:', error);
    return null;
  }
}

/**
 * EMA (지수 이동 평균)를 계산합니다.
 * @param {Array} candles - K-line 데이터 배열. 오래된 데이터가 앞에 오도록 정렬되어 있어야 합니다.
 * @param {number} period - 계산 기간
 * @param {number} when - 0:현재 캔들 기준, 1:이전 캔들 기준
 * @returns {number | null} - EMA 값
 */
export function calculateEMA(candles, period, when = 0) {
  try {
    // 'period'개의 EMA를 계산하고, 'when'번째 전의 값을 보려면 최소 period + when 개의 데이터가 필요합니다.
    if (!candles || candles.length < period + when) {
      consoleLogger.error(`EMA 계산을 위한 충분한 캔들 데이터가 없습니다. (필요: ${period + when}, 확보: ${candles.length})`);
      return null;
    }

    // 전체 종가 데이터를 추출합니다.
    const closes = candles.map(c => parseFloat(c[4]));

    const multiplier = 2 / (period + 1);
    let emaValues = [];

    // 첫 EMA는 단순 이동 평균 (SMA)으로 시작합니다.
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += closes[i];
    }
    emaValues[period - 1] = sum / period;

    // 이후 EMA를 순차적으로 계산합니다.
    for (let i = period; i < closes.length; i++) {
      emaValues[i] = (closes[i] - emaValues[i - 1]) * multiplier + emaValues[i - 1];
    }

    // 요청된 'when'에 해당하는 EMA 값을 반환합니다.
    const lastIndex = emaValues.length - 1;
    
    // 반환하려는 인덱스가 유효한지 확인합니다.
    if (lastIndex < when) {
        consoleLogger.error(`EMA 계산 결과가 요청된 "when"(${when}) 값을 반환하기에 충분하지 않습니다.`);
        return null;
    }
    
    // 마지막 인덱스에서 'when'만큼 이전의 값을 반환합니다.
    return emaValues[lastIndex - when];

  } catch (error) {
    consoleLogger.error('EMA 계산 중 오류 발생:', error);
    return null;
  }
}

/**
 * Alligator 지표를 계산합니다.
 * @param {Array} candles - K-line 데이터 배열. 오래된 데이터가 앞에 오도록 정렬되어 있어야 합니다.
 * @param {number} when - 0:현재 캔들 기준, 1:이전 캔들 기준
 * @returns {{jaw: number, teeth: number, lips: number} | null} - Alligator 값
 */
export function calculateAlligator(candles, when = 0) {
  try {
    const jawPeriod = 21;
    const teethPeriod = 13;
    const lipsPeriod = 8;

    const jawShift = 8;
    const teethShift = 5;
    const lipsShift = 3;

    // 필요한 최소 데이터 길이를 계산합니다.
    const requiredLength = Math.max(jawPeriod + jawShift, teethPeriod + teethShift, lipsPeriod + lipsShift) + when;
    if (!candles || candles.length < requiredLength) {
      consoleLogger.error(`Alligator 계산을 위한 충분한 캔들 데이터가 없습니다. (필요: ${requiredLength}, 확보: ${candles.length})`);
      return null;
    }

    const medianPrices = candles.map(c => (parseFloat(c[2]) + parseFloat(c[3])) / 2);

    const calculateSmmaValues = (data, period) => {
        const multiplier = 1 / period; // SMMA(Smoothed Moving Average) 가중치
        let smmaValues = [];

        // 첫 SMMA는 단순 이동 평균(SMA)으로 시작
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i];
        }
        smmaValues[period - 1] = sum / period;

        // 이후 SMMA를 순차적으로 계산
        for (let i = period; i < data.length; i++) {
            smmaValues[i] = (data[i] * multiplier) + (smmaValues[i-1] * (1 - multiplier));
        }
        return smmaValues;
    };
    
    const jawValues = calculateSmmaValues(medianPrices, jawPeriod);
    const teethValues = calculateSmmaValues(medianPrices, teethPeriod);
    const lipsValues = calculateSmmaValues(medianPrices, lipsPeriod);

    const jawIndex = jawValues.length - 1 - when - jawShift;
    const teethIndex = teethValues.length - 1 - when - teethShift;
    const lipsIndex = lipsValues.length - 1 - when - lipsShift;

    if (jawIndex < 0 || teethIndex < 0 || lipsIndex < 0) {
        consoleLogger.error(`Alligator 계산 결과가 요청된 "when"(${when}) 값을 반환하기에 충분하지 않습니다.`);
        return null;
    }

    return {
      jaw: jawValues[jawIndex],
      teeth: teethValues[teethIndex],
      lips: lipsValues[lipsIndex],
    };

  } catch (error) {
    consoleLogger.error('Alligator 계산 중 오류 발생:', error);
    return null;
  }
}

/**
 * Keltner Channel을 계산합니다. (ATR 계산에 표준 EMA 방식 사용)
 * @param {Array} candles - K-line 데이터 배열. 오래된 데이터가 앞에 오도록 정렬.
 * @param {number} period - EMA 계산 기간 (일반적으로 20).
 * @param {number} atrPeriod - ATR 계산 기간 (일반적으로 10).
 * @param {number} multiplier - ATR에 곱할 값 (일반적으로 2).
 * @param {number} when - 0:현재 캔들, 1:이전 캔들.
 * @returns {{upper: number, middle: number, lower: number} | null} - Keltner Channel 값.
 */
export function calculateKeltnerChannel(candles, period = 20, atrPeriod = 10, multiplier = 2, when = 0) {
  try {
    const requiredCandleLength = Math.max(period + when, atrPeriod + when + 1);
    if (!candles || candles.length < requiredCandleLength) {
      consoleLogger.error(`Keltner Channel 계산을 위한 충분한 데이터가 없습니다. (필요: ${requiredCandleLength}, 확보: ${candles.length})`);
      return null;
    }

    // 1. 중심선 계산 (EMA of Close)
    const middle = calculateEMA(candles, period, when);
    if (middle === null) {
      return null;
    }

    // 2. ATR 계산 (Wilder's RMA = 1/n 스무딩)
    let trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i-1];
      const tr = Math.max(
        parseFloat(c[2]) - parseFloat(c[3]), // high - low
        Math.abs(parseFloat(c[2]) - parseFloat(p[4])), // abs(high - prev close)
        Math.abs(parseFloat(c[3]) - parseFloat(p[4]))  // abs(low - prev close)
      );
      trueRanges.push(tr);
    }

    if (trueRanges.length < atrPeriod) {
        consoleLogger.error('Keltner Channel의 ATR 계산을 위한 충분한 TR 데이터가 없습니다.');
        return null;
    }

    let atrValues = [];
    const atrMultiplier = 1 / atrPeriod; // Wilder's RMA

    // 첫 ATR 값은 ATR 기간 동안의 True Range의 단순 평균(SMA)입니다.
    let firstAtrSum = 0;
    for(let i = 0; i < atrPeriod; i++) {
        firstAtrSum += trueRanges[i];
    }
    atrValues[atrPeriod - 1] = firstAtrSum / atrPeriod;

    // 이후 ATR 값들은 Wilder's RMA 공식을 사용하여 계산합니다.
    for (let i = atrPeriod; i < trueRanges.length; i++) {
      atrValues[i] = (trueRanges[i] - atrValues[i - 1]) * atrMultiplier + atrValues[i - 1];
    }

    // 요청된 'when'에 해당하는 ATR 인덱스를 계산합니다.
    // trueRanges는 candles보다 길이가 1 작고, atrValues[i]는 candles[i+1]에 해당합니다.
    const atrIndex = candles.length - 1 - when - 1;

    if (atrIndex < 0 || atrIndex >= atrValues.length || atrValues[atrIndex] === undefined) {
        consoleLogger.error(`Keltner Channel ATR 계산 결과가 요청된 "when"(${when}) 값을 반환하기에 충분하지 않습니다.`);
        return null;
    }

    const atr = atrValues[atrIndex];
    
    // 3. 상단 및 하단 채널 계산
    const upper = middle + (atr * multiplier);
    const lower = middle - (atr * multiplier);

    return { upper, middle, lower };

  } catch (error) {
    consoleLogger.error('Keltner Channel 계산 중 오류 발생:', error);
    return null;
  }
}

/**
 * ATR (Average True Range)를 계산합니다. (Wilder's Smoothing)
 * @param {Array} candles - K-line 데이터 배열. 오래된 데이터가 앞에 오도록 정렬되어 있어야 합니다.
 * @param {number} period - 계산 기간 (일반적으로 14)
 * @param {number} when - 0:현재 캔들 기준, 1:이전 캔들 기준
 * @returns {number | null} - ATR 값
 */
export function calculateATR(candles, period = 14, when = 0) {
  try {
    if (!candles || candles.length < period + 1 + when) {
      consoleLogger.error(`ATR 계산을 위한 충분한 캔들 데이터가 없습니다. (필요: ${period + 1 + when}, 확보: ${candles.length})`);
      return null;
    }

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = parseFloat(candles[i][2]);
      const low  = parseFloat(candles[i][3]);
      const prevClose = parseFloat(candles[i - 1][4]);
      trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    // 첫 ATR: SMA
    let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
    const atrValues = new Array(period - 1).fill(undefined);
    atrValues.push(atr);

    // 이후: Wilder's Smoothing
    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
      atrValues.push(atr);
    }

    const resultIndex = atrValues.length - 1 - when;
    if (resultIndex < 0 || atrValues[resultIndex] === undefined) {
      consoleLogger.error(`ATR 계산 결과가 요청된 "when"(${when}) 값을 반환하기에 충분하지 않습니다.`);
      return null;
    }

    return atrValues[resultIndex];

  } catch (error) {
    consoleLogger.error('ATR 계산 중 오류 발생:', error);
    return null;
  }
}

/**
 * RSI (Relative Strength Index)를 계산합니다.
 * @param {Array} candles - K-line 데이터 배열. 오래된 데이터가 앞에 오도록 정렬되어 있어야 합니다.
 * @param {number} period - 계산 기간 (일반적으로 14)
 * @param {number} when - 0:현재 캔들 기준, 1:이전 캔들 기준
 * @returns {number | null} - RSI 값
 */
export function calculateRSI(candles, period = 14, when = 0) {
  try {
    if (!candles || candles.length < period + 1 + when) {
      consoleLogger.error(`RSI 계산을 위한 충분한 캔들 데이터가 없습니다. (필요: ${period + 1 + when}, 확보: ${candles.length})`);
      return null;
    }

    const closes = candles.map(c => parseFloat(c[4]));
    let gains = [];
    let losses = [];

    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        gains.push(change);
        losses.push(0);
      } else {
        gains.push(0);
        losses.push(Math.abs(change));
      }
    }

    let avgGain = gains.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    let rsiValues = [];
    // 첫 RSI 값 계산
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss; // avgLoss가 0이면 RSI는 100
    rsiValues.push(100 - (100 / (1 + rs)));

    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

      rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiValues.push(100 - (100 / (1 + rs)));
    }

    const resultIndex = rsiValues.length - 1 - when;
    if (resultIndex < 0) {
        consoleLogger.error(`RSI 계산 결과가 요청된 "when"(${when}) 값을 반환하기에 충분하지 않습니다.`);
        return null;
    }

    return rsiValues[resultIndex];

  } catch (error) {
    consoleLogger.error('RSI 계산 중 오류 발생:', error);
    return null;
  }
}
