import schedule from "node-schedule";
import {CopyTradingManager} from "./trade/CopyTradingManager";
import {StartupSync} from "./data/StartupSync";
import dotenv from "dotenv";

dotenv.config();

const ENABLE_COPY_TRADING = process.env.ENABLE_COPY_TRADING === 'true';
const COPY_POLL_INTERVAL_MINUTES = parseInt(process.env.COPY_POLL_INTERVAL_MINUTES || '5');

export class Vault3 {

    static async init(): Promise<any> {
        console.log('\n🚀 Vault-3 Initializing...');
        console.log(`   Copy Trading: ${ENABLE_COPY_TRADING ? '✅ ENABLED' : '❌ DISABLED'}`);

        // Heartbeat to ensure process is alive and monitor resources
        setInterval(() => {
            const uptime = Math.floor(process.uptime() / 60);
            const mem = process.memoryUsage();
            console.log(`💓 Heartbeat: ${uptime}m uptime | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`);

            // Force garbage collection if memory is high (if --expose-gc flag is used)
            if (global.gc && mem.heapUsed > 200 * 1024 * 1024) {
                console.log('🗑️  Running garbage collection (heap > 200MB)');
                global.gc();
            }
        }, 5 * 60 * 1000); // Every 5 minutes

        if (ENABLE_COPY_TRADING) {
            console.log(`   Copy Poll Interval: ${COPY_POLL_INTERVAL_MINUTES} minutes\n`);

            // Sync recent fills on startup to ensure database is up to date
            await StartupSync.syncRecentFills();

            // Run initial scan immediately
            console.log('🔄 Running initial position scan...');
            try {
                await CopyTradingManager.scanTraders();
            } catch (error: any) {
                console.error(`❌ Initial scan failed: ${error.message}`);
            }

            // Position-based polling - every N minutes at second 0
            schedule.scheduleJob(`0 */${COPY_POLL_INTERVAL_MINUTES} * * * *`, async () => {
                try {
                    console.log(`⏰ [${new Date().toISOString()}] Running scheduled position scan...`);
                    await CopyTradingManager.scanTraders();
                } catch (error: any) {
                    console.error(`❌ Scheduled scan failed: ${error.message}`);
                    console.error(error.stack);
                }
            });

            // Real-time WebSocket monitoring (for logging & analysis)
            CopyTradingManager.watchTraders();

            console.log('✅ Copytrading system started');
        } else {
            console.log('⚠️  Copy trading is disabled');
        }
    }
}
