module.exports = {
    root: true,
    plugins: [
        'jest',
        'playwright',
    ],
    extends: [
        'eslint:recommended',
        'plugin:jest/recommended',
        'plugin:playwright/recommended',
    ],
    env: {
        es6: true,
        node: true,
        'jest/globals': true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    overrides: [
        {
            files: ['tests/frontend/*.e2e.js', 'frontend/*.e2e.js'],
            env: { browser: true },
            globals: { SillyTavern: 'readonly', globalThis: 'readonly' },
        },
        {
            files: ['tests/frontend/MacroEngine.e2e.js', 'frontend/MacroEngine.e2e.js'],
            rules: { 'playwright/no-conditional-in-test': 'off' },
        },
        {
            files: ['tests/frontend/MacroLexer.e2e.js', 'frontend/MacroLexer.e2e.js'],
            rules: { 'playwright/no-skipped-test': 'off' },
        },
        {
            files: ['tests/*.node.test.mjs', '*.node.test.mjs'],
            rules: { 'playwright/expect-expect': 'off' },
        },
    ],
    ignorePatterns: [
        '*.min.js',
        'node_modules/**/*',
    ],
    globals: {
    },
    rules: {
        'no-unused-vars': ['error', { args: 'none' }],
        'no-control-regex': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'require-yield': 'off',
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
        'comma-dangle': ['error', 'always-multiline'],
        'eol-last': ['error', 'always'],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'space-infix-ops': 'error',
        'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
        'no-cond-assign': 'error',

        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
    },
    settings: {
        jest: {
            version: 29,
        },
    },
};
