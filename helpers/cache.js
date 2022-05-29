import NodeCache from 'node-cache';

export default const cache = new NodeCache({stdTTL: 0, checkperiod: 600});