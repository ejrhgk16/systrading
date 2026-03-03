import { rest_client } from '../common/client.js';
import { getTradeStatus, setTradeStatus } from '../db/firestoreFunc.js';
import { consoleLogger } from '../common/logger.js';

const DOC_ID = 'algo3_account_status';

export default class Algo3AccountStatus {

    constructor(nSymbols) {
        this.nSymbols = nSymbols;
        this.base_capital = null;
        this.last_updated = null;
    }

    // Firestore에서 상태 복원 (봇 시작 시 호출)
    // Firestore에 없으면 .env의 algo3_initial_capital 으로 초기화
    async load() {
        const data = await getTradeStatus(DOC_ID);
        if (data?.base_capital) {
            this.base_capital = data.base_capital;
            this.last_updated = data.last_updated ?? null;
            consoleLogger.info(`[algo3_account] Firestore 복원 - base_capital: ${this.base_capital}, last_updated: ${this.last_updated}`);
        } else {
            const envCapital = Number(process.env['algo3_initial_capital']);
            if (!envCapital) throw new Error('[algo3_account] algo3_initial_capital 환경변수 미설정');
            this.base_capital = envCapital;
            this.last_updated = new Date().toISOString();
            await this.save();
            consoleLogger.info(`[algo3_account] 초기값 세팅 (env) - base_capital: ${this.base_capital}`);
        }
    }

    // Bybit API 조회 → base_capital 갱신 → Firestore 저장 (포지션 없을 때 호출)
    async updateFromBybit() {
        const res = await rest_client.getWalletBalance({ accountType: 'UNIFIED' });
        const account = res.result?.list?.[0];
        if (!account) throw new Error('[algo3_account] getWalletBalance 응답 없음');

        this.base_capital = Number(account.totalWalletBalance);
        this.last_updated = new Date().toISOString();
        await this.save();

        consoleLogger.info(`[algo3_account] base_capital 갱신 (Bybit) - ${this.base_capital} USDT (${this.last_updated})`);
    }

    // 체결된 PnL을 base_capital에 반영 → Firestore 저장
    async addPnl(pnl) {
        const amount = parseFloat(pnl);
        if (!amount) return;
        this.base_capital += amount;
        this.last_updated = new Date().toISOString();
        await this.save();
        consoleLogger.info(`[algo3_account] base_capital 갱신 (PnL) ${amount >= 0 ? '+' : ''}${amount.toFixed(4)} → ${this.base_capital.toFixed(4)} USDT`);
    }

    // 심볼당 할당 자금
    getAllocated() {
        if (!this.base_capital) throw new Error('[algo3_account] base_capital 미설정');
        return this.base_capital / this.nSymbols;
    }

    async save() {
        await setTradeStatus(DOC_ID, {
            base_capital: this.base_capital,
            nSymbols: this.nSymbols,
            last_updated: this.last_updated,
        });
    }
}
