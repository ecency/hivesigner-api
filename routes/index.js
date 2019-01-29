const express = require('express');

const router = express.Router(); // eslint-disable-line new-cap

router.get('/*', (req, res) => {
  res.redirect(`https://app.steemconnect.com${req.path}`);
});

module.exports = router;
