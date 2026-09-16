import express from 'express';
import path from 'path';
import bparser from 'body-parser';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { strategy } from './helpers/middleware';
import apis from './routes/api';
import { startAppsIndexer } from './helpers/apps';
import { flushUsage, loadUsage } from './helpers/usage';

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

// Before listen, so the first request is counted against the history that is
// already on disk rather than starting a fresh day from zero.
loadUsage();

const server = app.listen(port, () => {
  console.log(`Listening on port ${port}`);
  // Builds the /api/apps answer in the background. It never throws to here: a
  // failed pass keeps the previous answer and logs.
  startAppsIndexer();
});

/**

 * Stop accepting, let in-flight requests finish, write the usage counts, exit.
 *
 * The handler itself is not optional once node is PID 1: the kernel applies no
 * default signal disposition to PID 1, so a process there reacts only to
 * signals it has explicitly handled. That part arrives with the deploy PR; this
 * one adds the usage write, so a stop does not discard the counts since the
 * last flush.
 *
 * The cap sits under docker's default 10s grace so a slow client cannot make
 * the shutdown outlast it and lose the counts anyway. This is a signing API:
 * dropping a broadcast mid-flight is worse than waiting a moment.
 */
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const finish = () => {
    flushUsage();
    process.exit(0);
  };
  // Idle keep-alive sockets do NOT count as in-flight, but server.close waits
  // for them, so without this every shutdown sat out the keep-alive timeout for
  // connections with nothing on them.
  if (server.closeIdleConnections) server.closeIdleConnections();
  server.close(finish);
  setTimeout(finish, 8000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
