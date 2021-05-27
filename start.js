import express from 'express';
import path from 'path';
import bparser from 'body-parser';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { strategy } from './helpers/middleware';
import apis from './routes/api';

const { json, urlencoded } = bparser;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.API_PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.enable('trust proxy');
app.disable('x-powered-by');

app.use(json({ limit: '20mb' }));
app.use(urlencoded({ limit: '20mb', extended: false }));
app.use(cors());
app.use(strategy);
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apis);

app.get('/*', (req, res) => {
  res.redirect(`https://${process.env.BROADCAST_NETWORK === 'mainnet' ? 'hivesigner.com' : 'testnet.hivesigner.com'}${req.url}`);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
