
//전략 : 변동성(볼밴)
import dotenv from 'dotenv';
dotenv.config({ override: true });

import {rest_client, ws_client, ws_api_client, WS_KEY_MAP} from '../common/client.js';
import {calculateDMI, calculateBB, calculateEMA, calculateAlligator} from '../common/indicatior.js';
import {getKline, setMsgFormat, sendTelegram, runWithTimeout} from '../common/util.js';

import {getTradeStatus, setTradeStatus, addTradeLog } from '../db/firestoreFunc.js';
import {fileLogger, consoleLogger} from '../common/logger.js';

export default class alogo2{

    constructor(symbol, std = 2) {

        this.name = `alog2_${symbol}_bb${std}`;

        this.qtyMultiplier = 0// 수량설정을 위한 소수점 자릿수에 따른 승수
        this.priceMultiplier = 0

        this.symbol = symbol;
        this.capital = 0.0;// 할당된 자금 설정필요
        this.max_risk_per_trade = 0.02; // 2%
        this.std = std
        
        this.leverage = 10; // 기본값

        this.orderSize = 0.0 // 주문 수량

        this.openPrice = 0.0;
        this.exit_price_1 = 0.0
        this.exit_price_2 = 0.0
        this.exit_price_3 = 0.0

        this.exit_size_1 = 0.0; //1차 청산 물량
        this.exit_size_2 = 0.0; //2차 청산 물량
        this.exit_size_3 = 0.0; //3차 청산 물량

        this.orderId_open = null//오더링크아이디로 용
        this.orderId_exit_1 = null//오더링크아이디 용
        this.orderId_exit_2 = null//오더링크아이디 용
        this.orderId_exit_3 = null//오더링크아이디 용


        this.isOpenOrderFilled = false
        this.exit_count = 0;// 부분익절 여부
        
        this.positionType = null;//long short null
        this.entry_allow = false // adx20이상, 증가여부

        
    }

    async set(){
        
        const decimalPlaces_qty = Number(process.env[this.symbol+"_decimal_qty"])
        const decimalPlaces_price = Number(process.env[this.symbol+"_decimal_price"])

        this.qtyMultiplier = Math.pow(10, decimalPlaces_qty); // 수량설정을 위한 소수점 자릿수에 따른 승수
        this.priceMultiplier = Math.pow(10, decimalPlaces_price)
        
        this.setNewOrderId()

        this.capital = Number(process.env["algo2_"+this.symbol+"_capital"])
        this.leverage = Number(process.env["algo2_"+this.symbol+"_leverage"] || 10);

        const docId = this.getTradeStatusDocId();
        const data = await getTradeStatus(docId)

        if(data){
            Object.assign(this, data);
            //await this.doubleCheckStatus()
            
        }

        const alog2State = { ...this };
        await setTradeStatus(docId, alog2State)

        consoleLogger.info(this.name + ' 초기 설정 완료 captial : ', this)
        
    }


    async open(){//포지션 타입, 스탑로스 계산 -> 주문 // 포지션 없는경우 반복실행되어야함

        const data = await getKline(this.symbol, '240', 200)
        
        const latestCandle = data[data.length - 1];
        const current_open = latestCandle[1];
 
        const bbObj =  calculateBB(data, 20, this.std, 1);//직전봉

        const adxObj = calculateDMI(data, 14, 1);//직전봉
        const adxObj2 = calculateDMI(data, 14, 2);//전전봉

        const alligatorObj = calculateAlligator(data, 0)

        const lips_8 = alligatorObj.lips
        const teeth_13 = alligatorObj.teeth//calculateEMA(data, 5, 0);
        const jaw_21 = alligatorObj.jaw//calculateEMA(data, 10, 0);

        //adx 조건 계산
        if(adxObj.adx >20 && adxObj.adx > adxObj2.adx){
            this.entry_allow = true
        }else{
            this.entry_allow = false
        }

        //포지션타입계산 
        if(current_open > bbObj.upper){

            if(current_open > lips_8 && current_open > teeth_13 && current_open > jaw_21){
                this.positionType = 'long'
            }           

        }else if(current_open < bbObj.lower){
            
            if(current_open < lips_8 && current_open < teeth_13 && current_open < jaw_21){
                this.positionType = 'short'
            }

        }else{
            this.positionType = null
        }

        consoleLogger.info(`${this.name} -- current_open: ${current_open}, positionType: ${this.positionType}, entry_allow: ${this.entry_allow}`);

        if(this.positionType == null || this.entry_allow == false){
            return
        }

        const rawOrderSize = this.calculatePositionSize(current_open, (lips_8 + teeth_13 + jaw_21) / 3);
        this.orderSize = Math.round(rawOrderSize * this.qtyMultiplier) / this.qtyMultiplier;
        
        this.exit_size_1 = Math.round((this.orderSize / 3) * this.qtyMultiplier) / this.qtyMultiplier;
        this.exit_size_2 = Math.round((this.orderSize / 3) * this.qtyMultiplier) / this.qtyMultiplier;
        this.exit_size_3 = Math.round((this.orderSize - this.exit_size_1 - this.exit_size_2) * this.qtyMultiplier) / this.qtyMultiplier;

        const side = this.positionType == 'long' ? 'Buy' : 'Sell'

        this.openPrice = current_open

        this.setNewOrderId()

        const orderParams = {
            category: 'linear',
            symbol: this.symbol,
            orderType: 'Market',
            qty: (this.orderSize).toString(),
            side: side,
            orderLinkId : this.orderId_open,
        };
        
        consoleLogger.order(`${this.name} open 주문 요청 !!`, orderParams);

        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', orderParams),
            `${this.name} open order`, 60000
        ).catch((e) => {
            fileLogger.error('open error:', e);
            consoleLogger.error('open error:', e);
            consoleLogger.error('open error >>> reset후 재주문 요청');
            this.reset();
            this.open();
        });

    }

    async openOrderFilledCallback(){//오픈 포지션 체결되면 스탑설정 1번실행

        const data = await getKline(this.symbol, '240', 200)

        const alligatorObj = calculateAlligator(data, 0)

        let lips_8 = alligatorObj.lips
        let teeth_13 = alligatorObj.teeth//calculateEMA(data, 5, 0);
        let jaw_21 = alligatorObj.jaw//calculateEMA(data, 10, 0);

        lips_8 =  Math.round(lips_8 * this.priceMultiplier) / this.priceMultiplier;
        teeth_13 = Math.round(teeth_13 * this.priceMultiplier) / this.priceMultiplier;
        jaw_21 = Math.round(jaw_21 * this.priceMultiplier) / this.priceMultiplier;

        const prices = [lips_8, teeth_13, jaw_21];
        // 포지션에 따라 정렬합니다.

        if (this.positionType === 'long') {
            // 롱 포지션: 내림차순 정렬 (높은 가격부터 청산)
            prices.sort((a, b) => b - a);
        } else { // 'short'
            // 숏 포지션: 오름차순 정렬 (낮은 가격부터 청산)
            prices.sort((a, b) => a - b);
        }

        // 정렬된 가격을 청산 가격으로 설정합니다.
        this.exit_price_1 = prices[0];
        this.exit_price_2 = prices[1];
        this.exit_price_3 = prices[2]; // 3차 청산 가격

        
        const side = this.positionType == 'long' ? 'Sell' : 'Buy'
        const triggerDirection = this.positionType === 'long' ? '2' : '1'; // 1: Rise, 2: Fall

        const exit1Params = {
            category: "linear",
            symbol: this.symbol,
            side: side,
            qty: (this.exit_size_1).toString(),
            triggerPrice: (this.exit_price_1).toString(),
            triggerDirection: triggerDirection,
            triggerBy: "MarkPrice",
            orderType: "Market",
            reduceOnly: true,
            orderLinkId : this.orderId_exit_1,
            timeInForce: "GoodTillCancel"
        };
        
        consoleLogger.order(`${this.name} 1차 청산 설정`, exit1Params);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit1Params)
                .catch((e) => {
                    fileLogger.error('order exit1 error:', e);
                    consoleLogger.error('order exit1 error:', e);
                    consoleLogger.error('order exit1 error 강제 청산 실행');
                    const marketCloseParams = { ...exit1Params };
                    delete marketCloseParams.triggerPrice;
                    delete marketCloseParams.triggerDirection;
                    delete marketCloseParams.triggerBy;
                    delete marketCloseParams.timeInForce;

                    this.setNewOrderId();
                    marketCloseParams.orderLinkId = this.orderId_exit_1;
                    return runWithTimeout(
                        () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', marketCloseParams),
                        `${this.name} fallback exit1`, 60000
                    );
                }),
            `${this.name} create exit1`, 60000
        );

        const exit2Params = {
            category: "linear",
            symbol: this.symbol,
            side: side,
            qty: (this.exit_size_2).toString(),
            triggerPrice: (this.exit_price_2).toString(),
            triggerDirection: triggerDirection,
            triggerBy: "MarkPrice",
            orderType: "Market",
            reduceOnly: true,
            orderLinkId : this.orderId_exit_2,
            timeInForce: "GoodTillCancel"
        };

        consoleLogger.order(`${this.name} 2차 청산 설정`, exit2Params);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit2Params)
                .catch((e) => {
                    fileLogger.error('order exit2 error:', e);
                    consoleLogger.error('order exit2 error:', e);
                    consoleLogger.error('order exit2 error 강제 청산 실행');

                    const marketCloseParams = { ...exit2Params };
                    delete marketCloseParams.triggerPrice;
                    delete marketCloseParams.triggerDirection;
                    delete marketCloseParams.triggerBy;
                    delete marketCloseParams.timeInForce;

                    this.setNewOrderId();
                    marketCloseParams.orderLinkId = this.orderId_exit_2;
                    return runWithTimeout(
                        () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', marketCloseParams),
                        `${this.name} fallback exit2`, 60000
                    );
                }),
            `${this.name} create exit2`, 60000
        );


        const exit3Params = {
            category: "linear",
            symbol: this.symbol,
            side: side,
            qty: (this.exit_size_3).toString(),
            triggerPrice: (this.exit_price_3).toString(),
            triggerDirection: triggerDirection,
            triggerBy: "MarkPrice",
            orderType: "Market",
            reduceOnly: true,
            orderLinkId : this.orderId_exit_3,
            timeInForce: "GoodTillCancel"
        };

        consoleLogger.order(`${this.name} 3차 청산 설정`, exit3Params);
        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', exit3Params)
                .catch((e) => {
                    fileLogger.error('order exit3 error:', e);
                    consoleLogger.error('order exit3 error:', e);
                    consoleLogger.error('order exit3 error 강제 청산 실행');

                    const marketCloseParams = { ...exit3Params };
                    delete marketCloseParams.triggerPrice;
                    delete marketCloseParams.triggerDirection;
                    delete marketCloseParams.triggerBy;
                    delete marketCloseParams.timeInForce;

                    this.setNewOrderId();
                    marketCloseParams.orderLinkId = this.orderId_exit_3;
                    return runWithTimeout(
                        () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', marketCloseParams),
                        `${this.name} fallback exit3`, 60000
                    );
                }),
            `${this.name} create exit3`, 60000
        );


    }

    async updateStop(){//포지션이있는경우 반복되어야함

        const data = await getKline(this.symbol, '240', 200);

        const alligatorObj = calculateAlligator(data, 0)
        let lips_8 = alligatorObj.lips
        let teeth_13 = alligatorObj.teeth//calculateEMA(data, 5, 0);
        let jaw_21 = alligatorObj.jaw//calculateEMA(data, 10, 0);

        lips_8 =  Math.round(lips_8 * this.priceMultiplier) / this.priceMultiplier;
        teeth_13 = Math.round(teeth_13 * this.priceMultiplier) / this.priceMultiplier;
        jaw_21 = Math.round(jaw_21 * this.priceMultiplier) / this.priceMultiplier;

        const prices = [lips_8, teeth_13, jaw_21];
        // 포지션에 따라 정렬

        if (this.positionType === 'long') {
            // 롱 포지션: 내림차순 정렬 (높은 가격부터 청산)
            prices.sort((a, b) => b - a);
        } else { // 'short'
            // 숏 포지션: 오름차순 정렬 (낮은 가격부터 청산)
            prices.sort((a, b) => a - b);
        }

        // 정렬된 가격을 청산 가격으로 설정
        this.exit_price_1 = prices[0];
        this.exit_price_2 = prices[1];
        this.exit_price_3 = prices[2]; // 3차 청산 가격
        
        if(this.exit_count < 1){//청산 횟수가 0일때
            
            const amend1Params = {
                category: "linear",
                symbol: this.symbol,
                triggerPrice: (this.exit_price_1).toString(),
                orderLinkId : this.orderId_exit_1,
            };
            
            consoleLogger.order(`${this.name} 1차 청산 주문 수정 요청`, amend1Params);
            runWithTimeout(
                () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.amend', amend1Params),
                `${this.name} amend exit1`, 60000
            );
        }

        if(this.exit_count < 2){//청산 횟수가 0이거나 1일때

            const amend2Params = {
                category: "linear",
                symbol: this.symbol,
                triggerPrice: (this.exit_price_2).toString(),
                orderLinkId : this.orderId_exit_2,
            };

            consoleLogger.order(`${this.name} 2차 청산 주문 수정 요청`, amend2Params);
            runWithTimeout(
                () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.amend', amend2Params),
                `${this.name} amend exit2`, 60000
            );
        }


        if(this.exit_count < 3){//청산 횟수가 0이거나 1이거나 2일때

            const amend3Params = {
                category: "linear",
                symbol: this.symbol,
                triggerPrice: (this.exit_price_3).toString(),
                orderLinkId : this.orderId_exit_3,
            };

            consoleLogger.order(`${this.name} 3차 청산 주문 수정 요청`, amend3Params);
            runWithTimeout(
                () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.amend', amend3Params),
                `${this.name} amend exit3`, 60000
            );
        }

    }

    reset(){

        this.orderSize = 0.0
        this.exit_size_1 = 0.0
        this.exit_size_2 = 0.0
        this.exit_size_3 = 0.0

        this.openPrice = 0.0

        this.positionType = null

        this.entry_allow = false
        this.exit_count = 0
        this.isOpenOrderFilled = false

        this.orderId_open = null
        this.orderId_exit_1 = null
        this.orderId_exit_2 = null
        this.orderId_exit_3 = null

    }



    async orderEventHandle(dataObj){//orderstatus == filled
        

        if(dataObj?.orderStatus != 'Filled') return;

        const data = {...dataObj, 
            openPrice : this.openPrice, 
            exit_price_1 : this.exit_price_1, 
            exit_price_2 : this.exit_price_2,
            exit_price_3 : this.exit_price_3
        }
        const tradeLogDocId = "algo2_"+this.symbol
        addTradeLog(tradeLogDocId,data)

        consoleLogger.order(`${this.name} ${dataObj.orderLinkId} 체결 -- side: ${dataObj.side}, price: ${dataObj.price}, qty: ${dataObj.qty}, pnl: ${dataObj.closedPnl}`);

        if(this.orderId_open == dataObj.orderLinkId){

            this.isOpenOrderFilled = true
            await this.openOrderFilledCallback()
        }

        if(this.orderId_exit_1 == dataObj.orderLinkId){
            this.exit_count ++

        }

        if(this.orderId_exit_2 == dataObj.orderLinkId){
            this.exit_count ++
        }

        if(this.orderId_exit_3 == dataObj.orderLinkId){
            this.reset()
        }

        const docId = this.getTradeStatusDocId()
        const alog2State = { ...this };
        setTradeStatus(docId, alog2State)

        const msg = {
            orderLinkId : dataObj?.orderLinkId,
            side : dataObj?.side,
            closedPnl : dataObj?.closedPnl,

        }

        const msgText = setMsgFormat(msg, this.name)
        sendTelegram(msgText)

        
    }

    getTradeStatusDocId(){
        const docId = 'algo2_'+this.name+'_trade_status'
        return docId
    }

    // async doubleCheckStatus(){
    //     const res1 = await rest_client.getActiveOrders({ 
    //         category: 'linear',
    //         symbol: this.symbol,
    //         openOnly: 0,
    //         orderLinkId : this.orderId_exit_1,
    //         limit: 1,
    //     })
    //     .catch((error) => {
    //         consoleLogger.error(`${this.name} getActiveOrders (exit1) failed:`, error);
    //         fileLogger.error(`${this.name} getActiveOrders (exit1) failed:`, error);
    //     });

    //     const res2 = await rest_client.getActiveOrders({
    //         category: 'linear',
    //         symbol: this.symbol,
    //         openOnly: 0,
    //         orderLinkId : this.orderId_exit_2,
    //         limit: 1,
    //     })
    //     .catch((error) => {
    //         consoleLogger.error(`${this.name} getActiveOrders (exit2) failed:`, error);
    //         fileLogger.error(`${this.name} getActiveOrders (exit2) failed:`, error);
    //     });

    //     if(res1?.result?.list?.length > 0 && res2?.result?.list?.length > 0){
    //         this.isOpenOrderFilled = true
    //         this.isPartialExit = false
    //     }else if(res1?.result?.list?.length <= 0 && res2?.result?.list?.length > 0){
    //         this.isOpenOrderFilled = true
    //         this.isPartialExit = true
    //     }else{
    //         this.reset()
    //     }


    // }

    setNewOrderId(){//새로운 open 주문들어갈때마다 실행필

        this.orderId_open = `${this.name}_open_${new Date().getTime()}`
        this.orderId_exit_1 = `${this.name}_exit1_${new Date().getTime()}`
        this.orderId_exit_2 = `${this.name}_exit2_${new Date().getTime()}`
        this.orderId_exit_3 = `${this.name}_exit3_${new Date().getTime()}`

    }

    calculatePositionSize(entry_price, avg_exit_price) {
        const max_loss_amount = this.capital * this.max_risk_per_trade;
        const loss_per_unit = Math.abs(entry_price - avg_exit_price);
        if (loss_per_unit === 0) {
            return 0; // Prevent division by zero
        }
        const quantity_by_risk = max_loss_amount / loss_per_unit;
        const max_quantity_by_capital = this.capital / entry_price;
        const final_quantity = Math.min(quantity_by_risk, max_quantity_by_capital);
        return final_quantity;
    }

    async scheduleFunc(){
        try {
            if(!this.isOpenOrderFilled){
                await this.open()
            }else{
                await this.updateStop()
            }
        } catch (error) {
            consoleLogger.error('scheduleFunc error:', error);
            fileLogger.error('scheduleFunc error:', error);
        }


    }

    async open_test(){//테스트용 강제로 주문체결

        const data = await getKline(this.symbol, '240', 200)

        const latestCandle = data[data.length - 1];
        const current_open = latestCandle[4];

        const rawOrderSize = this.capital / current_open; 
        this.orderSize = Math.round(rawOrderSize * this.qtyMultiplier) / this.qtyMultiplier;
        
        this.exit_size_1 = Math.round((this.orderSize / 2) * this.qtyMultiplier) / this.qtyMultiplier;
        this.exit_size_2 = Math.round((this.orderSize - this.exit_size_1) * this.qtyMultiplier) / this.qtyMultiplier;

        this.positionType = 'long'
        const side = this.positionType == 'long' ? 'Buy' : 'Sell'

        this.openPrice = current_open

        this.setNewOrderId()

        const orderParams = {
            category: 'linear',
            symbol: this.symbol,
            orderType: 'Market',
            qty: (this.orderSize).toString(),
            side: side,
            orderLinkId : this.orderId_open,
        };
        
        consoleLogger.order(`${this.name} open 주문 요청 !!`, orderParams);

        runWithTimeout(
            () => ws_client.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', orderParams),
            `${this.name} open_test order`, 60000
        ).catch((e) => {
           consoleLogger.error('open_test error:', e);
           fileLogger.error('open_test error:', e);
        })

    }

}
