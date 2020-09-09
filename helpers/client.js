import { Client } from '@hiveio/dhive';

const client = new Client(process.env.BROADCAST_URL || 'https://api.hive.blog');
client.database.getVersion().then((res) => {
  if (res.blockchain_version !== '0.23.0') {
    // true: eclipse rebranded rpc nodes
    // false: default old nodes (not necessary to call for old nodes)
    client.updateOperations(true);
  }
});
export default client;
