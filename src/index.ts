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
process.on('SIGTERM', async () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    try {
        // Give ongoing operations 5 seconds to complete
        await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (e) {
        console.error('Error during shutdown:', e);
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('👋 SIGINT received, shutting down gracefully...');
    try {
        await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (e) {
        console.error('Error during shutdown:', e);
    }
    process.exit(0);
});

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
