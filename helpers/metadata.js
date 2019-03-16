const db = require('../helpers/db');

const getUserMetadata = async (clientId, username) => {
  try {
    const query = 'SELECT metadata FROM metadata WHERE client_id = ? AND username = ? LIMIT 1';
    const result = await db.queryAsync(query, [clientId, username]);
    if (result[0]) return JSON.parse(result[0].metadata);
  } catch (e) {
    console.error('Failed to get user metadata', JSON.stringify(e));
    throw new Error(e);
  }
  return {};
};

const updateUserMetadata = async (clientId, username, metadata) => {
  try {
    const params = {
      client_id: clientId,
      username,
      metadata: JSON.stringify(metadata),
    };
    const query = 'REPLACE INTO metadata SET ?';
    await db.query(query, [params]);
  } catch (e) {
    console.error('Failed to update user metadata', JSON.stringify(e));
    throw new Error(e);
  }
};

module.exports = {
  getUserMetadata,
  updateUserMetadata,
};
