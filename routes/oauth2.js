const express = require('express');
const { tokens } = require('../db/models');
const { authenticate } = require('../helpers/middleware');
const { issueAppToken, issueAppCode, issueAppRefreshToken } = require('../helpers/token');
const config = require('../config.json');

const router = express.Router(); // eslint-disable-line new-cap

router.all('/authorize', authenticate('user'), async (req, res) => {
  const clientId = req.query.client_id;
  const responseType = req.query.response_type;
  const scope = req.query.scope ? req.query.scope.split(',') : [];

  if (responseType === 'code') {
    console.log(`Issue app code for user @${req.user} using @${clientId} proxy.`);
    const code = issueAppCode(clientId, req.user, scope);
    res.json({ code });
  } else {
    console.log(`Issue app token for user @${req.user} using @${clientId} proxy.`);

    let accessToken;
    try {
      accessToken = await issueAppToken(clientId, req.user, scope);
    } catch (e) {
      console.error('Unable to issue app token on authorize', e);
    }

    res.json({
      access_token: accessToken,
      expires_in: config.token_expiration,
      username: req.user,
    });
  }
});

/** Request app access token */
router.all('/token', authenticate(['code', 'refresh']), async (req, res) => {
  console.log(`Issue app token for user @${req.user} using @${req.proxy} proxy.`);

  let accessToken;
  try {
    accessToken = await issueAppToken(req.proxy, req.user, req.scope);
  } catch (e) {
    console.error('Unable to issue app token', e);
  }

  const payload = {
    access_token: accessToken,
    expires_in: config.token_expiration,
    username: req.user,
  };
  if (req.scope.includes('offline')) {
    payload.refresh_token = issueAppRefreshToken(req.proxy, req.user, req.scope);
  }
  res.json(payload);
});

/** Revoke app access token */
router.all('/token/revoke', authenticate('app'), async (req, res) => {
  await tokens.destroy({ where: { token: req.token } });
  res.json({ success: true });
});

module.exports = router;
