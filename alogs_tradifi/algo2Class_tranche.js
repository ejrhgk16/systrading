// ─── Tranche 클래스 ──────────────────────────────────────────

export class Tranche {
  /**
   * @param {number} trancheNum
   * @param {number} capital
   * @param {string} ticker1 - 첫 번째 자산 티커 (예: 'QLD')
   * @param {string} ticker2 - 두 번째 자산 티커 (예: 'UGL')
   */
  constructor(trancheNum, capital, ticker1, ticker2) {
    this.tranche_num = trancheNum;
    this.cash = capital;
    this.ticker1 = ticker1;
    this.ticker2 = ticker2;

    // 자산별 보유/평단가
    this.shares = { [ticker1]: 0, [ticker2]: 0 };
    this.avg_price = { [ticker1]: 0, [ticker2]: 0 };
    this.equity = capital;
  }

  /** Firestore 데이터로 복원 */
  static fromData(data, ticker1, ticker2) {
    const t = new Tranche(data.tranche_num, 0, ticker1, ticker2);
    t.cash = data.cash;
    t.shares[ticker1] = data.shares?.[ticker1] ?? 0;
    t.shares[ticker2] = data.shares?.[ticker2] ?? 0;
    t.avg_price[ticker1] = data.avg_price?.[ticker1] ?? 0;
    t.avg_price[ticker2] = data.avg_price?.[ticker2] ?? 0;
    t.equity = data.equity ?? 0;
    return t;
  }

  /** 현재가 기준 equity 갱신 */
  updateEquity(price1, price2) {
    this.equity = this.cash
      + (this.shares[this.ticker1] * price1)
      + (this.shares[this.ticker2] * price2);
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
