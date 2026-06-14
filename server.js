const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const net = require('net');

// Multer config for menu images
const menuImageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads/menu')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
    }
});
const menuImageUpload = multer({
    storage: menuImageStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Chỉ chấp nhận file ảnh (jpg, png, webp, gif)'));
    }
});

const app = express();
app.set('trust proxy', 1); // Trust IIS reverse proxy
const PORT = process.env.PORT || 5000;

// ===== DATABASE SETUP =====
const dbPath = path.join(__dirname, 'data', 'chill.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}
const db = new Database(dbPath);
try { db.pragma('journal_mode = DELETE'); } catch(e) { console.warn('Journal mode change failed:', e.message); }
db.pragma('foreign_keys = ON');

// Separate DB for table orders (avoids IIS lock on main DB)
const ordersDbPath = path.join(__dirname, 'data', 'table_orders.db');
const ordersDb = new Database(ordersDbPath);
ordersDb.pragma('journal_mode = WAL');
ordersDb.exec(`CREATE TABLE IF NOT EXISTS table_orders (
    table_id INTEGER PRIMARY KEY,
    cart TEXT NOT NULL DEFAULT '[]',
    discount TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
)`);
console.log('table_orders DB ready');

// Create tables
try { db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'admin',
        failed_attempts INTEGER DEFAULT 0,
        locked_until TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS menu (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price INTEGER NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'available',
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        area TEXT DEFAULT '',
        status TEXT DEFAULT 'available',
        current_order_id TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        staff_name TEXT NOT NULL,
        staff_id TEXT,
        open_time TEXT NOT NULL,
        close_time TEXT,
        open_amount INTEGER DEFAULT 0,
        close_amount INTEGER,
        note TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE,
        items TEXT NOT NULL,
        total INTEGER NOT NULL,
        subtotal INTEGER NOT NULL DEFAULT 0,
        discount_amount INTEGER DEFAULT 0,
        discount_type TEXT,
        discount_value REAL DEFAULT 0,
        type TEXT NOT NULL,
        table_id INTEGER,
        table_name TEXT,
        note TEXT,
        status TEXT DEFAULT 'pending',
        payment_method TEXT,
        payment_amount INTEGER DEFAULT 0,
        change_amount INTEGER DEFAULT 0,
        shift_id INTEGER,
        staff_name TEXT,
        invoice_number TEXT,
        date TEXT NOT NULL,
        paid_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        amount INTEGER NOT NULL,
        payment_method TEXT DEFAULT 'cash',
        description TEXT,
        shift_id INTEGER,
        staff_name TEXT,
        date TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        qty REAL NOT NULL,
        unit TEXT NOT NULL,
        min_qty REAL NOT NULL,
        cost_price INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        phone TEXT,
        shift TEXT NOT NULL,
        salary INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        ip TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS roles (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_system INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS role_permissions (
        role TEXT NOT NULL,
        perm TEXT NOT NULL,
        PRIMARY KEY (role, perm)
    );
    CREATE TABLE IF NOT EXISTS payroll_sheets (
        period TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS shift_staff (
        shift_id INTEGER NOT NULL,
        staff_id TEXT NOT NULL,
        staff_name TEXT,
        PRIMARY KEY (shift_id, staff_id)
    );
`); } catch (e) { console.warn('DB create tables skipped:', e.message); }

// ===== PERMISSION CATALOG (shared by API + seed) =====
const PERMISSION_CATALOG = [
    { group: 'Tổng quan', perms: [{ key: 'dashboard.view', label: 'Xem tổng quan' }] },
    { group: 'Bán hàng', perms: [{ key: 'pos.use', label: 'Dùng bán hàng (POS)' }] },
    { group: 'Bàn', perms: [{ key: 'table.view', label: 'Xem bàn' }, { key: 'table.manage', label: 'Quản lý bàn' }] },
    { group: 'Đơn hàng', perms: [{ key: 'order.view', label: 'Xem đơn hàng' }, { key: 'order.edit', label: 'Sửa đơn' }, { key: 'order.delete', label: 'Xóa đơn' }] },
    { group: 'Thực đơn', perms: [{ key: 'menu.view', label: 'Xem thực đơn' }, { key: 'menu.edit', label: 'Thêm/sửa món' }, { key: 'menu.delete', label: 'Xóa món' }] },
    { group: 'Ca làm việc', perms: [{ key: 'shift.view', label: 'Xem ca' }, { key: 'shift.manage', label: 'Quản lý ca' }] },
    { group: 'Thu chi', perms: [{ key: 'transaction.view', label: 'Xem thu chi' }, { key: 'transaction.edit', label: 'Thêm/sửa thu chi' }, { key: 'transaction.delete', label: 'Xóa thu chi' }] },
    { group: 'Kho hàng', perms: [{ key: 'inventory.view', label: 'Xem kho' }, { key: 'inventory.edit', label: 'Thêm/sửa kho' }, { key: 'inventory.delete', label: 'Xóa kho' }] },
    { group: 'Nhân viên', perms: [{ key: 'staff.view', label: 'Xem nhân viên' }, { key: 'staff.edit', label: 'Thêm/sửa nhân viên' }, { key: 'staff.delete', label: 'Xóa nhân viên' }] },
    { group: 'Bảng lương', perms: [{ key: 'payroll.view', label: 'Xem bảng lương' }, { key: 'payroll.edit', label: 'Sửa/lưu bảng lương' }] },
    { group: 'Báo cáo', perms: [{ key: 'report.view', label: 'Xem báo cáo' }] },
];
const ALL_PERMS = PERMISSION_CATALOG.flatMap(g => g.perms.map(p => p.key));
const DEFAULT_ROLE_PERMS = {
    manager: ['dashboard.view','pos.use','table.view','table.manage','order.view','order.edit','order.delete','menu.view','menu.edit','menu.delete','shift.view','shift.manage','transaction.view','transaction.edit','transaction.delete','inventory.view','inventory.edit','inventory.delete','staff.view','staff.edit','staff.delete','payroll.view','payroll.edit','report.view'],
    cashier: ['dashboard.view','pos.use','table.view','order.view','menu.view','shift.view'],
    staff: ['dashboard.view','pos.use','table.view','order.view','menu.view'],
};

// Migrate & seed (all wrapped for readonly DB resilience)
try {
const addColumnSafe = (table, col, type) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch (e) { /* column exists */ }
};
addColumnSafe('orders', 'code', 'TEXT');
addColumnSafe('orders', 'subtotal', 'INTEGER DEFAULT 0');
addColumnSafe('orders', 'discount_amount', 'INTEGER DEFAULT 0');
addColumnSafe('orders', 'discount_type', 'TEXT');
addColumnSafe('orders', 'discount_value', 'REAL DEFAULT 0');
addColumnSafe('orders', 'table_id', 'INTEGER');
addColumnSafe('orders', 'table_name', 'TEXT');
addColumnSafe('orders', 'payment_method', 'TEXT');
addColumnSafe('orders', 'payment_amount', 'INTEGER DEFAULT 0');
addColumnSafe('orders', 'change_amount', 'INTEGER DEFAULT 0');
addColumnSafe('orders', 'shift_id', 'INTEGER');
addColumnSafe('orders', 'staff_name', 'TEXT');
addColumnSafe('orders', 'invoice_number', 'TEXT');
addColumnSafe('orders', 'paid_at', 'TEXT');
addColumnSafe('admin_users', 'display_name', 'TEXT');
addColumnSafe('admin_users', 'role', "TEXT DEFAULT 'admin'");
addColumnSafe('admin_users', 'google_email', 'TEXT');
addColumnSafe('staff', 'status', "TEXT DEFAULT 'active'");
addColumnSafe('staff', 'pay_type', "TEXT DEFAULT 'month'");
addColumnSafe('inventory', 'cost_price', 'INTEGER DEFAULT 0');
addColumnSafe('menu', 'sort_order', 'INTEGER DEFAULT 0');
addColumnSafe('menu', 'image_url', 'TEXT');

// ===== ROLES & PERMISSIONS: seed system roles + default permissions =====
try {
    const upRole = db.prepare('INSERT OR IGNORE INTO roles (slug, name, is_system) VALUES (?, ?, 1)');
    upRole.run('admin', 'Quản trị viên');
    upRole.run('manager', 'Quản lý');
    upRole.run('cashier', 'Thu ngân');
    upRole.run('staff', 'Nhân viên');
    const hasPerm = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE role = ?');
    const insPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role, perm) VALUES (?, ?)');
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMS)) {
        if (hasPerm.get(role).c === 0) perms.forEach(p => insPerm.run(role, p));
    }
    // New permissions added later: grant to 'manager' by default (admin can adjust)
    ['payroll.view', 'payroll.edit'].forEach(p => insPerm.run('manager', p));
} catch (e) { console.warn('Seed roles skipped:', e.message); }

// Insert default settings if empty
const settingsCount = db.prepare('SELECT COUNT(*) as c FROM settings').get().c;
if (settingsCount === 0) {
    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const defaultSettings = {
        name: 'CHILL CAFE',
        address: 'Tỉnh lộ 3, Phước Tân, Phước Đồng, Khánh Hòa',
        phone: '0916.064.036',
        hours: '7:00 AM - 6:00 PM',
        facebook: '',
        invoice_prefix: 'POS',
        next_invoice_number: '1'
    };
    const insertMany = db.transaction(() => {
        for (const [key, value] of Object.entries(defaultSettings)) {
            insertSetting.run(key, value);
        }
    });
    insertMany();
}
} catch (e) { console.warn('DB migrate/seed skipped:', e.message); }

// Ensure bank/payment/google settings exist
try {
    const bankSettings = ['bank_name', 'bank_account', 'bank_owner', 'payment_qr_url', 'google_client_id', 'printer_ip', 'printer_port'];
    for (const key of bankSettings) {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')").run(key);
    }

    // Ensure invoice settings exist
    const invoicePrefix = db.prepare("SELECT value FROM settings WHERE key = 'invoice_prefix'").get();
    if (!invoicePrefix) {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_prefix', 'POS')").run();
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('next_invoice_number', '1')").run();
    }
} catch (e) {
    console.warn('DB init settings skipped (readonly):', e.message);
}

// Insert default data if empty (wrapped in try-catch for readonly DB)
try {
const menuCount = db.prepare('SELECT COUNT(*) as c FROM menu').get().c;
if (menuCount === 0) {
    const insertMenu = db.prepare('INSERT INTO menu (id, name, category, price, description, status) VALUES (?, ?, ?, ?, ?, ?)');
    const defaultMenu = [
        // Coffee
        ['cf1', 'Cà Phê Đen', 'coffee', 20000, 'Black Coffee', 'available'],
        ['cf2', 'Cà Phê Sữa', 'coffee', 20000, 'Coffee + Condensed milk', 'available'],
        ['cf3', 'Bạc Xỉu', 'coffee', 22000, 'Coffee + Condensed milk + Milk', 'available'],
        ['cf4', 'Matcha Latte', 'coffee', 25000, 'Matcha Latte', 'available'],
        ['cf5', 'Cappuchino/Latte', 'coffee', 30000, 'Cappuchino/Latte', 'available'],
        ['cf6', 'Cacao Sữa', 'coffee', 27000, 'Cacao + Milk', 'available'],
        ['cf7', 'Cà Phê Muối', 'coffee', 25000, 'Coffee + Salted foam', 'available'],
        // Đá Xay
        ['bl1', 'Coffee Caramel Đá Xay', 'smoothie', 32000, 'Coffee Caramel Blended', 'available'],
        ['bl2', 'Socola Đá Xay', 'smoothie', 32000, 'Chocolate Blended', 'available'],
        ['bl3', 'Cookies Đá Xay', 'smoothie', 32000, 'Cookies Blended', 'available'],
        ['bl4', 'Matcha Đá Xay', 'smoothie', 32000, 'Matcha Blended', 'available'],
        // Soda
        ['so1', 'Soda Bạc Hà', 'soda', 25000, 'Mint Soda', 'available'],
        ['so2', 'Soda Blue Curacao', 'soda', 25000, 'Blue Curacao Soda', 'available'],
        ['so3', 'Soda Việt Quất', 'soda', 25000, 'Blueberry Soda', 'available'],
        ['so4', 'Soda Dâu', 'soda', 25000, 'Strawberry Soda', 'available'],
        ['so5', 'Soda Xoài', 'soda', 25000, 'Mango Soda', 'available'],
        ['so6', 'Soda Kiwi', 'soda', 25000, 'Kiwi Soda', 'available'],
        ['so7', 'Soda Chanh', 'soda', 25000, 'Lime Soda', 'available'],
        ['so8', 'Soda Chanh Dây', 'soda', 25000, 'Passion Fruit Soda', 'available'],
        // Trà Sữa
        ['te1', 'Trà Sữa Trân Châu', 'tea', 28000, 'Bubble Tea', 'available'],
        ['te2', 'Trà Sữa Dâu', 'tea', 25000, 'Strawberry Milk Tea', 'available'],
        ['te3', 'Trà Sữa Socola', 'tea', 25000, 'Chocolate Milk Tea', 'available'],
        ['te4', 'Trà Sữa Bạc Hà', 'tea', 25000, 'Mint Milk Tea', 'available'],
        ['te5', 'Trà Sữa Việt Quất', 'tea', 25000, 'Blueberry Milk Tea', 'available'],
        ['te6', 'Trà Sữa Caramel', 'tea', 25000, 'Caramel Milk Tea', 'available'],
        ['te7', 'Sữa Tươi Trân Châu Đường Đen', 'tea', 25000, 'Fresh Milk Brown Sugar Boba', 'available'],
        ['te8', 'Trà Sữa Không Trân Châu', 'tea', 23000, 'Milk Tea (no boba)', 'available'],
        // Sinh Tố
        ['sm1', 'Sinh Tố Bơ', 'smoothie', 27000, 'Avocado Smoothie', 'available'],
        ['sm2', 'Sinh Tố Mãng Cầu', 'smoothie', 27000, 'Soursop Smoothie', 'available'],
        ['sm3', 'Sinh Tố Xoài', 'smoothie', 27000, 'Mango Smoothie', 'available'],
        ['sm4', 'Sinh Tố Chuối', 'smoothie', 27000, 'Banana Smoothie', 'available'],
        ['sm5', 'Sinh Tố Sapoche', 'smoothie', 27000, 'Sapodilla Smoothie', 'available'],
        ['sm6', 'Sinh Tố Chanh Dây', 'smoothie', 27000, 'Passion Fruit Smoothie', 'available'],
        ['sm7', 'Sinh Tố Dâu', 'smoothie', 27000, 'Strawberry Smoothie', 'available'],
        ['sm8', 'Sinh Tố Thập Cẩm', 'smoothie', 27000, 'Mixed Smoothie', 'available'],
        ['sm9', 'Chanh Tuyết', 'smoothie', 27000, 'Frozen Lemonade', 'available'],
        // Trà/Tea
        ['tt1', 'Lipton Nóng/Đá', 'tea', 20000, 'Lipton Hot/Iced', 'available'],
        ['tt2', 'Hồng Trà Chanh', 'tea', 20000, 'Black Tea Lemon', 'available'],
        ['tt3', 'Trà Gừng Mật Ong', 'tea', 20000, 'Ginger Honey Tea', 'available'],
        ['tt4', 'Trà Đào', 'tea', 25000, 'Peach Tea', 'available'],
        ['tt5', 'Trà Đào Chanh Dây', 'tea', 25000, 'Peach Passion Fruit Tea', 'available'],
        ['tt6', 'Trà Đào Chanh Sả', 'tea', 25000, 'Peach Lemongrass Tea', 'available'],
        ['tt7', 'Lipton Cam Mật Ong', 'tea', 25000, 'Lipton Orange Honey', 'available'],
        ['tt8', 'Hồng Trà Foam Milk', 'tea', 25000, 'Black Tea Foam Milk', 'available'],
        // Nước Ép/Juice
        ['ju1', 'Nước Chanh', 'juice', 20000, 'Lemonade', 'available'],
        ['ju2', 'Sữa Đá Chanh', 'juice', 20000, 'Milk Lemonade', 'available'],
        ['ju3', 'Nước Ép Chanh Dây', 'juice', 27000, 'Passion Fruit Juice', 'available'],
        ['ju4', 'Cam Ép', 'juice', 27000, 'Orange Juice', 'available'],
        ['ju5', 'Ép Thơm', 'juice', 27000, 'Pineapple Juice', 'available'],
        ['ju6', 'Ép Ổi', 'juice', 27000, 'Guava Juice', 'available'],
        ['ju7', 'Ép Cà Chua', 'juice', 27000, 'Tomato Juice', 'available'],
        ['ju8', 'Ép Dưa Hấu', 'juice', 27000, 'Watermelon Juice', 'available'],
        // Yogurt
        ['yo1', 'Yogurt Hạt Đác', 'yogurt', 25000, 'Yogurt + Nata de coco', 'available'],
        ['yo2', 'Yogurt Xoài', 'yogurt', 25000, 'Yogurt + Mango', 'available'],
        ['yo3', 'Yogurt Kiwi', 'yogurt', 25000, 'Yogurt + Kiwi', 'available'],
        ['yo4', 'Yogurt Dâu', 'yogurt', 25000, 'Yogurt + Strawberry', 'available'],
        ['yo5', 'Yogurt Việt Quất', 'yogurt', 25000, 'Yogurt + Blueberry', 'available'],
        ['yo6', 'Yogurt Chanh Dây', 'yogurt', 25000, 'Yogurt + Passion Fruit', 'available'],
        // Đá Me
        ['dm1', 'Đá Me', 'other', 25000, 'Tamarind Iced Drink', 'available'],
        ['dm2', 'Sữa Đá Me', 'other', 27000, 'Tamarind Milk', 'available'],
        // Soft Drink
        ['sd1', 'Nước Suối', 'other', 10000, 'Bottled Water', 'available'],
        ['sd2', 'Sting', 'other', 15000, 'Sting Energy', 'available'],
        ['sd3', 'Trà Xanh', 'other', 15000, 'Green Tea Bottle', 'available'],
        ['sd4', 'Coca', 'other', 15000, 'Coca Cola', 'available'],
        ['sd5', 'Sữa Tươi', 'other', 15000, 'Fresh Milk', 'available'],
        ['sd6', 'Sữa Nóng', 'other', 15000, 'Hot Milk', 'available'],
        ['sd7', 'Bò Húc', 'other', 18000, 'Red Bull', 'available'],
        ['sd8', 'Dừa Tươi', 'other', 25000, 'Fresh Coconut', 'available'],
        // Fast Food
        ['ff1', 'Cá Viên', 'other', 15000, 'Fish Ball', 'available'],
        ['ff2', 'Bò Viên', 'other', 15000, 'Beef Ball', 'available'],
        ['ff3', 'Tôm Viên', 'other', 15000, 'Shrimp Ball', 'available'],
        ['ff4', 'Xúc Xích', 'other', 15000, 'Sausage', 'available'],
        ['ff5', 'Phô Mai Que', 'other', 15000, 'Cheese Stick', 'available'],
        ['ff6', 'Khoai Tây Chiên', 'other', 20000, 'French Fries', 'available'],
        // Ice Cream
        ['ic1', 'Kem', 'other', 20000, 'Ice Cream', 'available'],
    ];
    const insertMany = db.transaction(() => {
        for (const m of defaultMenu) {
            insertMenu.run(...m);
        }
    });
    insertMany();
}

// Insert default tables if empty
const tableCount = db.prepare('SELECT COUNT(*) as c FROM tables').get().c;
if (tableCount === 0) {
    const insertTable = db.prepare('INSERT INTO tables (name, area, sort_order) VALUES (?, ?, ?)');
    const defaultTables = [
        ['MANG VỀ', 'service', 0],
        ['BÀN 1', 'indoor', 1],
        ['BÀN 2', 'indoor', 2],
        ['BÀN 3', 'indoor', 3],
        ['BÀN 4', 'indoor', 4],
        ['BÀN 5', 'indoor', 5],
        ['BÀN 6', 'indoor', 6],
        ['BÀN 7', 'indoor', 7],
        ['BÀN 8', 'indoor', 8],
    ];
    const insertMany = db.transaction(() => {
        for (const t of defaultTables) insertTable.run(...t);
    });
    insertMany();
}

// Insert default inventory if empty
const invCount = db.prepare('SELECT COUNT(*) as c FROM inventory').get().c;
if (invCount === 0) {
    const insertInv = db.prepare('INSERT INTO inventory (id, name, qty, unit, min_qty) VALUES (?, ?, ?, ?, ?)');
    const defaultInv = [
        ['inv1', 'Cà phê hạt', 5, 'kg', 2],
        ['inv2', 'Sữa tươi', 10, 'lít', 3],
        ['inv3', 'Sữa đặc', 20, 'hộp', 5],
        ['inv4', 'Đường', 3, 'kg', 1],
        ['inv5', 'Cam', 8, 'kg', 2],
        ['inv6', 'Bạc hà', 0.5, 'kg', 0.3],
    ];
    const insertMany = db.transaction(() => {
        for (const i of defaultInv) insertInv.run(...i);
    });
    insertMany();
}
} catch (e) {
    console.warn('DB init data skipped (readonly):', e.message);
}

// ===== INVOICE NUMBER HELPER =====
function getNextInvoiceNumber() {
    const prefix = db.prepare("SELECT value FROM settings WHERE key = 'invoice_prefix'").get()?.value || 'POS';
    const num = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'next_invoice_number'").get()?.value || '1');
    const code = prefix + String(num).padStart(8, '0');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'next_invoice_number'").run(String(num + 1));
    return code;
}

// ===== SECURITY MIDDLEWARE =====

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://plus.unsplash.com", "https://images.pexels.com", "https://cdn.pixabay.com", "https://i.imgur.com"],
            connectSrc: ["'self'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

// Body parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// Session configuration
// Session secret: per-instance, generated & persisted (no shared hardcoded fallback)
const SECRET_FILE = path.join(__dirname, 'data', 'session_secret.key');
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    try {
        if (fs.existsSync(SECRET_FILE)) SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
        if (!SESSION_SECRET) {
            SESSION_SECRET = crypto.randomBytes(48).toString('hex');
            fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
            console.log('Generated new session secret at', SECRET_FILE);
        }
    } catch (e) {
        console.warn('Session secret file error, using random in-memory secret:', e.message);
        SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    }
}
const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));
sessionDb.pragma('journal_mode = WAL');
// Public traffic is always HTTPS (IIS forces HTTP->HTTPS upstream); needed for secure cookies behind proxy.
app.use((req, res, next) => { req.headers['x-forwarded-proto'] = 'https'; next(); });
app.use(session({
    store: new SqliteStore({
        client: sessionDb,
        expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: SESSION_SECRET,
    name: 'chill_sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
}));

// CSRF token generation & validation
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
        // Only generate CSRF for authenticated sessions to avoid creating sessions for bots
        if (req.session && req.session.userId && !req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }
        return next();
    }
    // Exempt login/google from CSRF (protected by rate limiting instead)
    if (req.path === '/api/auth/login' || req.path === '/api/auth/google') return next();
    const token = req.headers['x-csrf-token'] || req.body._csrf;
    if (!req.session || !req.session.csrfToken || token !== req.session.csrfToken) {
        return res.status(403).json({ error: 'CSRF token không hợp lệ. Vui lòng tải lại trang.' });
    }
    next();
});

// Global rate limiter
const getClientIp = (req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '127.0.0.1';
    return ip.replace(/:\d+$/, '');
};
// Restrict printer connections to private LAN ranges (anti-SSRF)
function isPrivateIp(ip) {
    if (!ip) return false;
    ip = String(ip).trim();
    if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') return true;
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const o = [ +m[1], +m[2], +m[3], +m[4] ];
    if (o.some(n => n > 255)) return false;
    const [a, b] = o;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    keyGenerator: getClientIp,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Quá nhiều request. Vui lòng thử lại sau.' },
});
app.use(globalLimiter);

// Login rate limiter
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: getClientIp,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau 15 phút.' },
    skipSuccessfulRequests: true,
});

// ===== HELPERS =====
function auditLog(userId, action, detail, ip) {
    db.prepare('INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?, ?, ?, ?)').run(userId, action, detail, ip);
}

// Haversine distance in meters
function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"']/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function validateString(val, minLen = 1, maxLen = 200) {
    return typeof val === 'string' && val.trim().length >= minLen && val.trim().length <= maxLen;
}

function validateNumber(val, min = 0, max = Infinity) {
    const n = Number(val);
    return !isNaN(n) && n >= min && n <= max;
}

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    res.status(401).json({ error: 'Chưa đăng nhập' });
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ error: 'Chưa đăng nhập' });
        }
        if (!roles.includes(req.session.role)) {
            return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
        }
        next();
    };
}

// ===== PERMISSION HELPERS (role-based, admin always allowed) =====
function roleHasPerm(role, perm) {
    if (role === 'admin') return true;
    try {
        return !!db.prepare('SELECT 1 FROM role_permissions WHERE role = ? AND perm = ?').get(role, perm);
    } catch (e) { return false; }
}
function getRolePerms(role) {
    if (role === 'admin') return ALL_PERMS.slice();
    try {
        return db.prepare('SELECT perm FROM role_permissions WHERE role = ?').all(role).map(r => r.perm);
    } catch (e) { return []; }
}
function isValidRole(role) {
    try { return !!db.prepare('SELECT 1 FROM roles WHERE slug = ?').get(role); } catch (e) { return false; }
}
function requirePerm(perm) {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ error: 'Chưa đăng nhập' });
        }
        if (req.session.role === 'admin' || roleHasPerm(req.session.role, perm)) return next();
        return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
    };
}

// ===== STATIC FILES =====
// Serve POS admin app
app.use('/pos', (req, res, next) => {
    // Allow access to pos login page without auth
    if (!req.session || !req.session.userId) {
        const allowedPaths = ['/', '/index.html', '/style.css'];
        if (allowedPaths.includes(req.path)) {
            return express.static(path.join(__dirname, 'pos'), { dotfiles: 'deny' })(req, res, next);
        }
        if (req.path === '/script.js') {
            return res.status(403).send('Forbidden');
        }
    }
    next();
});
app.use('/pos', requireAuth, express.static(path.join(__dirname, 'pos'), { dotfiles: 'deny' }));

// Serve old admin
app.use((req, res, next) => {
    if (req.path.startsWith('/admin')) {
        if (!req.session || !req.session.userId) {
            if (req.path === '/admin' || req.path === '/admin/' || req.path === '/admin/index.html') {
                return res.sendFile(path.join(__dirname, 'admin', 'index.html'));
            }
            if (req.path === '/admin/style.css') {
                return res.sendFile(path.join(__dirname, 'admin', 'style.css'));
            }
            if (req.path === '/admin/script.js') {
                return res.status(403).send('Forbidden');
            }
        }
        return next();
    }
    next();
});

// Main site static files
app.use(express.static(path.join(__dirname), {
    index: 'index.html',
    dotfiles: 'deny',
    extensions: ['html'],
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    },
}));

app.use('/admin', requireAuth, express.static(path.join(__dirname, 'admin'), { dotfiles: 'deny' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===== AUTH ROUTES =====
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password, latitude, longitude } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
        }

        const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
        if (!user) {
            await bcrypt.hash(password, 12);
            auditLog(null, 'LOGIN_FAILED', `Unknown user: ${sanitize(username)}`, req.ip);
            return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
        }

        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
            auditLog(user.id, 'LOGIN_LOCKED', `Account locked, ${remaining}m remaining`, req.ip);
            return res.status(423).json({ error: `Tài khoản bị khóa. Vui lòng thử lại sau ${remaining} phút.` });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            const attempts = (user.failed_attempts || 0) + 1;
            let lockUntil = null;
            if (attempts >= 5) {
                lockUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            }
            try { db.prepare('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockUntil, user.id); } catch(e) { console.warn('Warn:', e.message); }
            try { auditLog(user.id, 'LOGIN_FAILED', `Attempt ${attempts}`, req.ip); } catch(e) { console.warn('Warn:', e.message); }
            if (lockUntil) {
                return res.status(423).json({ error: 'Tài khoản bị khóa 30 phút do đăng nhập sai nhiều lần.' });
            }
            return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
        }

        try { db.prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id); } catch(e) { console.warn('Warn:', e.message); }

        const role = user.role || 'admin';

        // Location-based access control (non-admin must be near shop)
        if (role !== 'admin') {
            const shopLat = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'shop_lat'").get()?.value);
            const shopLng = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'shop_lng'").get()?.value);
            const geoRequired = db.prepare("SELECT value FROM settings WHERE key = 'geo_restrict'").get()?.value;

            if (geoRequired !== 'off' && shopLat && shopLng) {
                if (!latitude || !longitude) {
                    return res.status(403).json({ error: 'Cần bật định vị (GPS) để đăng nhập', needLocation: true });
                }
                const maxDistance = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'geo_radius'").get()?.value) || 200;
                const dist = getDistanceMeters(latitude, longitude, shopLat, shopLng);
                if (dist > maxDistance) {
                    try { auditLog(user.id, 'LOGIN_GEO_DENIED', `Distance: ${Math.round(dist)}m`, req.ip); } catch(e) { console.warn('Warn:', e.message); }
                    return res.status(403).json({ error: `Bạn đang ở quá xa quán (${Math.round(dist)}m). Chỉ được đăng nhập trong phạm vi ${Math.round(maxDistance)}m.` });
                }
            }
        }

        req.session.regenerate((err) => {
            if (err) return res.status(500).json({ error: 'Lỗi server' });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.displayName = user.display_name || user.username;
            req.session.role = user.role || 'admin';
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            req.session.loginTime = new Date().toISOString();

            try { auditLog(user.id, 'LOGIN_SUCCESS', null, req.ip); } catch(e) { console.warn('Warn:', e.message); }
            res.json({
                success: true,
                csrfToken: req.session.csrfToken,
                username: user.username,
                displayName: user.display_name || user.username,
                role: user.role || 'admin',
                permissions: getRolePerms(user.role || 'admin')
            });
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Google Login
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ error: 'Thiếu thông tin đăng nhập Google' });

        // Decode Google JWT token (verify signature via Google's tokeninfo endpoint)
        const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
        if (!response.ok) return res.status(401).json({ error: 'Token Google không hợp lệ' });

        const payload = await response.json();
        const googleEmail = payload.email;
        if (!googleEmail || payload.email_verified !== 'true') {
            return res.status(401).json({ error: 'Email Google chưa được xác minh' });
        }

        // Check Google Client ID matches
        const clientId = db.prepare("SELECT value FROM settings WHERE key = 'google_client_id'").get()?.value;
        if (clientId && payload.aud !== clientId) {
            return res.status(401).json({ error: 'Google Client ID không khớp' });
        }

        // Find user by google_email
        const user = db.prepare('SELECT * FROM admin_users WHERE google_email = ?').get(googleEmail);
        if (!user) {
            auditLog(null, 'GOOGLE_LOGIN_FAILED', `No account linked: ${googleEmail}`, req.ip);
            return res.status(401).json({ error: `Email ${googleEmail} chưa được liên kết với tài khoản nào. Liên hệ admin để liên kết.` });
        }

        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(423).json({ error: 'Tài khoản bị khóa.' });
        }

        req.session.regenerate((err) => {
            if (err) return res.status(500).json({ error: 'Lỗi server' });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.displayName = user.display_name || user.username;
            req.session.role = user.role || 'admin';
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            req.session.loginTime = new Date().toISOString();

            auditLog(user.id, 'GOOGLE_LOGIN_SUCCESS', googleEmail, req.ip);
            res.json({
                success: true,
                csrfToken: req.session.csrfToken,
                username: user.username,
                displayName: user.display_name || user.username,
                role: user.role || 'admin',
                permissions: getRolePerms(user.role || 'admin')
            });
        });
    } catch (err) {
        console.error('Google login error:', err);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
    auditLog(req.session.userId, 'LOGOUT', null, req.ip);
    req.session.destroy(() => {
        res.clearCookie('chill_sid');
        res.json({ success: true });
    });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.userId) {
        return res.json({
            authenticated: true,
            csrfToken: req.session.csrfToken,
            username: req.session.username,
            displayName: req.session.displayName,
            role: req.session.role,
            permissions: getRolePerms(req.session.role)
        });
    }
    res.json({ authenticated: false });
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (!oldPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'Mật khẩu mới không khớp' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
    }
    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasNumber = /[0-9]/.test(newPassword);
    if (!hasUpper || !hasLower || !hasNumber) {
        return res.status(400).json({ error: 'Mật khẩu phải có chữ hoa, chữ thường và số' });
    }
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.userId);
    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
        auditLog(req.session.userId, 'PASSWORD_CHANGE_FAILED', 'Wrong old password', req.ip);
        return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?').run(hash, req.session.userId);
    auditLog(req.session.userId, 'PASSWORD_CHANGED', null, req.ip);
    res.json({ success: true });
});

// ===== USER MANAGEMENT API =====
const VALID_ROLES = ['admin', 'manager', 'cashier', 'staff'];

app.get('/api/users', requireRole('admin', 'manager'), (req, res) => {
    const users = db.prepare('SELECT id, username, display_name, role, google_email, created_at, updated_at FROM admin_users ORDER BY created_at DESC').all();
    res.json(users);
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
    const { username, password, display_name, role } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
    }
    if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Tên đăng nhập phải từ 3 ký tự, chỉ gồm chữ, số và _' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự' });
    }
    if (role && !isValidRole(role)) {
        return res.status(400).json({ error: 'Quyền không hợp lệ' });
    }
    const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
    if (existing) {
        return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    }
    try {
        const hash = await bcrypt.hash(password, 12);
        const id = uuidv4();
        db.prepare('INSERT INTO admin_users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)').run(
            id, username, hash, display_name || username, role || 'staff'
        );
        auditLog(req.session.userId, 'USER_CREATED', `Created user: ${username} (${role || 'staff'})`, req.ip);
        res.json({ success: true, id, username, display_name: display_name || username, role: role || 'staff' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi tạo tài khoản' });
    }
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { display_name, role, password, google_email } = req.body;

    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

    // Prevent demoting the last admin
    if (user.role === 'admin' && role && role !== 'admin') {
        const adminCount = db.prepare('SELECT COUNT(*) as count FROM admin_users WHERE role = ?').get('admin').count;
        if (adminCount <= 1) {
            return res.status(400).json({ error: 'Không thể đổi quyền admin cuối cùng' });
        }
    }

    if (role && !isValidRole(role)) {
        return res.status(400).json({ error: 'Quyền không hợp lệ' });
    }

    if (display_name !== undefined) {
        db.prepare('UPDATE admin_users SET display_name = ?, updated_at = datetime("now") WHERE id = ?').run(display_name, id);
    }
    if (role) {
        db.prepare('UPDATE admin_users SET role = ?, updated_at = datetime("now") WHERE id = ?').run(role, id);
    }
    if (password && password.length >= 6) {
        const hash = await bcrypt.hash(password, 12);
        db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?').run(hash, id);
    }
    if (google_email !== undefined) {
        db.prepare('UPDATE admin_users SET google_email = ?, updated_at = datetime("now") WHERE id = ?').run(google_email || null, id);
    }

    auditLog(req.session.userId, 'USER_UPDATED', `Updated user: ${user.username}`, req.ip);
    res.json({ success: true });
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
    const { id } = req.params;
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

    // Cannot delete self
    if (id === req.session.userId) {
        return res.status(400).json({ error: 'Không thể xóa tài khoản đang đăng nhập' });
    }

    // Cannot delete last admin
    if (user.role === 'admin') {
        const adminCount = db.prepare('SELECT COUNT(*) as count FROM admin_users WHERE role = ?').get('admin').count;
        if (adminCount <= 1) {
            return res.status(400).json({ error: 'Không thể xóa admin cuối cùng' });
        }
    }

    db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
    auditLog(req.session.userId, 'USER_DELETED', `Deleted user: ${user.username}`, req.ip);
    res.json({ success: true });
});

app.put('/api/users/:id/unlock', requireRole('admin'), (req, res) => {
    const { id } = req.params;
    db.prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(id);
    auditLog(req.session.userId, 'USER_UNLOCKED', `Unlocked user: ${id}`, req.ip);
    res.json({ success: true });
});

// ===== ROLES & PERMISSIONS API =====
// Permission catalog (groups + keys/labels)
app.get('/api/permissions', requireAuth, (req, res) => res.json(PERMISSION_CATALOG));

// List roles with their granted permissions
app.get('/api/roles', requireAuth, (req, res) => {
    try {
        const roles = db.prepare('SELECT slug, name, is_system FROM roles ORDER BY is_system DESC, name').all();
        const userCounts = {};
        db.prepare('SELECT role, COUNT(*) c FROM admin_users GROUP BY role').all().forEach(r => { userCounts[r.role] = r.c; });
        res.json(roles.map(r => ({
            slug: r.slug,
            name: r.name,
            is_system: !!r.is_system,
            is_admin: r.slug === 'admin',
            user_count: userCounts[r.slug] || 0,
            permissions: r.slug === 'admin' ? ALL_PERMS.slice() : getRolePerms(r.slug)
        })));
    } catch (e) { res.status(500).json({ error: 'Lỗi tải vai trò' }); }
});

// Create a new role (admin only)
app.post('/api/roles', requireRole('admin'), (req, res) => {
    let { slug, name, permissions } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên vai trò' });
    slug = (slug || name).toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!slug) return res.status(400).json({ error: 'Tên vai trò không hợp lệ' });
    if (db.prepare('SELECT 1 FROM roles WHERE slug = ?').get(slug)) return res.status(409).json({ error: 'Vai trò đã tồn tại' });
    db.prepare('INSERT INTO roles (slug, name, is_system) VALUES (?, ?, 0)').run(slug, name.trim());
    if (Array.isArray(permissions)) {
        const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role, perm) VALUES (?, ?)');
        permissions.filter(p => ALL_PERMS.includes(p)).forEach(p => ins.run(slug, p));
    }
    auditLog(req.session.userId, 'ROLE_CREATED', `Created role: ${slug}`, req.ip);
    res.json({ success: true, slug });
});

// Update a role's name / permissions (admin only; admin role is locked)
app.put('/api/roles/:slug', requireRole('admin'), (req, res) => {
    const { slug } = req.params;
    if (slug === 'admin') return res.status(400).json({ error: 'Không thể sửa quyền của Quản trị viên' });
    const role = db.prepare('SELECT * FROM roles WHERE slug = ?').get(slug);
    if (!role) return res.status(404).json({ error: 'Không tìm thấy vai trò' });
    const { name, permissions } = req.body;
    if (name && name.trim()) db.prepare('UPDATE roles SET name = ? WHERE slug = ?').run(name.trim(), slug);
    if (Array.isArray(permissions)) {
        const valid = permissions.filter(p => ALL_PERMS.includes(p));
        const tx = db.transaction(() => {
            db.prepare('DELETE FROM role_permissions WHERE role = ?').run(slug);
            const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role, perm) VALUES (?, ?)');
            valid.forEach(p => ins.run(slug, p));
        });
        tx();
    }
    auditLog(req.session.userId, 'ROLE_UPDATED', `Updated role: ${slug}`, req.ip);
    res.json({ success: true });
});

// Delete a role (admin only; cannot delete system roles or roles still in use)
app.delete('/api/roles/:slug', requireRole('admin'), (req, res) => {
    const { slug } = req.params;
    const role = db.prepare('SELECT * FROM roles WHERE slug = ?').get(slug);
    if (!role) return res.status(404).json({ error: 'Không tìm thấy vai trò' });
    if (role.is_system) return res.status(400).json({ error: 'Không thể xóa vai trò hệ thống' });
    const inUse = db.prepare('SELECT COUNT(*) c FROM admin_users WHERE role = ?').get(slug).c;
    if (inUse > 0) return res.status(400).json({ error: `Còn ${inUse} tài khoản đang dùng vai trò này. Hãy đổi vai trò cho họ trước.` });
    db.prepare('DELETE FROM role_permissions WHERE role = ?').run(slug);
    db.prepare('DELETE FROM roles WHERE slug = ?').run(slug);
    auditLog(req.session.userId, 'ROLE_DELETED', `Deleted role: ${slug}`, req.ip);
    res.json({ success: true });
});

// ===== TABLES API =====
app.get('/api/tables', requireAuth, (req, res) => {
    const tables = db.prepare('SELECT * FROM tables ORDER BY sort_order, name').all();
    res.json(tables);
});

app.post('/api/tables', requirePerm('table.manage'), (req, res) => {
    const { name, area } = req.body;
    if (!validateString(name)) return res.status(400).json({ error: 'Tên bàn không hợp lệ' });
    const existing = db.prepare('SELECT id FROM tables WHERE name = ?').get(name.trim());
    if (existing) return res.status(400).json({ error: 'Tên bàn đã tồn tại' });
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM tables').get().m || 0;
    db.prepare('INSERT INTO tables (name, area, sort_order) VALUES (?, ?, ?)').run(sanitize(name.trim()), sanitize(area || ''), maxSort + 1);
    auditLog(req.session.userId, 'TABLE_CREATED', name, req.ip);
    res.json({ success: true });
});

app.put('/api/tables/:id', requirePerm('table.manage'), (req, res) => {
    const { name, area, status } = req.body;
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) return res.status(404).json({ error: 'Không tìm thấy bàn' });

    if (name !== undefined) {
        if (!validateString(name)) return res.status(400).json({ error: 'Tên bàn không hợp lệ' });
        db.prepare('UPDATE tables SET name = ? WHERE id = ?').run(sanitize(name.trim()), req.params.id);
    }
    if (area !== undefined) {
        db.prepare('UPDATE tables SET area = ? WHERE id = ?').run(sanitize(area), req.params.id);
    }
    if (status !== undefined) {
        const allowed = ['available', 'occupied', 'reserved', 'cleaning'];
        if (!allowed.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
        db.prepare('UPDATE tables SET status = ? WHERE id = ?').run(status, req.params.id);
    }
    res.json({ success: true });
});

app.delete('/api/tables/:id', requirePerm('table.manage'), (req, res) => {
    const table = db.prepare('SELECT name FROM tables WHERE id = ?').get(req.params.id);
    if (!table) return res.status(404).json({ error: 'Không tìm thấy bàn' });
    db.prepare('DELETE FROM tables WHERE id = ?').run(req.params.id);
    auditLog(req.session.userId, 'TABLE_DELETED', table.name, req.ip);
    res.json({ success: true });
});

// ===== MENU API =====
app.get('/api/menu', requireAuth, (req, res) => {
    const menu = db.prepare('SELECT * FROM menu ORDER BY category, sort_order, name').all();
    res.json(menu);
});

app.post('/api/menu', requirePerm('menu.edit'), (req, res) => {
    const { id, name, category, price, description, status, image_url } = req.body;
    if (!validateString(name)) return res.status(400).json({ error: 'Tên món không hợp lệ' });
    if (!validateString(category)) return res.status(400).json({ error: 'Danh mục không hợp lệ' });
    if (!validateNumber(price, 0, 10000000)) return res.status(400).json({ error: 'Giá không hợp lệ' });

    const allowedStatuses = ['available', 'soldout'];
    const safeStatus = allowedStatuses.includes(status) ? status : 'available';
    if (!category || category.length > 50 || !/^[a-z0-9_]+$/.test(category)) return res.status(400).json({ error: 'Danh mục không hợp lệ (chỉ a-z, 0-9, _)' });
    const safeImage = image_url ? sanitize(image_url) : null;

    if (id) {
        const existing = db.prepare('SELECT id FROM menu WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ error: 'Không tìm thấy món' });
        db.prepare('UPDATE menu SET name = ?, category = ?, price = ?, description = ?, status = ?, image_url = ? WHERE id = ?')
            .run(sanitize(name), category, parseInt(price), sanitize(description || ''), safeStatus, safeImage, id);
        auditLog(req.session.userId, 'MENU_UPDATED', `${name} (${id})`, req.ip);
    } else {
        const newId = uuidv4().slice(0, 8);
        db.prepare('INSERT INTO menu (id, name, category, price, description, status, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(newId, sanitize(name), category, parseInt(price), sanitize(description || ''), safeStatus, safeImage);
        auditLog(req.session.userId, 'MENU_CREATED', `${name} (${newId})`, req.ip);
    }
    broadcastSSE({ type: 'menu_update' });
    res.json({ success: true });
});

app.delete('/api/menu/:id', requirePerm('menu.delete'), (req, res) => {
    const item = db.prepare('SELECT name FROM menu WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Không tìm thấy món' });
    db.prepare('DELETE FROM menu WHERE id = ?').run(req.params.id);
    auditLog(req.session.userId, 'MENU_DELETED', `${item.name} (${req.params.id})`, req.ip);
    broadcastSSE({ type: 'menu_update' });
    res.json({ success: true });
});

// ===== MENU IMAGE UPLOAD =====
app.post('/api/menu/:id/image', requirePerm('menu.edit'), menuImageUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Không có file ảnh' });
    const item = db.prepare('SELECT id, image_url FROM menu WHERE id = ?').get(req.params.id);
    if (!item) {
        fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'Không tìm thấy món' });
    }
    // Delete old image if exists
    if (item.image_url && item.image_url.startsWith('/uploads/')) {
        const oldPath = path.join(__dirname, item.image_url);
        try { fs.unlinkSync(oldPath); } catch(e) { console.warn('Warn:', e.message); }
    }
    const imageUrl = `/uploads/menu/${req.file.filename}`;
    db.prepare('UPDATE menu SET image_url = ? WHERE id = ?').run(imageUrl, req.params.id);
    res.json({ success: true, image_url: imageUrl });
});

// ===== NETWORK PRINT API =====
app.post('/api/print', requireAuth, (req, res) => {
    const { shopName, address, phone, invoiceNumber, date, tableName, staffName,
            items, subtotal, discountAmount, total, paymentMethod, paidAmount, changeAmount } = req.body;

    // Get printer IP from settings
    const printerIp = db.prepare("SELECT value FROM settings WHERE key = 'printer_ip'").get()?.value;
    const printerPort = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'printer_port'").get()?.value || '9100');

    if (!printerIp) {
        return res.status(400).json({ error: 'Chưa cài đặt IP máy in. Vào Cài đặt > Máy in để thiết lập.' });
    }

    // Build ESC/POS commands
    const ESC = '\x1B';
    const GS = '\x1D';
    const cmds = [];

    // Initialize
    cmds.push(ESC + '@');           // Reset
    cmds.push(ESC + 'a' + '\x01'); // Center

    // Shop name - double size
    cmds.push(GS + '!' + '\x11'); // Double width+height
    cmds.push((shopName || 'CHILL CAFE') + '\n');
    cmds.push(GS + '!' + '\x00'); // Normal size

    cmds.push((address || '') + '\n');
    cmds.push('SĐT: ' + (phone || '') + '\n');
    cmds.push('--------------------------------\n');

    // Invoice header
    cmds.push(ESC + 'E' + '\x01'); // Bold on
    cmds.push('HÓA ĐƠN THANH TOÁN\n');
    cmds.push(ESC + 'E' + '\x00'); // Bold off
    cmds.push('--------------------------------\n');

    cmds.push(ESC + 'a' + '\x00'); // Left align
    cmds.push('Mã HĐ: ' + (invoiceNumber || '') + '\n');
    cmds.push('Thời gian: ' + (date || '') + '\n');
    if (tableName) cmds.push('Bàn: ' + tableName + '\n');
    if (staffName) cmds.push('NV: ' + staffName + '\n');
    cmds.push('--------------------------------\n');

    // Items
    if (Array.isArray(items)) {
        for (const item of items) {
            const name = item.name || '';
            const qty = item.qty || 1;
            const itemTotal = item.total || (item.price * qty);
            const totalStr = itemTotal.toLocaleString('vi-VN') + 'đ';
            // Name on first line
            cmds.push(name + ' x' + qty + '\n');
            // Price right-aligned
            cmds.push(ESC + 'a' + '\x02'); // Right
            cmds.push(totalStr + '\n');
            cmds.push(ESC + 'a' + '\x00'); // Left
            if (item.note) cmds.push('  (' + item.note + ')\n');
        }
    }
    cmds.push('--------------------------------\n');

    // Totals
    if (discountAmount && discountAmount > 0) {
        cmds.push('Tạm tính:       ' + (subtotal || 0).toLocaleString('vi-VN') + 'đ\n');
        cmds.push('Giảm giá:      -' + discountAmount.toLocaleString('vi-VN') + 'đ\n');
        cmds.push('--------------------------------\n');
    }

    cmds.push(ESC + 'E' + '\x01'); // Bold
    cmds.push(GS + '!' + '\x01'); // Double height
    cmds.push('TỔNG: ' + (total || 0).toLocaleString('vi-VN') + 'đ\n');
    cmds.push(GS + '!' + '\x00'); // Normal
    cmds.push(ESC + 'E' + '\x00'); // Bold off

    cmds.push('Thanh toán: ' + (paymentMethod || '') + '\n');
    if (paidAmount) cmds.push('Khách đưa: ' + paidAmount.toLocaleString('vi-VN') + 'đ\n');
    if (changeAmount && changeAmount > 0) cmds.push('Tiền thừa: ' + changeAmount.toLocaleString('vi-VN') + 'đ\n');

    // Footer
    cmds.push('--------------------------------\n');
    cmds.push(ESC + 'a' + '\x01'); // Center
    cmds.push('Cảm ơn quý khách!\n');
    cmds.push('Hẹn gặp lại!\n');
    cmds.push('\n\n\n\n'); // Feed paper

    // Cut paper (partial cut)
    cmds.push(GS + 'V' + '\x01');

    // Send to printer via TCP
    const printData = cmds.join('');
    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(printerPort, printerIp, () => {
        client.write(Buffer.from(printData, 'utf8'), () => {
            client.end();
            res.json({ success: true, message: 'Đã gửi lệnh in' });
        });
    });

    client.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: 'Không kết nối được máy in: ' + err.message });
    });

    client.on('timeout', () => {
        client.destroy();
        if (!res.headersSent) res.status(500).json({ error: 'Máy in không phản hồi (timeout)' });
    });
});

// ===== ORDERS API =====
app.get('/api/orders', requireAuth, (req, res) => {
    const { date, status, limit } = req.query;
    let query = 'SELECT * FROM orders';
    const conditions = [];
    const params = [];

    if (date) { conditions.push('date = ?'); params.push(date); }
    if (status && status !== 'all') {
        const allowed = ['pending', 'done', 'cancelled', 'paid'];
        if (allowed.includes(status)) { conditions.push('status = ?'); params.push(status); }
    }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC';
    if (limit) query += ` LIMIT ${parseInt(limit) || 50}`;

    const orders = db.prepare(query).all(...params);
    const result = orders.map(o => ({ ...o, items: JSON.parse(o.items) }));
    res.json(result);
});

app.post('/api/orders', requireAuth, (req, res) => {
    const { items, type, note, table_id, discount_type, discount_value } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Đơn hàng phải có ít nhất 1 món' });
    }
    const allowedTypes = ['dine-in', 'takeaway'];
    if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: 'Hình thức không hợp lệ' });
    }

    const menuItems = db.prepare('SELECT * FROM menu').all();
    const menuMap = Object.fromEntries(menuItems.map(m => [m.id, m]));

    const validatedItems = [];
    let subtotal = 0;
    for (const item of items) {
        const menuItem = menuMap[item.id];
        if (!menuItem) return res.status(400).json({ error: `Món ${item.id} không tồn tại` });
        if (!validateNumber(item.qty, 1, 100)) return res.status(400).json({ error: 'Số lượng không hợp lệ' });
        const qty = parseInt(item.qty);
        validatedItems.push({
            id: menuItem.id, name: menuItem.name, price: menuItem.price, qty,
            note: item.note || ''
        });
        subtotal += menuItem.price * qty;
    }

    // Calculate discount
    let discountAmount = 0;
    if (discount_type === 'percent' && validateNumber(discount_value, 0, 100)) {
        discountAmount = Math.round(subtotal * discount_value / 100);
    } else if (discount_type === 'fixed' && validateNumber(discount_value, 0, subtotal)) {
        discountAmount = parseInt(discount_value);
    }
    const total = subtotal - discountAmount;

    // Get table name
    let tableName = '';
    if (table_id) {
        const table = db.prepare('SELECT name FROM tables WHERE id = ?').get(table_id);
        if (table) tableName = table.name;
    }

    // Get current shift
    const currentShift = db.prepare("SELECT id, staff_name FROM shifts WHERE status = 'open' ORDER BY open_time DESC LIMIT 1").get();

    const orderId = uuidv4().slice(0, 8);
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    db.prepare(`INSERT INTO orders (id, items, total, subtotal, discount_amount, discount_type, discount_value,
        type, table_id, table_name, note, status, shift_id, staff_name, date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(orderId, JSON.stringify(validatedItems), total, subtotal, discountAmount,
            discount_type || null, discount_value || 0,
            type, table_id || null, tableName, sanitize(note || ''), 'pending',
            currentShift?.id || null, currentShift?.staff_name || req.session.displayName || '',
            date, now.toISOString());

    // Update table status
    if (table_id) {
        db.prepare('UPDATE tables SET status = ?, current_order_id = ? WHERE id = ?').run('occupied', orderId, table_id);
    }

    auditLog(req.session.userId, 'ORDER_CREATED', `#${orderId} - ${total}đ`, req.ip);
    broadcastSSE({ type: 'order_created', orderId, tableId: table_id, tableName, total, by: req.session.displayName });
    res.json({ success: true, id: orderId, total, subtotal, discountAmount });
});

app.put('/api/orders/:id/items', requireAuth, (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Đơn hàng phải có ít nhất 1 món' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    const menuItems = db.prepare('SELECT * FROM menu').all();
    const menuMap = Object.fromEntries(menuItems.map(m => [m.id, m]));

    const validatedItems = [];
    let subtotal = 0;
    for (const item of items) {
        const menuItem = menuMap[item.id];
        if (!menuItem) return res.status(400).json({ error: `Món không tồn tại` });
        if (!validateNumber(item.qty, 1, 100)) return res.status(400).json({ error: 'Số lượng không hợp lệ' });
        const qty = parseInt(item.qty);
        validatedItems.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, qty, note: item.note || '' });
        subtotal += menuItem.price * qty;
    }

    const discountType = order.discount_type || '';
    const discountValue = order.discount_value || 0;
    let discountAmount = 0;
    if (discountType === 'percent') discountAmount = Math.round(subtotal * discountValue / 100);
    else if (discountType === 'fixed') discountAmount = Math.min(discountValue, subtotal);
    const total = subtotal - discountAmount;

    db.prepare('UPDATE orders SET items = ?, subtotal = ?, total = ?, discount_amount = ? WHERE id = ?')
        .run(JSON.stringify(validatedItems), subtotal, total, discountAmount, req.params.id);

    auditLog(req.session.userId, 'ORDER_EDITED', `#${req.params.id} - ${total}đ`, req.ip);
    broadcastSSE({ type: 'order_updated', orderId: req.params.id, total, by: req.session.displayName });
    res.json({ success: true, total, subtotal, discountAmount });
});

app.put('/api/orders/:id/status', requireAuth, (req, res) => {
    const { status } = req.body;
    const allowedStatuses = ['done', 'cancelled', 'pending'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);

    // Free table if order completed or cancelled
    if ((status === 'done' || status === 'cancelled') && order.table_id) {
        db.prepare('UPDATE tables SET status = ?, current_order_id = NULL WHERE id = ? AND current_order_id = ?')
            .run('available', order.table_id, req.params.id);
    }

    auditLog(req.session.userId, 'ORDER_STATUS', `#${req.params.id} -> ${status}`, req.ip);
    broadcastSSE({ type: 'order_status', orderId: req.params.id, status, tableId: order.table_id, by: req.session.displayName });
    res.json({ success: true });
});

// ===== PAYMENT API =====
app.post('/api/orders/:id/pay', requireAuth, (req, res) => {
    const { payment_method, payment_amount } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    if (order.status === 'paid') return res.status(400).json({ error: 'Đơn hàng đã thanh toán' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'Đơn hàng đã hủy' });

    const allowedMethods = ['cash', 'transfer', 'card', 'qr'];
    if (!allowedMethods.includes(payment_method)) {
        return res.status(400).json({ error: 'Phương thức thanh toán không hợp lệ' });
    }

    const paidAmount = parseInt(payment_amount) || order.total;
    const changeAmount = Math.max(0, paidAmount - order.total);
    const invoiceNumber = getNextInvoiceNumber();
    const now = new Date().toISOString();

    db.prepare(`UPDATE orders SET status = 'paid', payment_method = ?, payment_amount = ?,
        change_amount = ?, invoice_number = ?, code = ?, paid_at = ? WHERE id = ?`)
        .run(payment_method, paidAmount, changeAmount, invoiceNumber, invoiceNumber, now, req.params.id);

    // Free table
    if (order.table_id) {
        db.prepare('UPDATE tables SET status = ?, current_order_id = NULL WHERE id = ? AND current_order_id = ?')
            .run('available', order.table_id, req.params.id);
    }

    // Record income transaction
    const currentShift = db.prepare("SELECT id, staff_name FROM shifts WHERE status = 'open' ORDER BY open_time DESC LIMIT 1").get();
    db.prepare(`INSERT INTO transactions (code, type, category, amount, payment_method, description, shift_id, staff_name, date)
        VALUES (?, 'income', 'sales', ?, ?, ?, ?, ?, ?)`)
        .run(invoiceNumber, order.total, payment_method, `Thanh toán ${invoiceNumber}`,
            currentShift?.id || null, currentShift?.staff_name || '', new Date().toISOString().split('T')[0]);

    auditLog(req.session.userId, 'ORDER_PAID', `#${req.params.id} - ${invoiceNumber} - ${order.total}đ (${payment_method})`, req.ip);
    broadcastSSE({ type: 'order_paid', orderId: req.params.id, tableId: order.table_id, invoiceNumber, total: order.total, by: req.session.displayName });

    // Get settings for receipt
    const settingsRows = db.prepare('SELECT * FROM settings').all();
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    res.json({
        success: true,
        invoice_number: invoiceNumber,
        change: changeAmount,
        receipt: {
            shopName: settings.name || 'CHILL CAFE',
            address: settings.address || '',
            phone: settings.phone || '',
            invoiceNumber,
            date: now,
            tableName: order.table_name || '',
            staffName: order.staff_name || '',
            items: JSON.parse(order.items || '[]'),
            subtotal: order.subtotal || order.total,
            discountAmount: order.discount_amount || 0,
            total: order.total,
            paymentMethod: payment_method,
            paidAmount,
            change: changeAmount
        }
    });
});

// Delete order (admin only)
app.delete('/api/orders/:id', requirePerm('order.delete'), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

    // Delete related transaction if paid
    if (order.invoice_number) {
        db.prepare('DELETE FROM transactions WHERE code = ?').run(order.invoice_number);
    }
    // Free table if needed
    if (order.table_id) {
        db.prepare('UPDATE tables SET status = ?, current_order_id = NULL WHERE id = ? AND current_order_id = ?')
            .run('available', order.table_id, req.params.id);
    }
    // Delete order
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);

    const reason = req.query.reason || 'Không rõ';
    auditLog(req.session.userId, 'ORDER_DELETED', `#${req.params.id} - ${order.code || ''} - ${order.total}đ - Lý do: ${reason}`, req.ip);
    broadcastSSE({ type: 'order_status', orderId: req.params.id, by: req.session.displayName });
    res.json({ success: true });
});

// ===== TAX REPORT API =====
app.get('/api/reports/tax', requirePerm('report.view'), (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'Thiếu ngày bắt đầu/kết thúc' });

    const orders = db.prepare(`
        SELECT paid_at, invoice_number, total, table_name
        FROM orders WHERE status = 'paid' AND paid_at >= ? AND paid_at <= ?
        ORDER BY paid_at ASC
    `).all(from, to + 'T23:59:59');

    // Group by date
    const daily = {};
    for (const o of orders) {
        const date = (o.paid_at || '').split('T')[0];
        if (!daily[date]) daily[date] = { date, total: 0, count: 0 };
        daily[date].total += o.total;
        daily[date].count++;
    }

    const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

    res.json({
        shopName: settings.name || 'CHILL CAFE',
        address: settings.address || '',
        taxId: settings.tax_id || '',
        from, to,
        daily: Object.values(daily),
        grandTotal: orders.reduce((s, o) => s + o.total, 0),
        orderCount: orders.length
    });
});

// ===== SHIFTS API =====
app.get('/api/shifts', requireAuth, (req, res) => {
    const { status, limit } = req.query;
    let query = 'SELECT * FROM shifts';
    const params = [];
    if (status) { query += ' WHERE status = ?'; params.push(status); }
    query += ' ORDER BY open_time DESC';
    if (limit) query += ` LIMIT ${parseInt(limit) || 20}`;
    const shifts = db.prepare(query).all(...params);
    for (const s of shifts) {
        const revenue = db.prepare(
            "SELECT COALESCE(SUM(total), 0) as rev, COUNT(*) as cnt FROM orders WHERE status = 'paid' AND shift_id = ?"
        ).get(s.id);
        s.revenue = revenue?.rev || 0;
        s.orderCount = revenue?.cnt || 0;
    }
    res.json(shifts);
});

app.get('/api/shifts/current', requireAuth, (req, res) => {
    const shift = db.prepare("SELECT * FROM shifts WHERE status = 'open' ORDER BY open_time DESC LIMIT 1").get();
    if (!shift) return res.json({ shift: null });

    // Get shift stats
    const orders = db.prepare("SELECT * FROM orders WHERE shift_id = ? AND status = 'paid'").all(shift.id);
    let revenue = 0;
    orders.forEach(o => { revenue += o.total; });

    const transactions = db.prepare('SELECT * FROM transactions WHERE shift_id = ?').all(shift.id);
    let income = 0, expense = 0;
    transactions.forEach(t => {
        if (t.type === 'income') income += t.amount;
        else expense += t.amount;
    });

    res.json({
        shift,
        stats: { ordersCount: orders.length, revenue, income, expense, net: income - expense }
    });
});

app.post('/api/shifts/open', requireAuth, (req, res) => {
    const { staff_id, open_amount, note } = req.body;
    let staff_name = req.body.staff_name;

    // Check if there's already an open shift
    const existing = db.prepare("SELECT * FROM shifts WHERE status = 'open'").get();
    if (existing) return res.status(400).json({ error: 'Đã có ca đang mở. Vui lòng đóng ca trước.' });

    // Resolve the opener from the staff list (preferred) or accept a free name
    let sid = null;
    if (staff_id) {
        const st = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(staff_id);
        if (!st) return res.status(400).json({ error: 'Nhân viên không hợp lệ' });
        sid = st.id; staff_name = st.name;
    }
    if (!validateString(staff_name)) return res.status(400).json({ error: 'Vui lòng chọn nhân viên mở ca' });

    const code = 'CA' + Date.now().toString(36).toUpperCase();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO shifts (code, staff_name, staff_id, open_time, open_amount, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(code, sanitize(staff_name), sid, now, parseInt(open_amount) || 0, sanitize(note || ''), 'open');

    const shift = db.prepare('SELECT * FROM shifts WHERE code = ?').get(code);
    if (sid) db.prepare('INSERT OR IGNORE INTO shift_staff (shift_id, staff_id, staff_name) VALUES (?, ?, ?)').run(shift.id, sid, staff_name);

    auditLog(req.session.userId, 'SHIFT_OPENED', `${code} - ${staff_name}`, req.ip);
    res.json({ success: true, shift });
});

// ===== SHIFT ATTENDANCE (điểm danh nhiều nhân viên trong 1 ca) =====
app.get('/api/shifts/:id/staff', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT staff_id, staff_name FROM shift_staff WHERE shift_id = ?').all(req.params.id));
});
app.post('/api/shifts/:id/staff', requirePerm('shift.manage'), (req, res) => {
    const shift = db.prepare('SELECT id FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Không tìm thấy ca' });
    const st = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(req.body.staff_id);
    if (!st) return res.status(400).json({ error: 'Nhân viên không hợp lệ' });
    db.prepare('INSERT OR IGNORE INTO shift_staff (shift_id, staff_id, staff_name) VALUES (?, ?, ?)').run(shift.id, st.id, st.name);
    res.json({ success: true });
});
app.delete('/api/shifts/:id/staff/:staffId', requirePerm('shift.manage'), (req, res) => {
    db.prepare('DELETE FROM shift_staff WHERE shift_id = ? AND staff_id = ?').run(req.params.id, req.params.staffId);
    res.json({ success: true });
});
// Admin/quản lý đổi nhân viên mở ca của một ca
app.put('/api/shifts/:id', requirePerm('shift.manage'), (req, res) => {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Không tìm thấy ca' });
    const st = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(req.body.staff_id);
    if (!st) return res.status(400).json({ error: 'Nhân viên không hợp lệ' });
    db.prepare('UPDATE shifts SET staff_id = ?, staff_name = ? WHERE id = ?').run(st.id, st.name, shift.id);
    db.prepare('INSERT OR IGNORE INTO shift_staff (shift_id, staff_id, staff_name) VALUES (?, ?, ?)').run(shift.id, st.id, st.name);
    auditLog(req.session.userId, 'SHIFT_STAFF_UPDATED', `${shift.code} -> ${st.name}`, req.ip);
    res.json({ success: true });
});

app.post('/api/shifts/:id/close', requireAuth, (req, res) => {
    const { close_amount, note } = req.body;
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND status = ?').get(req.params.id, 'open');
    if (!shift) return res.status(404).json({ error: 'Không tìm thấy ca đang mở' });

    // Calculate shift summary first
    const orders = db.prepare("SELECT * FROM orders WHERE shift_id = ? AND status = 'paid'").all(shift.id);
    let revenue = 0;
    orders.forEach(o => { revenue += o.total; });

    const transactions = db.prepare('SELECT * FROM transactions WHERE shift_id = ?').all(shift.id);
    let income = 0, expense = 0;
    transactions.forEach(t => {
        if (t.type === 'income') income += t.amount;
        else expense += t.amount;
    });

    const expectedCash = shift.open_amount + income - expense;
    const finalAmount = (close_amount !== undefined && close_amount !== null && close_amount !== '') ? parseInt(close_amount) : expectedCash;

    const now = new Date().toISOString();
    db.prepare('UPDATE shifts SET status = ?, close_time = ?, close_amount = ?, note = ? WHERE id = ?')
        .run('closed', now, finalAmount, sanitize(note || shift.note || ''), req.params.id);

    auditLog(req.session.userId, 'SHIFT_CLOSED', `${shift.code} - Revenue: ${revenue}đ`, req.ip);
    res.json({
        success: true,
        summary: {
            code: shift.code,
            staffName: shift.staff_name,
            openTime: shift.open_time,
            closeTime: now,
            openAmount: shift.open_amount,
            closeAmount: finalAmount,
            ordersCount: orders.length,
            revenue, income, expense,
            expectedCash
        }
    });
});

// ===== TRANSACTIONS API =====
app.get('/api/transactions', requireAuth, (req, res) => {
    const { date, type, limit } = req.query;
    let query = 'SELECT * FROM transactions';
    const conditions = [];
    const params = [];
    if (date) { conditions.push('date = ?'); params.push(date); }
    if (type && (type === 'income' || type === 'expense')) {
        conditions.push('type = ?'); params.push(type);
    }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC';
    if (limit) query += ` LIMIT ${parseInt(limit) || 50}`;
    res.json(db.prepare(query).all(...params));
});

app.post('/api/transactions', requirePerm('transaction.edit'), (req, res) => {
    const { type, category, amount, payment_method, description } = req.body;

    if (!type || !['income', 'expense'].includes(type)) {
        return res.status(400).json({ error: 'Loại giao dịch không hợp lệ' });
    }
    if (!validateString(category)) return res.status(400).json({ error: 'Danh mục không hợp lệ' });
    if (!validateNumber(amount, 1, 1000000000)) return res.status(400).json({ error: 'Số tiền không hợp lệ' });

    const currentShift = db.prepare("SELECT id, staff_name FROM shifts WHERE status = 'open' ORDER BY open_time DESC LIMIT 1").get();
    const code = (type === 'income' ? 'THU' : 'CHI') + Date.now().toString(36).toUpperCase();
    const date = new Date().toISOString().split('T')[0];

    db.prepare('INSERT INTO transactions (code, type, category, amount, payment_method, description, shift_id, staff_name, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(code, type, sanitize(category), parseInt(amount), payment_method || 'cash',
            sanitize(description || ''), currentShift?.id || null, currentShift?.staff_name || '', date);

    auditLog(req.session.userId, 'TRANSACTION_CREATED', `${code} - ${type} ${amount}đ`, req.ip);
    res.json({ success: true });
});

app.delete('/api/transactions/:id', requirePerm('transaction.delete'), (req, res) => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
    db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
    auditLog(req.session.userId, 'TRANSACTION_DELETED', `${tx.code}`, req.ip);
    res.json({ success: true });
});

// ===== INVENTORY API =====
app.get('/api/inventory', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT * FROM inventory ORDER BY name').all());
});

app.post('/api/inventory', requirePerm('inventory.edit'), (req, res) => {
    const { id, name, qty, unit, min_qty, cost_price } = req.body;
    if (!validateString(name)) return res.status(400).json({ error: 'Tên nguyên liệu không hợp lệ' });
    if (!validateNumber(qty, 0, 1000000)) return res.status(400).json({ error: 'Số lượng không hợp lệ' });
    if (!validateString(unit)) return res.status(400).json({ error: 'Đơn vị không hợp lệ' });
    if (!validateNumber(min_qty, 0, 1000000)) return res.status(400).json({ error: 'Mức tối thiểu không hợp lệ' });

    if (id) {
        const existing = db.prepare('SELECT id FROM inventory WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ error: 'Không tìm thấy nguyên liệu' });
        db.prepare('UPDATE inventory SET name = ?, qty = ?, unit = ?, min_qty = ?, cost_price = ? WHERE id = ?')
            .run(sanitize(name), parseFloat(qty), sanitize(unit), parseFloat(min_qty), parseInt(cost_price) || 0, id);
        auditLog(req.session.userId, 'INVENTORY_UPDATED', `${name} (${id})`, req.ip);
    } else {
        const newId = uuidv4().slice(0, 8);
        db.prepare('INSERT INTO inventory (id, name, qty, unit, min_qty, cost_price) VALUES (?, ?, ?, ?, ?, ?)')
            .run(newId, sanitize(name), parseFloat(qty), sanitize(unit), parseFloat(min_qty), parseInt(cost_price) || 0);
        auditLog(req.session.userId, 'INVENTORY_CREATED', `${name} (${newId})`, req.ip);
    }
    res.json({ success: true });
});

app.delete('/api/inventory/:id', requirePerm('inventory.delete'), (req, res) => {
    const item = db.prepare('SELECT name FROM inventory WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Không tìm thấy nguyên liệu' });
    db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
    auditLog(req.session.userId, 'INVENTORY_DELETED', `${item.name}`, req.ip);
    res.json({ success: true });
});

// ===== STAFF API =====
app.get('/api/staff', requireAuth, (req, res) => {
    res.json(db.prepare('SELECT * FROM staff ORDER BY name').all());
});

app.post('/api/staff', requirePerm('staff.edit'), (req, res) => {
    const { id, name, role, phone, shift, salary, status, pay_type } = req.body;
    if (!validateString(name)) return res.status(400).json({ error: 'Tên nhân viên không hợp lệ' });
    if (!isValidRole(role)) return res.status(400).json({ error: 'Vị trí không hợp lệ' });
    const allowedShifts = ['morning', 'afternoon', 'full'];
    if (!allowedShifts.includes(shift)) return res.status(400).json({ error: 'Ca làm không hợp lệ' });
    const payType = ['hour', 'shift', 'month'].includes(pay_type) ? pay_type : 'month';

    if (id) {
        const existing = db.prepare('SELECT id FROM staff WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
        db.prepare('UPDATE staff SET name = ?, role = ?, phone = ?, shift = ?, salary = ?, status = ?, pay_type = ? WHERE id = ?')
            .run(sanitize(name), role, sanitize(phone || ''), shift, parseInt(salary) || 0, status || 'active', payType, id);
        auditLog(req.session.userId, 'STAFF_UPDATED', `${name} (${id})`, req.ip);
    } else {
        const newId = uuidv4().slice(0, 8);
        db.prepare('INSERT INTO staff (id, name, role, phone, shift, salary, status, pay_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(newId, sanitize(name), role, sanitize(phone || ''), shift, parseInt(salary) || 0, 'active', payType);
        auditLog(req.session.userId, 'STAFF_CREATED', `${name} (${newId})`, req.ip);
    }
    res.json({ success: true });
});

app.delete('/api/staff/:id', requirePerm('staff.delete'), (req, res) => {
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(req.params.id);
    if (!staff) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });
    db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
    auditLog(req.session.userId, 'STAFF_DELETED', `${staff.name}`, req.ip);
    res.json({ success: true });
});

// ===== PAYROLL (bảng tính lương — nhập tay, lưu theo tháng) =====
app.get('/api/payroll/:period', requirePerm('payroll.view'), (req, res) => {
    const period = String(req.params.period || '').slice(0, 7);
    const row = db.prepare('SELECT data, updated_at, updated_by FROM payroll_sheets WHERE period = ?').get(period);
    let rows = [];
    try { rows = row ? JSON.parse(row.data) : []; } catch (e) { rows = []; }
    res.json({ period, rows, updated_at: row?.updated_at || null, updated_by: row?.updated_by || null });
});
app.put('/api/payroll/:period', requirePerm('payroll.edit'), (req, res) => {
    const period = String(req.params.period || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Kỳ lương không hợp lệ' });
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const clean = rows.map(r => ({
        staff_id: String(r.staff_id || ''),
        name: sanitize(String(r.name || '')).slice(0, 100),
        pay_type: ['hour', 'shift', 'month'].includes(r.pay_type) ? r.pay_type : 'month',
        rate: Number(r.rate) || 0,
        qty: Number(r.qty) || 0,
        allowance: Number(r.allowance) || 0,
        deduction: Number(r.deduction) || 0,
        note: sanitize(String(r.note || '')).slice(0, 200),
    }));
    db.prepare(`INSERT INTO payroll_sheets (period, data, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(period) DO UPDATE SET data=excluded.data, updated_at=datetime('now'), updated_by=excluded.updated_by`)
        .run(period, JSON.stringify(clean), req.session.displayName || req.session.username);
    auditLog(req.session.userId, 'PAYROLL_SAVED', period, req.ip);
    res.json({ success: true });
});

// Public: chỉ trả google_client_id (không cần auth)
app.get('/api/settings/public', (req, res) => {
    const clientId = db.prepare("SELECT value FROM settings WHERE key = 'google_client_id'").get()?.value || '';
    res.json({ google_client_id: clientId });
});

// ===== SETTINGS API =====
app.get('/api/settings', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM settings').all();
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put('/api/settings', requireRole('admin'), (req, res) => {
    const allowedKeys = ['name', 'address', 'phone', 'hours', 'facebook', 'invoice_prefix', 'bank_name', 'bank_account', 'bank_owner', 'payment_qr_url', 'google_client_id', 'printer_ip', 'printer_port', 'shop_lat', 'shop_lng', 'geo_restrict', 'geo_radius', 'tax_id'];
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const updateMany = db.transaction(() => {
        for (const key of allowedKeys) {
            if (req.body[key] !== undefined) {
                upsert.run(key, sanitize(String(req.body[key]).slice(0, 500)));
            }
        }
        // category_names: JSON object mapping slug -> display name
        if (req.body.category_names !== undefined) {
            let val = req.body.category_names;
            if (typeof val === 'object' && val !== null) {
                const clean = {};
                for (const [k, v] of Object.entries(val)) {
                    const key = String(k).slice(0, 50).replace(/[^a-z0-9_]/gi, '');
                    const name = sanitize(String(v).slice(0, 100));
                    if (key && name) clean[key] = name;
                }
                upsert.run('category_names', JSON.stringify(clean));
            } else if (typeof val === 'string') {
                try {
                    const parsed = JSON.parse(val);
                    if (parsed && typeof parsed === 'object') {
                        upsert.run('category_names', sanitize(val.slice(0, 5000)));
                    }
                } catch (e) { /* ignore invalid JSON */ }
            }
        }
    });
    updateMany();
    auditLog(req.session.userId, 'SETTINGS_UPDATED', null, req.ip);
    res.json({ success: true });
});

// ===== DASHBOARD API =====
app.get('/api/dashboard', requireAuth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    const todayPaid = db.prepare("SELECT * FROM orders WHERE date = ? AND status = 'paid'").all(today);
    const todayPending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE date = ? AND status = 'pending'").get(today).c;

    let revenue = 0, items = 0;
    todayPaid.forEach(o => {
        revenue += o.total;
        const orderItems = JSON.parse(o.items);
        items += orderItems.reduce((s, i) => s + i.qty, 0);
    });

    // Recent orders
    const recentOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all()
        .map(o => ({ ...o, items: JSON.parse(o.items) }));

    // Top items (last 30 days)
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const monthOrders = db.prepare("SELECT items FROM orders WHERE date >= ? AND status IN ('done','paid')").all(monthAgo);
    const itemCounts = {};
    monthOrders.forEach(o => {
        JSON.parse(o.items).forEach(i => {
            itemCounts[i.name] = (itemCounts[i.name] || 0) + i.qty;
        });
    });
    const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([name, count]) => ({ name, count }));

    // Payment method breakdown today
    const paymentBreakdown = { cash: 0, transfer: 0, card: 0, qr: 0 };
    todayPaid.forEach(o => {
        if (o.payment_method && paymentBreakdown[o.payment_method] !== undefined) {
            paymentBreakdown[o.payment_method] += o.total;
        }
    });

    // Revenue last 7 days
    const revenueByDay = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const dayOrders = db.prepare("SELECT SUM(total) as rev, COUNT(*) as cnt FROM orders WHERE date = ? AND status = 'paid'").get(d);
        revenueByDay.push({ date: d, revenue: dayOrders.rev || 0, orders: dayOrders.cnt || 0 });
    }

    // Current shift
    const currentShift = db.prepare("SELECT * FROM shifts WHERE status = 'open' ORDER BY open_time DESC LIMIT 1").get();

    // Tables status
    const tablesStatus = db.prepare('SELECT status, COUNT(*) as cnt FROM tables GROUP BY status').all();

    res.json({
        revenue,
        ordersCount: todayPaid.length,
        pendingCount: todayPending,
        itemsSold: items,
        avg: todayPaid.length ? Math.round(revenue / todayPaid.length) : 0,
        recentOrders,
        topItems,
        paymentBreakdown,
        revenueByDay,
        currentShift,
        tablesStatus
    });
});

// ===== REPORTS API =====
app.get('/api/reports/overview', requireAuth, (req, res) => {
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const dateFrom = from || today;
    const dateTo = to || today;

    const orders = db.prepare("SELECT * FROM orders WHERE date >= ? AND date <= ? AND status = 'paid'").all(dateFrom, dateTo);

    let revenue = 0, totalItems = 0;
    const byDate = {};
    const byCategory = {};
    const byPayment = { cash: 0, transfer: 0, card: 0, qr: 0 };
    const itemSales = {};

    orders.forEach(o => {
        revenue += o.total;
        const items = JSON.parse(o.items);
        items.forEach(i => {
            totalItems += i.qty;
            itemSales[i.name] = (itemSales[i.name] || 0) + i.qty;
        });

        if (!byDate[o.date]) byDate[o.date] = { orders: 0, revenue: 0, items: 0 };
        byDate[o.date].orders++;
        byDate[o.date].revenue += o.total;
        byDate[o.date].items += items.reduce((s, i) => s + i.qty, 0);

        if (o.payment_method && byPayment[o.payment_method] !== undefined) {
            byPayment[o.payment_method] += o.total;
        }
    });

    // Transactions in range
    const txs = db.prepare('SELECT * FROM transactions WHERE date >= ? AND date <= ?').all(dateFrom, dateTo);
    let totalIncome = 0, totalExpense = 0;
    txs.forEach(t => {
        if (t.type === 'income') totalIncome += t.amount;
        else totalExpense += t.amount;
    });

    const topProducts = Object.entries(itemSales).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([name, qty]) => ({ name, qty }));

    res.json({
        dateFrom, dateTo,
        revenue, ordersCount: orders.length, totalItems,
        avg: orders.length ? Math.round(revenue / orders.length) : 0,
        byDate, byPayment, topProducts,
        totalIncome, totalExpense, netIncome: totalIncome - totalExpense
    });
});

// ===== AUDIT LOG API =====
app.get('/api/audit-log', requireAuth, (req, res) => {
    const logs = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100').all();
    res.json(logs);
});

// ===== SSE (Server-Sent Events) for real-time sync =====
const sseClients = new Set();

app.get('/api/sse', requireAuth, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

function broadcastSSE(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch (e) { sseClients.delete(client); }
    }
}

// ===== TABLE ORDERS API (persistent pending orders) =====
app.get('/api/table-orders', requireAuth, (req, res) => {
    const rows = ordersDb.prepare('SELECT * FROM table_orders').all();
    const result = {};
    for (const row of rows) {
        result[row.table_id] = {
            cart: JSON.parse(row.cart),
            discount: JSON.parse(row.discount),
            startedAt: row.started_at
        };
    }
    res.json(result);
});

app.put('/api/table-orders/:tableId', requireAuth, (req, res) => {
    const tableId = parseInt(req.params.tableId);
    const { cart, discount, startedAt } = req.body;
    if (!cart || !Array.isArray(cart)) return res.status(400).json({ error: 'Invalid cart' });

    if (cart.length > 0) {
        ordersDb.prepare(`INSERT INTO table_orders (table_id, cart, discount, started_at, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(table_id) DO UPDATE SET cart=?, discount=?, started_at=COALESCE(table_orders.started_at, ?), updated_by=?, updated_at=datetime('now')`)
            .run(tableId, JSON.stringify(cart), JSON.stringify(discount || {}), startedAt || Date.now(),
                 req.session.displayName || req.session.username,
                 JSON.stringify(cart), JSON.stringify(discount || {}), startedAt || Date.now(),
                 req.session.displayName || req.session.username);
    } else {
        ordersDb.prepare('DELETE FROM table_orders WHERE table_id = ?').run(tableId);
    }

    broadcastSSE({ type: 'table_order_update', tableId, cart, discount, startedAt: startedAt || Date.now(), by: req.session.displayName });
    res.json({ success: true });
});

app.delete('/api/table-orders/:tableId', requireAuth, (req, res) => {
    const tableId = parseInt(req.params.tableId);
    ordersDb.prepare('DELETE FROM table_orders WHERE table_id = ?').run(tableId);
    broadcastSSE({ type: 'table_order_update', tableId, cart: [], discount: {}, startedAt: null, by: req.session.displayName });
    res.json({ success: true });
});

// ===== NETWORK PRINTER API =====

app.post('/api/printer/test', requireRole('admin', 'manager'), (req, res) => {
    const { ip, port } = req.body;
    if (!ip) return res.status(400).json({ error: 'Thiếu IP máy in' });
    if (!isPrivateIp(ip)) return res.status(400).json({ error: 'Chỉ cho phép IP máy in trong mạng nội bộ (LAN).' });
    const p = parseInt(port) || 9100;

    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(p, ip, () => {
        // Send test print
        const buf = Buffer.concat([
            Buffer.from([0x1B, 0x40]), // Init
            Buffer.from([0x1B, 0x61, 0x01]), // Center
            Buffer.from('CHILL CAFE\n', 'utf8'),
            Buffer.from('--- TEST PRINT ---\n', 'utf8'),
            Buffer.from('May in da ket noi!\n', 'utf8'),
            Buffer.from([0x1B, 0x61, 0x00]), // Left
            Buffer.from('IP: ' + ip + ':' + p + '\n\n\n\n', 'utf8'),
        ]);
        client.write(buf, () => {
            client.destroy();
            res.json({ success: true, message: 'In thử thành công!' });
        });
    });

    client.on('timeout', () => { client.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Timeout - không kết nối được máy in' }); });
    client.on('error', (err) => { client.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Lỗi: ' + err.message }); });
});

app.post('/api/printer/print', requireAuth, (req, res) => {
    const { receipt } = req.body;
    if (!receipt) return res.status(400).json({ error: 'Thiếu dữ liệu hóa đơn' });

    // Get printer IP from settings
    const printerIp = db.prepare("SELECT value FROM settings WHERE key = 'printer_ip'").get()?.value;
    const printerPort = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'printer_port'").get()?.value || '9100');

    if (!printerIp) return res.status(400).json({ error: 'Chưa cài đặt máy in. Vào Cài đặt > Máy in.' });

    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(printerPort, printerIp, () => {
        const buf = buildReceiptBuffer(receipt);
        client.write(buf, () => {
            client.destroy();
            res.json({ success: true });
        });
    });

    client.on('timeout', () => { client.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Máy in không phản hồi' }); });
    client.on('error', (err) => { client.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Lỗi in: ' + err.message }); });
});

function buildReceiptBuffer(r) {
    const parts = [];
    const ESC_INIT = Buffer.from([0x1B, 0x40]);
    const CENTER = Buffer.from([0x1B, 0x61, 0x01]);
    const LEFT = Buffer.from([0x1B, 0x61, 0x00]);
    const BOLD_ON = Buffer.from([0x1B, 0x45, 0x01]);
    const BOLD_OFF = Buffer.from([0x1B, 0x45, 0x00]);
    const DOUBLE = Buffer.from([0x1D, 0x21, 0x11]);
    const NORMAL = Buffer.from([0x1D, 0x21, 0x00]);
    const LARGE = Buffer.from([0x1D, 0x21, 0x01]);
    const CUT = Buffer.from([0x1D, 0x56, 0x42, 0x00]);
    const t = (s) => Buffer.from(s + '\n', 'utf8');

    parts.push(ESC_INIT);

    // Header
    parts.push(CENTER, DOUBLE, t(r.shopName || 'CHILL CAFE'), NORMAL);
    parts.push(t(r.address || ''));
    if (r.phone) parts.push(t('SDT: ' + r.phone));
    parts.push(t('--------------------------------'));

    // Title
    parts.push(BOLD_ON, LARGE, t('HOA DON THANH TOAN'), NORMAL, BOLD_OFF);
    parts.push(t('--------------------------------'));

    // Info
    parts.push(LEFT);
    if (r.invoiceNumber) parts.push(t('Ma HD: ' + r.invoiceNumber));
    if (r.date) parts.push(t('TG: ' + r.date));
    if (r.tableName) parts.push(t('Ban: ' + r.tableName));
    if (r.staffName) parts.push(t('NV: ' + r.staffName));
    parts.push(t('--------------------------------'));

    // Items
    if (r.items && r.items.length) {
        for (const item of r.items) {
            parts.push(t(item.name));
            parts.push(t('  x' + item.qty + '          ' + item.total));
            if (item.note) parts.push(t('  (' + item.note + ')'));
        }
    }
    parts.push(t('--------------------------------'));

    // Totals
    if (r.discountAmount && r.discountAmount !== '0') {
        parts.push(t('Tam tinh:    ' + r.subtotal));
        parts.push(t('Giam gia:   -' + r.discountAmount));
        parts.push(t('--------------------------------'));
    }

    parts.push(BOLD_ON, LARGE, t('TONG: ' + (r.total || '0d')), NORMAL, BOLD_OFF);
    parts.push(t('TT: ' + (r.paymentMethod || '')));

    if (r.paidAmount && r.paidAmount !== '0') {
        parts.push(t('Khach dua:   ' + r.paidAmount));
        if (r.changeAmount && r.changeAmount !== '0')
            parts.push(t('Tien thua:   ' + r.changeAmount));
    }

    parts.push(t('--------------------------------'));
    parts.push(CENTER, t('Cam on quy khach!'), t('Hen gap lai!'));
    parts.push(Buffer.from('\n\n\n\n'));
    parts.push(CUT);

    return Buffer.concat(parts);
}

// Save printer settings
app.post('/api/settings/printer', requireRole('admin', 'manager'), (req, res) => {
    const { printer_ip, printer_port } = req.body;
    if (!printer_ip) return res.status(400).json({ error: 'Thiếu IP máy in' });
    try {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('printer_ip', ?)").run(printer_ip);
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('printer_port', ?)").run(String(printer_port || '9100'));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== APP UPDATE API =====
const APP_VERSION_FILE = path.join(__dirname, 'data', 'app_version.json');

// Initialize version file if not exists
if (!fs.existsSync(APP_VERSION_FILE)) {
    fs.writeFileSync(APP_VERSION_FILE, JSON.stringify({
        versionCode: 1,
        versionName: "1.0",
        changelog: "Phiên bản đầu tiên"
    }));
}

app.get('/api/app/version', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf8'));
        res.json(data);
    } catch (e) {
        res.json({ versionCode: 1, versionName: "1.0", changelog: "" });
    }
});

app.get('/api/app/download', (req, res) => {
    const apkPath = path.join(__dirname, 'ChillPOS.apk');
    if (!fs.existsSync(apkPath)) {
        return res.status(404).json({ error: 'APK không tồn tại' });
    }
    res.download(apkPath, 'ChillPOS.apk');
});

// Admin: update version info (after building new APK)
app.put('/api/app/version', requireRole('admin'), (req, res) => {
    const { versionCode, versionName, changelog } = req.body;
    if (!versionCode || !versionName) return res.status(400).json({ error: 'Thiếu thông tin version' });
    const data = { versionCode: parseInt(versionCode), versionName, changelog: changelog || '' };
    fs.writeFileSync(APP_VERSION_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true, ...data });
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Lỗi server nội bộ' });
});

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log(`Chill Cafe server running on port ${PORT}`);
    const adminCount = db.prepare('SELECT COUNT(*) as c FROM admin_users').get().c;
    if (adminCount === 0) {
        console.log('');
        console.log('  Chua co tai khoan admin!');
        console.log('   Chay lenh: npm run init-admin');
        console.log('');
    }
});

process.on('SIGINT', () => { try { ordersDb.close(); db.close(); } catch(e) {} process.exit(0); });
process.on('SIGTERM', () => { try { ordersDb.close(); db.close(); } catch(e) {} process.exit(0); });

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message, err.stack?.split('\n')[1]?.trim());
});
process.on('unhandledRejection', (reason) => {
    console.error('[REJECTION]', reason?.message || reason);
});
