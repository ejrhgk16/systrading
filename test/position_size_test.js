
import algo2 from '../alogs_crypto/algo2Class.js';
import { getKline } from '../common/util.js';
import { calculateAlligator } from '../common/indicatior.js';

async function test_calculatePositionSize() {
    // 1. Initialize
    const symbol = 'SOLUSDT'; // Using BTCUSDT as an example
    const bot = new algo2(symbol);
    await bot.set(); // Initialize capital, leverage, etc. from .env

    // Ensure capital is set
    if (bot.capital === 0) {
        console.log('Error: Capital is not set. Please set algo2_BTCUSDT_capital in your .env file.');
        return;
    }

    // 2. Get real market data
    const data = await getKline(symbol, '240', 200);
    if (!data || data.length < 2) {
        console.log('Error: Could not fetch enough Kline data for testing.');
        return;
    }

    // 3. Calculate necessary inputs
    const latestCandle = data[data.length - 1];
    const entry_price = parseFloat(latestCandle[4]);

    const alligatorObj = calculateAlligator(data, 0);
    const ema_5 = alligatorObj.teeth;
    const ema_10 = alligatorObj.jaw;
    const avg_exit_price = (ema_5 + ema_10) / 2;

    // 4. Call the function to be tested
    const positionSize = bot.calculatePositionSize(entry_price, avg_exit_price, bot.capital);
    const finalQuantity = Math.round(positionSize * bot.qtyMultiplier) / bot.qtyMultiplier;


    // 5. Display results
    console.log('--- Testing calculatePositionSize ---');
    console.log(`Symbol: ${symbol}`);
    console.log(`Initial Capital: ${bot.capital}`);
    console.log(`Max Risk Per Trade: ${bot.max_risk_per_trade * 100}%`);
    console.log(`Entry Price (Current Close): ${entry_price.toFixed(bot.priceMultiplier.toString().length -1)}`);
    console.log(`EMA_5: ${ema_5.toFixed(bot.priceMultiplier.toString().length - 1)}`);
    console.log(`EMA_10: ${ema_10.toFixed(bot.priceMultiplier.toString().length - 1)}`);
    console.log(`Calculated Avg Exit Price: ${avg_exit_price.toFixed(bot.priceMultiplier.toString().length - 1)}`);
    console.log('------------------------------------');
    console.log(`Loss per Unit: ${Math.abs(entry_price - avg_exit_price).toFixed(bot.priceMultiplier.toString().length - 1)}`);
    console.log(`Quantity by Risk: ${(bot.capital * bot.max_risk_per_trade / Math.abs(entry_price - avg_exit_price))}`);
    console.log(`Quantity by Capital: ${bot.capital / entry_price}`);
    console.log('------------------------------------');
    console.log(`Final Calculated Quantity (unrounded): ${positionSize}`);
    console.log(`Final Calculated Quantity (Rounded): ${finalQuantity}`);
    console.log(`Final Position Value (USD): ${(finalQuantity * entry_price).toFixed(2)}`);
    console.log('------------------------------------');
}

test_calculatePositionSize();
