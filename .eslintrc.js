module.exports = {
  extends: ['airbnb-base'],
  rules: {
    'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'off',
    'camelcase': 'off',
    "no-underscore-dangle": 0,
    "no-param-reassign": 0,
  },
};
