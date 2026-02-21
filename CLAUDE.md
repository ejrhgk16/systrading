# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Automated cryptocurrency futures trading bot targeting Bybit exchange. Executes volatility-based strategies on 4-hour candles using Bollinger Bands, DMI/ADX, and Alligator indicators. Firebase Firestore persists position state across restarts.

## Running the Bot

```bash
node main.js          # Start the bot (WebSocket + cron scheduler)
```

No build step — ES6 modules run directly with Node.js. The project uses `"type": "module"` in package.json.

## Running Tests

Tests are ad-hoc scripts (no test framework). Run individually:

```bash
node test/algo2.test.js
node test/indicatior_test.js
node test/position_size_test.js
node test/final_flow.test.js
```

## Architecture

### Entry Point: `main.js`
- Authenticates Firebase, initializes algorithm instances per symbol (BTCUSDT, ETHUSDT)
- Two cron jobs: 4-hour candle trigger (`scheduleFunc`) and daily SPX/VIX at 21:30 UTC
- WebSocket listener routes order fill events to the correct algorithm instance by matching `orderLinkId`

### Algorithm Layer: `alogs_crypto/`

모든 전략은 **Class**로 구현하며, `main.js`가 요구하는 3개 메서드 인터페이스를 반드시 갖춰야 한다:

| 메서드 | 호출 시점 | 역할 |
|---|---|---|
| `set()` | 봇 시작 시 1회 | 환경변수 로드, Firestore에서 이전 포지션 상태 복원 |
| `scheduleFunc()` | 크론 스케줄마다 | 캔들 조회 → 지표 계산 → 진입/청산 주문 실행 |
| `orderEventHandle(element)` | WebSocket 주문 체결 이벤트 | 체결 알림 수신 후 다음 단계(스탑 세팅 등) 트리거 |

**`main.js` 연결 방법:**
1. Class 인스턴스를 심볼별 map으로 생성: `{ BTCUSDT: new MyAlgo('BTCUSDT'), ... }`
2. 시작 시 `await Promise.all(objs.map(o => o.set()))`
3. 크론에서 `obj.scheduleFunc()` 호출 (10분 타임아웃 `Promise.race` 적용)
4. WebSocket `update` 이벤트에서 `orderLinkId` 패턴으로 해당 인스턴스에 `orderEventHandle()` 라우팅

**크론 표현식:** `'1 0 */4 * * *'` (UTC 기준 매 4시간 00:01 — 00:01, 04:01, 08:01, 12:01, 16:01, 20:01)

**크론 누락 방지:** node-cron의 `missed execution`은 이벤트 루프 블로킹(GC, WebSocket SDK 등)으로 발생. `scheduleWithWatchdog()`으로 등록하면 내부적으로 `task.on('execution:missed')` 이벤트를 구독해 누락 즉시(몇 초 내) `task.execute()`로 재실행. node-cron v4는 내부적으로 `setTimeout` 기반으로 다음 실행 시각을 계산함.

**현재 활성 전략:**
- **`alog2Class.js`** (`alog2_bb2`) — Bollinger Bands breakout + ADX > 20 + Alligator 확인. 상태 머신: `set → open → openOrderFilledCallback → updateStop → reset`
- **`alog1Class.js`** — DMI+BB 드래프트, `main.js`에 미연결

### Common Utilities: `common/`
- `client.js` — Exports `rest_client`, `ws_client`, `ws_api_client` (Bybit SDK instances)
- `logger.js` — Winston loggers: `fileLogger` (daily files in `logs/`) and `consoleLogger` (colored output). Custom log level `order` (cyan) for trade events.
- `indicatior.js` — Technical indicators: `calculateDMI`, `calculateBB`, `calculateEMA`, `calculateAlligator`, `calculateRSI`
- `util.js` — `getKline()` fetches OHLCV data (oldest-first), `sendTelegram()` sends alerts. Also exports scheduling helpers:
  - `runWithTimeout(taskFn, label, timeoutMs)` — Promise.race + timeout 래퍼. 시작/완료/오류 로그 자동 처리
  - `scheduleWithWatchdog(expression, taskFn)` — node-cron 등록 + `execution:missed` 이벤트 구독. 누락 즉시 `task.execute()` 재실행
  - `CRON_JOB_TIMEOUT_MS` (10분) 상수 export

### Database: `db/`
- `firebaseConfig.js` — Initializes Firebase, exports `db` and `auth`
- `firestoreFunc.js` — `getTradeStatus(docId)` / `setTradeStatus(docId, data, merge)` for position persistence; `addTradeLog()` for hierarchical trade history at `trade_log/{algo_id}/{date}/`

### Finance Algorithms: `alogs_finance/`
- `alog1Class_spx_vix.js` — Fetches SPX RSI + VIX term structure via `yahoo-finance2`, sends Telegram summary

## Key Conventions

### Order Linking
Order IDs follow the pattern `alog2_{symbol}_bb2` (e.g., `alog2_BTCUSDT_bb2`). The WebSocket handler in `main.js` uses this to route fill events to the correct algo instance.

### Position Sizing
Risk is 2% of capital per trade. Exit orders are split into thirds (`exit_size_1/2/3`) at Alligator line levels (`exit_price_1/2/3`).

### Environment Variables
All trading parameters are in `.env` (never committed). Key patterns:
- `algo2_{SYMBOL}_capital` — Capital allocated per symbol
- `algo2_{SYMBOL}_leverage` — Leverage multiplier
- `{SYMBOL}_decimal_qty` / `{SYMBOL}_decimal_price` — Precision for order formatting

### Firestore Document IDs
Position state documents use `algo2_{SYMBOL}` (e.g., `algo2_BTCUSDT`). The algo calls `getTradeStatus` on startup to restore state after restarts.

## Dependencies

- `bybit-api` — Exchange REST + WebSocket
- `firebase` — Firestore persistence and Auth
- `node-cron` — Scheduling
- `winston` — Logging
- `yahoo-finance2` — SPX/VIX data
- `axios` — HTTP (Telegram API calls)
