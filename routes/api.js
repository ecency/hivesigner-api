const express = require('express');
const { authenticate, verifyPermissions } = require('../helpers/middleware');
const client = require('../helpers/client');
const { encode } = require('@steemit/steem-js/lib/auth/memo');
const { tokens } = require('../db/models');
const { issueUserToken } = require('../helpers/token');
const { getUserMetadata, updateUserMetadata } = require('../helpers/metadata');
const { getErrorMessage, isOperationAuthor, getAppProfile } = require('../helpers/utils');
const config = require('../config.json');
const redis = require('../helpers/redis');

const router = express.Router(); // eslint-disable-line new-cap

/** Update user_metadata */
router.put('/me', authenticate('app'), async (req, res) => {
  const scope = req.scope.length ? req.scope : config.authorized_operations;
  let accounts;
  try {
    accounts = await client.database.getAccounts([req.user]);
  } catch (err) {
    console.error(`Get account @${req.user} failed`, err);
    res.status(501).send('SteemAPI request failed');
    return;
  }
  const { user_metadata } = req.body;

  if (typeof user_metadata === 'object') { // eslint-disable-line camelcase
    /** Check object size */
    const bytes = Buffer.byteLength(JSON.stringify(user_metadata), 'utf8');
    if (bytes <= config.user_metadata.max_size) {
      /** Save user_metadata object on database */
      console.log(`Store object for @${req.user} (size ${bytes} bytes)`);
      try {
        await updateUserMetadata(req.proxy, req.user, user_metadata);
      } catch (err) {
        console.error(`Update metadata of @${req.user} failed`, err);
        res.status(501).send('request failed');
        return;
      }

      /** Store global metadata update count per month and by app */
      const month = new Date().getUTCMonth() + 1;
      const year = new Date().getUTCFullYear();
      redis.multi([
        ['incr', 'sc-api:metadata'],
        ['incr', `sc-api:metadata:${month}-${year}`],
        ['incr', `sc-api:metadata:@${req.proxy}`],
        ['incr', `sc-api:metadata:@${req.proxy}:${month}-${year}`],
      ]).execAsync();

      res.json({
        user: req.user,
        _id: req.user,
        name: req.user,
        account: accounts[0],
        scope,
        user_metadata,
      });
      return;
    }
    res.status(413).json({
      error: 'invalid_request',
      error_description: `User metadata object must not exceed ${config.user_metadata.max_size / 1000000} MB`,
    });
    return;
  }
  res.status(400).json({
    error: 'invalid_request',
    error_description: 'User metadata must be an object',
  });
});

/** Get my account details */
router.all('/me', authenticate(), async (req, res) => {
  const scope = req.scope.length ? req.scope : config.authorized_operations;
  let accounts;
  try {
    accounts = await client.database.getAccounts([req.user]);
  } catch (err) {
    console.error(`Get account @${req.user} failed`, err);
    res.status(501).send('SteemAPI request failed');
    return;
  }
  let userMetadata;
  try {
    userMetadata = req.role === 'app'
      ? await getUserMetadata(req.proxy, req.user)
      : undefined;
  } catch (err) {
    console.error(`Get user metadata of @${req.user} failed`, err);
    res.status(501).send('request failed');
    return;
  }
  res.json({
    user: req.user,
    _id: req.user,
    name: req.user,
    account: accounts[0],
    scope,
    user_metadata: userMetadata,
  });
});

/** Broadcast transaction */
router.post('/broadcast', authenticate('app'), verifyPermissions, async (req, res) => {
  const scope = req.scope.length ? req.scope : config.authorized_operations;
  const { operations } = req.body;

  let scopeIsValid = true;
  let requestIsValid = true;
  let invalidScopes = '';
  operations.forEach((operation) => {
    /** Check if operation is allowed */
    if (scope.indexOf(operation[0]) === -1) {
      scopeIsValid = false;
      invalidScopes += (invalidScopes !== '' ? ', ' : '') + operation[0];
    }
    /** Check if author of the operation is user */
    if (!isOperationAuthor(operation[0], operation[1], req.user)) {
      requestIsValid = false;
    }
  });

  if (!scopeIsValid) {
    res.status(401).json({
      error: 'invalid_scope',
      error_description: `The access_token scope does not allow the following operation(s): ${invalidScopes}`,
    });
  } else if (!requestIsValid) {
    res.status(401).json({
      error: 'unauthorized_client',
      error_description: `This access_token allow you to broadcast transaction only for the account @${req.user}`,
    });
  } else {
    /** Store global broadcast count per month and by app */
    const month = new Date().getUTCMonth() + 1;
    const year = new Date().getUTCFullYear();
    redis.multi([
      ['incr', 'sc-api:broadcast'],
      ['incr', `sc-api:broadcast:${month}-${year}`],
      ['incr', `sc-api:broadcast:@${req.proxy}`],
      ['incr', `sc-api:broadcast:@${req.proxy}:${month}-${year}`],
    ]).execAsync();

    /** Broadcast with Steem.js
    req.steem.broadcast.send(
      { operations, extensions: [] },
      { posting: process.env.BROADCASTER_POSTING_WIF },
      (err, result) => {
        if (!err) {
          console.log(`Broadcasted transaction for @${req.user} from app @${req.proxy}`);
          res.json({ result });
        } else {
          console.log(
            `Transaction broadcast failed for @${req.user}`,
            JSON.stringify(operations), JSON.stringify(err)
          );
          res.status(500).json({
            error: 'server_error',
            error_description: getErrorMessage(err) || err.message || err,
          });
        }
      }
    );
    */

    /** Sign and prepare tx with dsteem, broadcast with Steem.js */
    client.customPrepareTx(operations, process.env.BROADCASTER_POSTING_WIF).then((signedTx) => {
      req.steem.api.broadcastTransactionSynchronousAsync(signedTx).then((result) => {
        console.log(`Broadcast transaction for @${req.user} from app @${req.proxy}`);
        res.json({ result });
      }).catch((e) => {
        console.log(
          `Transaction broadcast failed for @${req.user}`,
          JSON.stringify(operations), getErrorMessage(e) || e.message,
        );
        res.status(500).json({
          error: 'server_error',
          error_description: getErrorMessage(e) || e.message || e,
        });
      });
    }).catch((e) => {
      console.error('Prepare transaction failed', JSON.stringify(e));
      res.status(500).json({
        error: 'server_error',
        error_description: getErrorMessage(e) || e.message || e,
      });
    });
  }
});

router.all('/login/challenge', async (req, res) => {
  const { username } = req.query;
  const role = ['posting', 'active', 'owner'].includes(req.query.role) ? req.query.role : 'posting';
  const token = issueUserToken(username);
  let accounts;
  try {
    accounts = await client.database.getAccounts([username]);
  } catch (err) {
    console.error(`Get account @${username} failed`, err);
    res.status(501).send('SteemAPI request failed');
    return;
  }
  const keyAuths = accounts[0][role].key_auths;
  const codes = keyAuths.map(keyAuth => encode(process.env.BROADCASTER_POSTING_WIF, keyAuth[0], `#${token}`));
  res.json({
    username,
    codes,
  });
});

/**
  Revoke app tokens for a user
  If appId is not provided all the tokens for all the apps are revoked
*/
router.all('/token/revoke/:type/:clientId?', authenticate('user'), async (req, res) => {
  const { clientId, type } = req.params;
  const { user } = req;
  const where = {};

  if (type === 'app' && clientId) {
    const app = await getAppProfile(clientId);
    if (app.creator && app.creator === user) {
      where.client_id = clientId;
    }
  } else if (type === 'user') {
    where.user = user;
    if (clientId) {
      where.client_id = clientId;
    }
  }

  if (
    (type === 'user' && (where.user || where.client_id))
    || (type === 'app' && where.client_id)
  ) {
    await tokens.destroy({ where });
  }

  res.json({ success: true });
});

module.exports = router;
