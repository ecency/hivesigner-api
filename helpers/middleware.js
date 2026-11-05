import { createHash, timingSafeEqual } from 'crypto';
import NodeCache from 'node-cache';
import pkg from 'lodash';
import { verify } from './token.js';
import { getAppProfile, b64uToB64 } from './utils.js';
import { getAccount } from './client.js';
import cjson from '../config.json' with { type: 'json' };

const { intersection, has } = pkg;
const { authorized_operations } = cjson;

/**
 * PKCE (RFC 7636) on the code flow.
 *
 * The authorize page puts `code_challenge` and `code_challenge_method` INSIDE
 * the signed message of a code, so nobody can add, swap or drop the challenge
 * after the user approved without breaking the user's signature. Exchanging
 * such a code needs the `code_verifier` whose SHA-256 is that challenge, which
 * only the app that started the flow knows. That is what makes a code that
 * travels through a custom scheme (`myapp://cb?code=...`) safe: another app
 * that receives the link cannot exchange it.
 *
 * Codes WITHOUT a challenge are untouched: no age limit, reusable, secret
 * required, exactly as before.
 */
/** How long a PKCE code can be exchanged after it was signed, in seconds. */
export const PKCE_CODE_LIFETIME = 10 * 60;
/**
 * How far the signer's clock may differ from this server's, either way. The
 * timestamp comes from the user's browser or phone, so a clock a few minutes
 * fast or slow must not fail the sign-in: a code may be dated this much ahead,
 * and is accepted this much past its lifetime.
 */
const PKCE_CLOCK_SKEW = 5 * 60;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * PKCE codes that were already exchanged, so each is exchanged once. Kept in
 * memory: the API runs as one replica (docker-compose.yml), and a code expires
 * on its own (USED_CODE_TTL), so an entry only has to outlive that. A
 * restart forgets the list, which still leaves the verifier and the age limit
 * standing. Running more replicas needs a shared store here.
 */
// A code dated PKCE_CLOCK_SKEW ahead is accepted until LIFETIME + SKEW past
// its date, plus a second of flooring; the margin keeps the entry alive past
// its last valid moment so it can never be exchanged a second time.
export const USED_CODE_TTL = PKCE_CODE_LIFETIME + 2 * PKCE_CLOCK_SKEW + 5;
const exchangedCodes = new NodeCache({
  stdTTL: USED_CODE_TTL, checkperiod: 120, useClones: false,
});

const param = (req, name) => (req.body && req.body[name]) || (req.query && req.query[name]);

/** Why a PKCE code cannot be exchanged with this verifier, or null when it can. */
const pkceProblem = (pkce, verifier) => {
  if (pkce.method !== 'S256' || typeof pkce.challenge !== 'string' || !CHALLENGE_RE.test(pkce.challenge)) {
    return 'The code challenge is not valid, only S256 is supported';
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(pkce.timestamp)) return 'The code timestamp is not valid';
  if (pkce.timestamp - now > PKCE_CLOCK_SKEW) {
    // The usual cause is a signer that wrote milliseconds.
    return 'The code is dated in the future (the timestamp is in seconds)';
  }
  if (now - pkce.timestamp > PKCE_CODE_LIFETIME + PKCE_CLOCK_SKEW) return 'The code has expired';
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) {
    return 'The code verifier is missing or not valid';
  }
  const expected = Buffer.from(pkce.challenge);
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return 'The code verifier does not match the code challenge';
  }
  return null;
};

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
    console.error(new Date().toISOString(), 'Unable to load proxy account from hived', req.proxy, e);
  }
  try {
    userAccount = await getAccount(req.user, false);
  } catch (e) {
    console.error(new Date().toISOString(), 'Unable to load user account from hived', req.user, e);
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
            console.log(new Date().toISOString(), 'Token signature is valid', username);
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
            if (role === 'code' && Object.prototype.hasOwnProperty.call(signedMessage, 'code_challenge')) {
              req.pkce = {
                challenge: signedMessage.code_challenge,
                method: signedMessage.code_challenge_method,
                timestamp: tokenObj.timestamp,
                // What the user signed, so a re-encoded copy of the same code
                // counts as the same code for the single-use check.
                id: createHash('sha256').update(message).digest('hex'),
              };
            }
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
      console.log(new Date().toISOString(), 'Token signature decoding failed', token);
      next();
    }
  } else {
    next();
  }
};

export const authenticate = (roles) => async (req, res, next) => {
  // Judged once: asked twice, a second boundary between the calls could pass
  // the code the first call refused and leave the answer without a reason.
  const pkceFailure = req.pkce ? pkceProblem(req.pkce, param(req, 'code_verifier')) : null;
  const role = Array.isArray(roles) && req.role && roles.includes(req.role)
    ? req.role : roles;

  if (!req.role || (role && req.role !== role)) {
    res.status(401).json({
      error: 'invalid_grant',
      error_description: 'The token has invalid role',
    });
  } else if (req.pkce && !(Array.isArray(roles) && roles.includes('code'))) {
    // A PKCE code is only ever exchanged. Everywhere else (/me, /decode) a
    // code is accepted with the client secret, and a PKCE app has none.
    res.status(401).json({
      error: 'invalid_grant',
      error_description: 'The code can only be exchanged at /api/oauth2/token',
    });
  } else if (pkceFailure) {
    res.status(401).json({
      error: 'invalid_grant',
      error_description: pkceFailure,
    });
  } else if (['code', 'refresh'].includes(req.role)) {
    // Only the app the code was issued to may exchange it, proven by its
    // secret. Every path where that cannot be checked refuses.
    let app;
    try {
      app = await getAppProfile(req.proxy);
    } catch (e) {
      console.error(new Date().toISOString(), 'Failed to get app profile', req.proxy, e.message);
      if (e.code !== 'not_app') {
        // Temporary, so the app retries instead of dropping its refresh token.
        res.status(503).json({
          error: 'temporarily_unavailable',
          error_description: 'Could not verify the app, try again',
        });
        return;
      }
    }

    const secret = param(req, 'client_secret');
    const secretHash = typeof secret === 'string' && secret
      ? createHash('sha256').update(secret).digest('hex')
      : null;
    // An app with a secret is a server-side app and keeps proving it with the
    // secret, PKCE or not: otherwise anyone who starts a flow with their own
    // challenge and gets hold of the resulting code could skip the secret.
    // Two exceptions, both for a PKCE code sent WITHOUT a secret: an app with no
    // secret at all (a native or browser app that could not keep one), and an
    // app whose owner opted in with `pkce_public: true` because it also has a
    // native app (Ecency's website holds the secret, Waves cannot). A secret
    // that is sent must always be the right one.
    const secretOk = !!app && !!app.secret && !!secretHash && secretHash === app.secret;
    const publicClient = !!app && !!req.pkce && !secretHash
      && (!app.secret || app.pkce_public === true);

    // Every check passed. A PKCE code is used up here and nowhere earlier, so a
    // wrong verifier from whoever intercepted it does not burn the real app's
    // code. No await between the lookup and the set: concurrent exchanges of
    // one code cannot both get through.
    const grant = () => {
      if (req.pkce) {
        if (exchangedCodes.has(req.pkce.id)) {
          res.status(401).json({
            error: 'invalid_grant',
            error_description: 'The code was already used',
          });
          return;
        }
        exchangedCodes.set(req.pkce.id, true);
      }
      // A public client gets no refresh token: refreshing needs the secret.
      req.publicClient = publicClient; // eslint-disable-line no-param-reassign
      next();
    };

    if (!app || (!publicClient && !secretOk)) {
      res.status(401).json({
        error: 'invalid_grant',
        error_description: 'The code or secret is not valid',
      });
    } else if (app.allowed_ips && app.allowed_ips.length > 0) {
      const reqIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      if (intersection(app.allowed_ips, reqIp.replace(' ', '').split(',')).length > 0) {
        grant();
      } else {
        res.status(401).json({
          error: 'unauthorized_access',
          error_description: `The IP ${reqIp} is not authorized`,
        });
      }
    } else {
      grant();
    }
  } else {
    next();
  }
};
