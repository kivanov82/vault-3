import schedule from "node-schedule";
import {runMainStrategy1h, subscribeToEvents} from "./strategies/MainStrategy1h";
import {CopyTradingManager} from "./trade/CopyTradingManager";
import {StartupSync} from "./data/StartupSync";
import dotenv from "dotenv";

dotenv.config();

const DISABLE_ALGO_STRATEGY = process.env.DISABLE_ALGO_STRATEGY === 'true';
const ENABLE_COPY_TRADING = process.env.ENABLE_COPY_TRADING === 'true';
const COPY_POLL_INTERVAL = parseInt(process.env.COPY_POLL_INTERVAL_SECONDS || '600');

export class Vault3 {

    static async init(): Promise<any> {
        console.log('\n🚀 Vault-3 Initializing...');
        console.log(`   Algo Strategy: ${DISABLE_ALGO_STRATEGY ? '❌ DISABLED' : '✅ ENABLED'}`);
        console.log(`   Copy Trading: ${ENABLE_COPY_TRADING ? '✅ ENABLED' : '❌ DISABLED'}`);

        // Phase 1: Copytrading (ENABLED)
        if (ENABLE_COPY_TRADING) {
            console.log(`   Copy Poll Interval: ${COPY_POLL_INTERVAL}s\n`);

            // Sync recent fills on startup to ensure database is up to date
            await StartupSync.syncRecentFills();

            // Position-based polling every 30 seconds
            schedule.scheduleJob(`*/${COPY_POLL_INTERVAL} * * * * *`, () => {
                CopyTradingManager.scanTraders();
            });

            // Real-time WebSocket monitoring (for logging & analysis)
            CopyTradingManager.watchTraders();

            console.log('✅ Copytrading system started');
        }

        // Original 1H strategy (DISABLED in Phase 1)
        if (!DISABLE_ALGO_STRATEGY) {
            console.log('⚠️  Running legacy 1H strategy alongside copytrading\n');
            subscribeToEvents();
            schedule.scheduleJob("1 * * * *", () => {
                setTimeout(() => {
                    runMainStrategy1h(['ETH']);
                }, 50000);
                setTimeout(() => {
                    runMainStrategy1h(['BTC']);
                }, 85000);
            });
        }
    }
}
