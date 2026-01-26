import express from 'express';
import {Vault3} from "./service/Vault3";

const app = express();
const cors = require('cors');
const port = process.env.PORT || 3000;

// Global error handlers to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Promise Rejection:', reason);
    console.error('Promise:', promise);
    // Don't exit - keep the scheduler running
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    // Don't exit - keep the scheduler running
});

// Handle graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`👋 ${signal} received, shutting down gracefully...`);
    try {
        // Import prisma to disconnect
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();

        // Disconnect database
        await Promise.race([
            prisma.$disconnect(),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);

        // Give other ongoing operations 2 more seconds to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('✅ Shutdown complete');
    } catch (e) {
        console.error('Error during shutdown:', e);
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.use(express.json())                   //Express
    .use(cors())                            //CORS enabled
    //BigInt  serializer
    .use((req, res, next) => {
        res.json = (data) => {
            return res.send(JSON.stringify(data, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        };
        next();
    });

app.get('/', (req, res) => {
    res.send('Welcome to Vault 3 API');
});


app.listen(port, () => {
    Vault3.init();
});

export default app;
