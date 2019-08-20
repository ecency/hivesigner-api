const express = require('express');
const { authenticate, verifyPermissions } = require('../helpers/middleware');
const { getUserMetadata, updateUserMetadata } = require('../helpers/metadata');
const { getErrorMessage, isOperationAuthor } = require('../helpers/utils');
const { issue } = require('../helpers/token');
const client = require('../helpers/client');
const steem = require('../helpers/steem');
const redis = require('../helpers/redis');
const metadataApps = require('../helpers/metadata.json');
const config = require('../config.json');

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
  const userMetadata = req.body.user_metadata;

  if (typeof userMetadata === 'object') { // eslint-disable-line camelcase
    /** Check object size */
    const bytes = Buffer.byteLength(JSON.stringify(userMetadata), 'utf8');
    if (bytes <= config.user_metadata.max_size) {
      /** Save userMetadata object on database */
      console.log(`Store object for @${req.user} (size ${bytes} bytes)`);
      try {
        await updateUserMetadata(req.proxy, req.user, userMetadata);
      } catch (err) {
        console.error(`Update metadata of @${req.user} failed`, err);
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

  let userMetadata = null;
  if (metadataApps.includes(req.proxy)) {
    try {
      userMetadata = req.role === 'app'
        ? await getUserMetadata(req.proxy, req.user)
        : undefined;
    } catch (err) {
      console.error(`Get user metadata of @${req.user} failed`, err);
      res.status(501).send('request failed');
      return;
    }
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
    ]).execAsync()
      .catch(e => console.error('Failed to incr data on redis', e));

    /** Broadcast with Steem.js */
    steem.broadcast.send(
      { operations, extensions: [] },
      { posting: process.env.BROADCASTER_POSTING_WIF },
      (err, result) => {
        if (!err) {
          console.log(`Broadcasted transaction for @${req.user} from app @${req.proxy}`);
          res.json({ result });
        } else {
          console.log(`Transaction broadcast failed for @${req.user}`, JSON.stringify(err));
          res.status(500).json({
            error: 'server_error',
            error_description: getErrorMessage(err) || err.message || err,
            response: err,
          });
        }
      },
    );
  }
});

/** Request app access token */
router.all('/oauth2/token', authenticate(['code', 'refresh']), async (req, res) => {
  console.log(`Issue app token for user @${req.user} using @${req.proxy} proxy.`);
  res.json({
    access_token: issue(req.proxy, req.user, 'posting'),
    refresh_token: issue(req.proxy, req.user, 'refresh'),
    expires_in: config.token_expiration,
    username: req.user,
  });
});

/** Revoke access token */
router.all('/oauth2/token/revoke', authenticate('app'), async (req, res) => {
  res.json({ success: true });
});

module.exports = router;
