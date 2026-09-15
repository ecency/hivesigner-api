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

app.get('/_health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api', apis);

app.get('/*', (req, res) => {
  res.redirect(`https://${process.env.BROADCAST_NETWORK === 'mainnet' ? 'hivesigner.com' : 'testnet.hivesigner.com'}${req.url}`);
});

const server = app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});

/**
 * Stop accepting, let in-flight requests finish, exit.
 *
 * This is NOT optional once node is PID 1. The kernel applies no default signal
 * disposition to PID 1, so a process there only reacts to a signal it has
 * explicitly handled - node running as PID 1 with no handler simply IGNORES
 * SIGTERM. Measured: `docker stop -t 10` took 10.3s and exited 137, meaning
 * every deploy killed in-flight requests, broadcasts included.
 *
 * The cap sits under docker's default 10s grace so a slow client cannot make
 * the shutdown outlast it and end in SIGKILL anyway.
 */
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const finish = () => process.exit(0);
  server.close(finish);
  setTimeout(finish, 8000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
