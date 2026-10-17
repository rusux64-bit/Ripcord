const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'dist/**', 'public/vendor/**']
    },
    {
        files: ['server.js', 'src/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-constant-condition': 'warn',
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['public/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: {
                ...globals.browser
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    }
];
