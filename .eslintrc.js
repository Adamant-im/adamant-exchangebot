module.exports = {
  env: {
    commonjs: true,
    es2021: true,
    node: true,
  },
  extends: [
    'google',
  ],
  parserOptions: {
    ecmaVersion: 12,
  },
  rules: {
    'object-curly-spacing': ['error', 'always'],
    'max-len': ['error',
      { 'code': 125,
        'ignoreTrailingComments': true,
        'ignoreUrls': true,
        'ignoreStrings': true,
        'ignoreTemplateLiterals': true,
        'ignoreRegExpLiterals': true,
      }],
    'require-jsdoc': ['off'],
    'padded-blocks': ['off'],
  },
};
