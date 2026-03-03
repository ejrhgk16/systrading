//전략 : dmi(추세판별) + 볼밴(진입)
import {client, ws} from '../common/client.js';
import {calculateDMI, calculateBB} from '../common/indicatior.js';

export default class alogo1{

    constructor(symbol) {

        this.symbol = symbol;
        this.capital = 0.0;// 설정필요
        this.leverage = 0.0;//계산필요 - 손절가에 못나가도 그냥 포지션 터지게

        this.risk_per = 0.02;//거래당 전체 자금 기준 최대손실 퍼센트
        this.riskUpMultiple = 1.5 //adx30이상기준 리스크 몇배로 키울건지

        this.orderSize = 0.0 // 주문 수량
        this.orderPrice = 0.0;
        this.targetPrice = 0.0;
        this.stopPrice = 0.0;

        this.entryPrice = 0.0 // 체결된 수량
        this.entrySize = 0.0
    
        this.isLong = true;

        this.entry_allow = false //손절 직후 재진입 방지 플래그, adx>20 or (adx>15and dpi dmi 차이 5이상)
        this.direction_of_last_stop_loss = 0 //마지막 손절 방향 (1: 롱, -1: 숏)
        
        //this.isOverAdx30 = false

        // this.#leverage = 0.0; 퍼블릭 안되게
    }

    async set(){
        const adxObj = await calculateDMI(this.symbol, 'D', 14, 1);

        if(adxObj.pdi > adxObj.mdi)this.isLong = true

        const diff = Math.abs(adxObj.pdi - adxObj.mdi)

        if(adxObj.adx > 20 || (adxObj.adx > 20 && diff > 5)) this.entry_allow = true
        if(adxObj.adx > 30) this.risk_per = this.risk_per*this.riskUpMultiple


    }

    async calOpenInfo(){// 진입가 및 목표가 계산 -> 주당 기대 수익 계산 -> 주당 리스크 계산 -> 손절가 계산 -> 최대 리스크금액 기준 진입 수량 계산 

        const bbObj_2 = await calculateBB(this.symbol, '30', 20, 2, 1)
        const bbObj_1dot5 = await calculateBB(this.symbol, '30', 20, 1.5, 1)

        this.orderPrice = this.isLong ? bbObj_2.lower : bbObj_2.upper//진입 : 롱이면 볼밴하단, 숏이면 볼밴 상단
        this.targetPrice = this.isLong ? bbObj_1dot5.upper : bbObj_1dot5.lower//목표 : 롱이면 볼밴상단, 숏이변 볼밴 하단

        this.calcRisk();

    }


    calcRisk(){// 주당 기대 수익 계산 -> 주당 리스크 계산 -> 손절가 계산 -> 최대 리스크금액 기준 진입 수량 계산 
        const reward_per_share = Math.abs(this.orderPrice - this.targetPrice) // 주당 기대 수익
        const risk_per_share = reward_per_share / 1.5 // 주당 리스크 : 주당 기대 수익 기준으로 손익비 1.5에 맞춤

        this.stopPrice = this.isLong ? this.openPrice - risk_per_share : this.openPrice + risk_per_share //손절가격계산

        const risk_dollars = this.capital * this.risk_per

        this.orderSize = risk_dollars / risk_per_share

    }

    async openOrder(){

    }

    async updateOrder(){

    }




    async calcDirection(){//롱 숏 결정


    }


}