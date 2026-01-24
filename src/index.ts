import express from 'express';
import {Vault3} from "./service/Vault3";

const app = express();
const cors = require('cors');
const port = process.env.PORT || 3000;

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
