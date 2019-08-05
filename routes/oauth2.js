const express = require('express');
const { createHash } = require('crypto');
const db = require('../helpers/db');
const { authenticate } = require('../helpers/middleware');
const { issueAppToken, issueAppRefreshToken } = require('../helpers/token');
const config = require('../config.json');

const router = express.Router(); // eslint-disable-line new-cap

/** Request app access token */
router.all('/token', authenticate(['code', 'refresh']), async (req, res) => {
  console.log(`Issue app token for user @${req.user} using @${req.proxy} proxy.`);
  let accessToken;
  try {
    accessToken = await issueAppToken(req.proxy, req.user, req.scope);
  } catch (e) {
    console.error('Unable to issue app token', e);
  }
  res.json({
    access_token: accessToken,
    refresh_token: issueAppRefreshToken(req.proxy, req.user, req.scope),
    expires_in: config.token_expiration,
    username: req.user,
  });
});

/** Revoke access token */
router.all('/token/revoke', authenticate('app'), async (req, res) => {
  const tokenHash = createHash('sha256').update(req.token).digest('hex');
  db.queryAsync('DELETE FROM token WHERE token_hash = ?', [tokenHash]).then(() => {
    res.json({ success: true });
  }).catch(() => {
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to revoke access token',
    });
  });
});

module.exports = router;
