import { calculateDMI, calculateBB, calculateEMA, calculateAlligator, calculateKeltnerChannel } from '../common/indicatior.js';
import { getKline } from '../common/util.js';

// 테스트 실행 함수
async function runTest(testName, testFunction) {
  try {
    await testFunction();
    console.log(`✅ [PASS] ${testName}`);
  } catch (error) {
    console.error(`❌ [FAIL] ${testName}`);
    console.error(error);
    process.exit(1); // 하나라도 실패하면 중단
  }
}

// 메인 테스트 함수
async function main() {
  // algo2Class.js와 유사하게 데이터를 가져옵니다.
  // 여기서는 'BTCUSDT'와 '60'분봉을 예시로 사용합니다.
  const symbol = 'ETHUSDT';
  const interval = '240';
  const limit = 200; // 지표 계산에 충분한 데이터 확보

  console.log(`'${symbol}' ${interval}봉 K-line 데이터를 ${limit}개 가져옵니다...`);
  const klineData = await getKline(symbol, interval, limit);

  if (!klineData || klineData.length < limit) {
    console.error('테스트를 위한 K-line 데이터를 충분히 가져오지 못했습니다.');
    process.exit(1);
  }
  console.log(`데이터 ${klineData.length}개 수신 완료.`);

  // --- BB 테스트 ---
  await runTest('calculateBB - (period: 20, multiplier: 1, when: 1)', async () => {
    const period = 20;
    const multiplier = 2;
    const when = 1;
    const bb = calculateBB(klineData, period, multiplier, when);

    console.log(`  BB (20, 2, 1) Result:`, bb);
    console.assert(typeof bb === 'object', 'BB 결과는 객체여야 합니다.');
    console.assert(bb.upper && bb.middle && bb.lower, 'BB 객체에 upper, middle, lower 속성이 있어야 합니다.');
    console.assert(bb.upper > bb.middle && bb.middle > bb.lower, 'BB 값의 관계가 올바르지 않습니다.');
  });

  // --- DMI 테스트 ---
  await runTest('calculateDMI - (period: 14, when: 1)', async () => {
    const period = 14;
    const when = 1;
    const dmi = calculateDMI(klineData, period, when);

    console.log(`  DMI (14, 1) Result:`, dmi);
    console.assert(typeof dmi === 'object', 'DMI 결과는 객체여야 합니다.');
    console.assert(dmi.adx !== undefined && dmi.pdi !== undefined && dmi.mdi !== undefined, 'DMI 객체에 adx, pdi, mdi 속성이 있어야 합니다.');
  });

  // --- Alligator 테스트 ---
  await runTest('calculateAlligator - (when: 0) - Current', async () => {
    const when = 0;
    const alligator = calculateAlligator(klineData, when);

    console.log(`  Alligator (when: 0) Result:`, alligator);
    console.assert(typeof alligator === 'object' && alligator !== null, 'Alligator 결과는 null이 아닌 객체여야 합니다.');
    console.assert(alligator.jaw !== undefined && alligator.teeth !== undefined && alligator.lips !== undefined, 'Alligator 객체에 jaw, teeth, lips 속성이 있어야 합니다.');
    console.assert(typeof alligator.jaw === 'number' && typeof alligator.teeth === 'number' && typeof alligator.lips === 'number', 'Alligator 값은 숫자여야 합니다.');
  });

  await runTest('calculateAlligator - (when: 1) - Previous', async () => {
    const when = 1;
    const alligator = calculateAlligator(klineData, when);

    console.log(`  Alligator (when: 1) Result:`, alligator);
    console.assert(typeof alligator === 'object' && alligator !== null, 'Alligator 결과는 null이 아닌 객체여야 합니다.');
    console.assert(alligator.jaw !== undefined && alligator.teeth !== undefined && alligator.lips !== undefined, 'Alligator 객체에 jaw, teeth, lips 속성이 있어야 합니다.');
    console.assert(typeof alligator.jaw === 'number' && typeof alligator.teeth === 'number' && typeof alligator.lips === 'number', 'Alligator 값은 숫자여야 합니다.');
  });
  
  await runTest('calculateAlligator - (when: -1) - Next Candle Projection', async () => {
    const when = -1;
    const alligator = calculateAlligator(klineData, when);

    console.log(`  Alligator (when: -1) Result:`, alligator);
    console.assert(typeof alligator === 'object' && alligator !== null, 'Alligator 결과는 null이 아닌 객체여야 합니다.');
    if (alligator) {
        console.assert(alligator.jaw !== undefined && alligator.teeth !== undefined && alligator.lips !== undefined, 'Alligator 객체에 jaw, teeth, lips 속성이 있어야 합니다.');
        console.assert(typeof alligator.jaw === 'number' && typeof alligator.teeth === 'number' && typeof alligator.lips === 'number', 'Alligator 값은 숫자여야 합니다.');
    }
  });

  // --- Keltner Channel 테스트 ---
  await runTest('calculateKeltnerChannel - (period: 20, atrPeriod: 20, multiplier: 1, when: 1)', async () => {
    const period = 5;
    const atrPeriod = 5;
    const multiplier = 1;
    const when = 1;
    const kc = calculateKeltnerChannel(klineData, period, atrPeriod, multiplier, when);

    console.log(`  Keltner Channel (20, 10, 1, 1) Result:`, kc);
    console.assert(typeof kc === 'object', 'KC 결과는 객체여야 합니다.');
    console.assert(kc.upper && kc.middle && kc.lower, 'KC 객체에 upper, middle, lower 속성이 있어야 합니다.');
    console.assert(kc.upper > kc.middle && kc.middle > kc.lower, 'KC 값의 관계가 올바르지 않습니다.');
  });

  console.log('\n모든 지표 테스트가 실제 데이터로 성공적으로 완료되었습니다.');
}

// 테스트 실행
main();
