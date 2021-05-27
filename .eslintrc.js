module.exports = {
  extends: ['airbnb-base'],
  env: {
    es6: true
  },
  rules: {
    'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'off',
    'camelcase': 'off',
    "no-underscore-dangle": 0,
    "no-param-reassign": 0,
  },
  settings: {
    'import/extensions': [
      '.js',
      '.json',
    ],
  }
};
