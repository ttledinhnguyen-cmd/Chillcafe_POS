/**
 * HaKi Cafe - Initialize Admin Account
 * Run: npm run init-admin
 *
 * This script creates/resets the admin user with a bcrypt-hashed password.
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const readline = require('readline');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'haki.db'));
db.pragma('journal_mode = WAL');

// Ensure table exists
db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        failed_attempts INTEGER DEFAULT 0,
        locked_until TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );
`);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

async function main() {
    console.log('');
    console.log('=== HaKi Cafe - Tạo tài khoản Admin ===');
    console.log('');

    const existingAdmin = db.prepare('SELECT username FROM admin_users').all();
    if (existingAdmin.length > 0) {
        console.log('Tài khoản hiện có:', existingAdmin.map(a => a.username).join(', '));
        const reset = await question('Bạn muốn đặt lại mật khẩu? (y/n): ');
        if (reset.toLowerCase() !== 'y') {
            console.log('Đã hủy.');
            rl.close();
            db.close();
            return;
        }
    }

    const username = await question('Tên đăng nhập (mặc định: admin): ') || 'admin';
    let password;
    while (true) {
        password = await question('Mật khẩu (tối thiểu 8 ký tự, có chữ hoa, thường, số): ');
        if (password.length < 8) {
            console.log('❌ Mật khẩu phải có ít nhất 8 ký tự.');
            continue;
        }
        if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
            console.log('❌ Mật khẩu phải có chữ hoa, chữ thường và số.');
            continue;
        }
        const confirm = await question('Nhập lại mật khẩu: ');
        if (password !== confirm) {
            console.log('❌ Mật khẩu không khớp.');
            continue;
        }
        break;
    }

    const hash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();

    const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
    if (existing) {
        db.prepare('UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = datetime("now") WHERE username = ?')
            .run(hash, username);
        console.log(`\n✅ Đã cập nhật mật khẩu cho "${username}"`);
    } else {
        db.prepare('INSERT INTO admin_users (id, username, password_hash) VALUES (?, ?, ?)')
            .run(id, username, hash);
        console.log(`\n✅ Đã tạo tài khoản "${username}"`);
    }

    console.log('\nBạn có thể đăng nhập tại: /admin');
    console.log('');

    rl.close();
    db.close();
}

main().catch(err => {
    console.error('Error:', err);
    rl.close();
    db.close();
    process.exit(1);
});
