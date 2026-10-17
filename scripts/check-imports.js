#!/usr/bin/env node

/**
 * Static & Runtime Import Validator
 * Validates that all destructured imports and namespace property accesses
 * across server.js and src/*.js correspond to actual exported symbols.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

const targetFiles = [
    path.join(rootDir, 'server.js'),
    ...fs.readdirSync(srcDir)
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(srcDir, f))
];

// 1. Require each target module to inspect actual runtime exports
const moduleExports = new Map();
for (const file of targetFiles) {
    try {
        const mod = require(file);
        moduleExports.set(file, mod);
    } catch (err) {
        console.error(`FATAL: Failed to require ${path.relative(rootDir, file)}:`, err);
        process.exit(1);
    }
}

let errorCount = 0;

function reportError(file, lineNum, message) {
    errorCount++;
    const relFile = path.relative(rootDir, file);
    console.error(`ERROR in ${relFile}${lineNum ? `:${lineNum}` : ''}: ${message}`);
}

for (const file of targetFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    // Resolve line number helper
    function getLineNumber(index) {
        return content.slice(0, index).split('\n').length;
    }

    // --- Check 1: Destructured require imports ---
    // Matches: const { a, b: alias, c } = require('./relative/path')
    const destructuredRegex = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match;
    while ((match = destructuredRegex.exec(content)) !== null) {
        const rawNames = match[1];
        const importPath = match[2];
        const lineNum = getLineNumber(match.index);

        const targetPath = path.resolve(path.dirname(file), importPath);
        const targetFile = targetPath.endsWith('.js') ? targetPath : `${targetPath}.js`;

        if (!moduleExports.has(targetFile)) {
            // Check if it's an existing file not in our module map (e.g. JSON or package)
            if (!fs.existsSync(targetFile)) {
                reportError(file, lineNum, `Cannot resolve import '${importPath}' -> file not found (${path.relative(rootDir, targetFile)})`);
            }
            continue;
        }

        const exportsObj = moduleExports.get(targetFile);
        if (!exportsObj || (typeof exportsObj !== 'object' && typeof exportsObj !== 'function')) {
            reportError(file, lineNum, `Module '${path.relative(rootDir, targetFile)}' does not export an object or function.`);
            continue;
        }

        const items = rawNames.split(',').map(s => s.trim()).filter(Boolean);
        for (const item of items) {
            // Handle aliases like 'foo: myFoo'
            const [exportName] = item.split(':').map(s => s.trim());
            if (!exportName || exportName.startsWith('//') || exportName.startsWith('/*')) continue;

            if (!(exportName in exportsObj)) {
                reportError(file, lineNum, `'${exportName}' is not exported by ${path.relative(rootDir, targetFile)}`);
            }
        }
    }

    // --- Check 2: Namespace require imports and property accesses ---
    // Matches: const namespace = require('./relative/path')
    const namespaceRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    while ((match = namespaceRegex.exec(content)) !== null) {
        const namespaceVar = match[1];
        const importPath = match[2];

        const targetPath = path.resolve(path.dirname(file), importPath);
        const targetFile = targetPath.endsWith('.js') ? targetPath : `${targetPath}.js`;

        if (!moduleExports.has(targetFile)) continue;
        const exportsObj = moduleExports.get(targetFile);

        // Find all property accesses: namespaceVar.someProperty
        const propRegex = new RegExp(`\\b${namespaceVar}\\.([A-Za-z0-9_$]+)\\b`, 'g');
        let propMatch;
        while ((propMatch = propRegex.exec(content)) !== null) {
            const propName = propMatch[1];
            const lineNum = getLineNumber(propMatch.index);

            if (!(propName in exportsObj)) {
                reportError(file, lineNum, `Property '${namespaceVar}.${propName}' does not exist on ${path.relative(rootDir, targetFile)}`);
            }
        }
    }
}

if (errorCount > 0) {
    console.error(`\nFAILED: Found ${errorCount} import/export mismatch(es).`);
    process.exit(1);
} else {
    console.log(`SUCCESS: All relative imports and namespace property accesses verified across ${targetFiles.length} files.`);
    process.exit(0);
}
