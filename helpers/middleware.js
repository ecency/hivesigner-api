import { createHash } from 'crypto';
import pkg from 'lodash';
import { verify } from './token';
import { getAppProfile, b64uToB64 } from './utils';
import { client, getAccount } from './client';
import cjson from '../config.json' assert { type: "json" };

const { intersection, has } = pkg;
const { authorized_operations } = cjson;

/**
 * Check if user allow app proxy account to post on his behalf
 * And if app allow @hivesigner to post on his behalf
 */
export const verifyPermissions = async (req, res, next) => {
  let proxyAccount;
  let userAccount;
  try {
    proxyAccount = await getAccount(req.proxy);
  } catch (e) {
    console.error(new Date().toISOString(), client.currentAddress, 'Unable to load proxy account from hived', req.proxy, e);
  }
  try {
    userAccount = await getAccount(req.user, false);
  } catch (e) {
    console.error(new Date().toISOString(), client.currentAddress, 'Unable to load user account from hived', req.user, e);
  }

  if (!has(proxyAccount, '[0].name') || !has(userAccount, '[0].name')) {
    res.status(401).json({
      error: 'unauthorized_client',
      error_description: `The app @${req.proxy} or user @${req.user} account failed to load`,
    });
  } else {
    const userAccountAuths = userAccount[0].posting.account_auths.map((account) => account[0]);
    if (userAccountAuths.indexOf(req.proxy) === -1) {
      res.status(401).json({
        error: 'unauthorized_client',
        error_description: `The app @${req.proxy} doesn't have permission to broadcast for @${req.user}`,
      });
    } else {
      const appAccountAuths = proxyAccount[0].posting.account_auths.map((account) => account[0]);
      if (appAccountAuths.indexOf(process.env.BROADCASTER_USERNAME) === -1) {
        res.status(401).json({
          error: 'unauthorized_client',
          error_description: `Broadcaster account doesn't have permission to broadcast for @${req.proxy}`,
        });
      } else {
        next();
      }
    }
  }
};

export const strategy = (req, res, next) => {
  let authorization = req.get('authorization');
  if (authorization) authorization = authorization.replace(/^(Bearer|Basic)\s/, '').trim();
  const token = authorization
    || req.query.access_token
    || req.body.access_token
    || req.query.code
    || req.body.code
    || req.query.refresh_token
    || req.body.refresh_token;
  const memo = req.query.memo || req.body.memo;

  if (token) {
    try {
      //console.log(token);
      const decoded = Buffer.from(b64uToB64(token), 'base64').toString();
      const tokenObj = JSON.parse(decoded);
      const signedMessage = tokenObj.signed_message;
      if (
        tokenObj.authors
        && tokenObj.authors[0]
        && tokenObj.signatures
        && tokenObj.signatures[0]
        && signedMessage
        && signedMessage.type
        && ['login', 'posting', 'offline', 'code', 'refresh']
          .includes(signedMessage.type)
        && signedMessage.app
      ) {
        const message = JSON.stringify({
          signed_message: signedMessage,
          authors: tokenObj.authors,
          timestamp: tokenObj.timestamp,
        });
        const username = tokenObj.authors[0];
        verify(message, username, tokenObj.signatures[0], (err, isValid) => {
          if (!err && isValid) {
            console.log(new Date().toISOString(), client.currentAddress, 'Token signature is valid', username);
            let scope;
            if (signedMessage.type === 'login') scope = ['login'];
            if (['posting', 'offline', 'code', 'refresh']
              .includes(signedMessage.type)) scope = authorized_operations;
            let role = 'app';
            if (signedMessage.type === 'code') role = 'code';
            if (signedMessage.type === 'refresh') role = 'refresh';
            /* eslint-disable no-param-reassign */
            req.token = token;
            req.role = role;
            req.user = username;
            req.proxy = signedMessage.app;
            req.scope = scope;
            req.type = 'signature';
            if (memo) {
              req.memo = memo;
            }
            /* eslint-enable no-param-reassign */
          }
          next();
        });
      } else {
        next();
      }
    } catch (e) {
      console.log(new Date().toISOString(), client.currentAddress, 'Token signature decoding failed', token);
      next();
    }
  } else {
    next();
  }
};

export const authenticate = (roles) => async (req, res, next) => {
  const role = Array.isArray(roles) && req.role && roles.includes(req.role)
    ? req.role : roles;

  if (!req.role || (role && req.role !== role)) {
    res.status(401).json({
      error: 'invalid_grant',
      error_description: 'The token has invalid role',
    });
  } else if (['code', 'refresh'].includes(req.role)) {
    let app;
    try {
      app = await getAppProfile(req.proxy);
    } catch (e) {
      console.error(new Date().toISOString(), 'Failed to get app profile', e);
    }

    const secret = req.query.client_secret || req.body.client_secret;
    const secretHash = createHash('sha256').update(secret).digest('hex');

    if (app && (!app.secret || secretHash !== app.secret)) {
      res.status(401).json({
        error: 'invalid_grant',
        error_description: 'The code or secret is not valid',
      });
    } else if (app && app.allowed_ips && app.allowed_ips.length > 0) {
      const reqIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      if (intersection(app.allowed_ips, reqIp.replace(' ', '').split(',')).length > 0) {
        next();
      } else {
        res.status(401).json({
          error: 'unauthorized_access',
          error_description: `The IP ${reqIp} is not authorized`,
        });
      }
    } else {
      next();
    }
  } else {
    next();
  }
};
