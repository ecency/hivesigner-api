module.exports = {
  extends: ["airbnb-base"],
  parser: "@babel/eslint-parser",
  parserOptions: {
    sourceType: "module",
    ecmaVersion: 2022,
    requireConfigFile: false,
    babelOptions: {
      plugins: ["@babel/plugin-syntax-import-assertions"],
    },
  },
  env: {
    node: true,
  },
  rules: {
    "no-console": process.env.NODE_ENV === "production" ? "error" : "off",
    camelcase: "off",
    "import/prefer-default-export": "off",
    "no-underscore-dangle": 0,
    "no-param-reassign": 0,
  },
};
