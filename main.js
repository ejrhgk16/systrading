#!/usr/bin/env node
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env'), override: true });

import { consoleLogger } from './common/logger.js';
import { initCLI } from './common/cli.js';
import { registerCryptoCommands } from './alogs_crypto/command.js';
import { registerTradifiCommands } from './alogs_tradifi/command.js';
import { auth } from './db/firebaseConfig.js';
import { signInWithEmailAndPassword } from "firebase/auth";

import { initTradifi } from './alogs_tradifi/init.js';
// import { initCrypto } from './alogs_crypto/init.js';

async function main() {

  consoleLogger.info("env_version : ", process.env.env_ver)

  try {
    consoleLogger.info("Firebase 로그인을 시도합니다...");
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_USER_EMAIL, process.env.FIREBASE_USER_PASSWORD);
    consoleLogger.info("Firebase 로그인 성공.");
  } catch (error) {
    consoleLogger.error("Firebase 로그인 실패:", error);
    process.exit(1);
  }

  const { map: tradifiMap, cron: tradifiCron } = await initTradifi();
  // const { map: cryptoMap, cron: cryptoCron } = await initCrypto();

  const strategyMap = { tradifi: tradifiMap /* , crypto: cryptoMap */ };
  const cronTasks = { ...tradifiCron /* , ...cryptoCron */ };

  registerTradifiCommands(strategyMap.tradifi);
  // registerCryptoCommands(strategyMap.crypto);
  initCLI(strategyMap, cronTasks);
}

main();
