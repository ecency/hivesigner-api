import hivejs from '@hiveio/hive-js';

if (process.env.BROADCAST_URL) {
  hivejs.api.setOptions({ url: process.env.BROADCAST_URL });
}

export default hivejs;
