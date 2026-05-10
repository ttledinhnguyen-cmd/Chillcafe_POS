/**
 * HaKi Cafe - Security Setup Script
 *
 * This script replaces the old files with the new secure versions.
 * Run with Administrator privileges:
 *   node setup.js
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;

const replacements = [
    {
        old: path.join(root, 'admin', 'script.js'),
        new: path.join(root, 'admin', 'script.new.js'),
        backup: path.join(root, 'admin', 'script.old.js'),
    },
    {
        old: path.join(root, 'admin', 'index.html'),
        new: path.join(root, 'admin', 'index.new.html'),
        backup: path.join(root, 'admin', 'index.old.html'),
    },
    {
        old: path.join(root, 'web.config'),
        new: path.join(root, 'web.config.new'),
        backup: path.join(root, 'web.config.old'),
    },
];

console.log('=== HaKi Cafe - Security Setup ===\n');

let allOk = true;

for (const { old: oldFile, new: newFile, backup } of replacements) {
    const name = path.relative(root, oldFile);

    if (!fs.existsSync(newFile)) {
        console.log(`[SKIP] ${name}: New file not found`);
        continue;
    }

    try {
        // Backup old file
        if (fs.existsSync(oldFile)) {
            fs.copyFileSync(oldFile, backup);
            console.log(`[BACKUP] ${name} -> ${path.relative(root, backup)}`);
        }

        // Replace with new file
        fs.copyFileSync(newFile, oldFile);
        console.log(`[OK] ${name} replaced`);

        // Remove .new file
        fs.unlinkSync(newFile);
    } catch (err) {
        console.log(`[ERROR] ${name}: ${err.message}`);
        allOk = false;
    }
}

// Create data directory
const dataDir = path.join(root, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
    console.log('[OK] Created data/ directory');
}

console.log('');

if (allOk) {
    console.log('Setup completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('  1. npm install');
    console.log('  2. npm run init-admin   (create admin account)');
    console.log('  3. npm start            (start server)');
} else {
    console.log('Some files could not be replaced.');
    console.log('Please run this script as Administrator.');
    console.log('');
    console.log('Or manually:');
    console.log('  1. Replace admin/script.js with admin/script.new.js');
    console.log('  2. Replace admin/index.html with admin/index.new.html');
    console.log('  3. Replace web.config with web.config.new');
}

console.log('');
