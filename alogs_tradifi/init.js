import { Algo2QqqGld } from './algo2Class_qqq_gld.js';
import { Algo3MeanReversionQqq } from './algo3Class_mean_reversion_qqq.js';
import { runWithTimeout, scheduleWithWatchdog, CRON_JOB_TIMEOUT_MS } from '../common/util.js';

export async function initTradifi() {
  const qqgGldAlgo = new Algo2QqqGld();
  const meanRevAlgo = new Algo3MeanReversionQqq();

  await qqgGldAlgo.set();
  await meanRevAlgo.set();

  const cronTaskDaily = scheduleWithWatchdog('30 21 * * *', () =>
    runWithTimeout(
      () => Promise.all([qqgGldAlgo.scheduleFunc(), meanRevAlgo.scheduleFunc()]),
      'Tradifi 일일 전략',
      CRON_JOB_TIMEOUT_MS
    )
  );

  return {
    map: { ta2: qqgGldAlgo, ta3: meanRevAlgo },
    cron: { daily: cronTaskDaily },
  };
}
