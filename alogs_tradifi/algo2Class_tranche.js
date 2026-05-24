// ─── Tranche 클래스 ──────────────────────────────────────────

export class Tranche {
  /**
   * @param {number} trancheNum
   * @param {number} capital
   * @param {...string} tickers - N개 자산 티커 (예: 'TQQQ', 'UGL', 'CTA')
   */
  constructor(trancheNum, capital, ...tickers) {
    this.tranche_num = trancheNum;
    this.cash = capital;
    this.tickers = tickers;

    // 자산별 보유/평단가
    this.shares = Object.fromEntries(tickers.map(t => [t, 0]));
    this.avg_price = Object.fromEntries(tickers.map(t => [t, 0]));
    this.equity = capital;
  }

  /** Firestore 데이터로 복원 */
  static fromData(data, ...tickers) {
    const t = new Tranche(data.tranche_num, 0, ...tickers);
    t.cash = data.cash;
    for (const tk of tickers) {
      t.shares[tk] = data.shares?.[tk] ?? 0;
      t.avg_price[tk] = data.avg_price?.[tk] ?? 0;
    }
    t.equity = data.equity ?? 0;
    return t;
  }

  /** 현재가 기준 equity 갱신 */
  updateEquity(prices) {
    this.equity = this.cash + this.tickers.reduce((sum, t) => sum + this.shares[t] * (prices[t] || 0), 0);
    return this.equity;
  }

  /** 매수: cash 차감, 가중평균 갱신 */
  buy(ticker, shares, price) {
    if (shares <= 0 || price <= 0) return;
    const total = this.shares[ticker] + shares;
    this.avg_price[ticker] = ((this.avg_price[ticker] * this.shares[ticker]) + (price * shares)) / total;
    this.shares[ticker] = total;
    this.cash -= shares * price;
  }

  /** 매도: cash 증가 */
  sell(ticker, shares, price) {
    if (shares <= 0 || price <= 0) return;
    this.shares[ticker] -= shares;
    if (this.shares[ticker] === 0) this.avg_price[ticker] = 0;
    this.cash += shares * price;
  }

  /** Firestore 저장용 plain object */
  toData() {
    return {
      tranche_num: this.tranche_num,
      cash: this.cash,
      shares: { ...this.shares },
      avg_price: { ...this.avg_price },
      equity: this.equity,
    };
  }
}
