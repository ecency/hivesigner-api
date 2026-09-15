import express from 'express';
import path from 'path';
import bparser from 'body-parser';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { strategy } from './helpers/middleware';
import apis from './routes/api';
import { startAppsIndexer } from './helpers/apps';
import { flushUsage, loadUsage, usageRecorder } from './helpers/usage';

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
// AFTER strategy, which is what verifies the token and sets req.proxy. This is
// the app directory's primary signal: which apps are actually being used.
app.use(usageRecorder);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/_health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api', apis);

app.get('/*', (req, res) => {
  res.redirect(`https://${process.env.BROADCAST_NETWORK === 'mainnet' ? 'hivesigner.com' : 'testnet.hivesigner.com'}${req.url}`);
});

// Before listen, so the first request is counted against the history that is
// already on disk rather than starting a fresh day from zero.
loadUsage();

process.on('SIGTERM', flushUsage);
process.on('SIGINT', flushUsage);

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
  // Builds the /api/apps answer in the background. It never throws to here: a
  // failed pass keeps the previous answer and logs.
  startAppsIndexer();
});
