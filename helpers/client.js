import { Client } from '@hiveio/dhive';

const client = new Client(process.env.BROADCAST_URL || 'https://api.hive.blog', { rebrandedApi: true });

export default client;
