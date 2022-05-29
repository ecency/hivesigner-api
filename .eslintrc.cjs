module.exports = {
  extends: ["airbnb-base"],
  parserOptions: {
    sourceType: "module",
  },
  parser: "babel-eslint",
  env: { 
    "node": true 
  },
  rules: {
    "no-console": process.env.NODE_ENV === "production" ? "error" : "off",
    "camelcase": "off",
    "import/prefer-default-export": "off",
    "no-underscore-dangle": 0,
    "no-param-reassign": 0,
  },
};
