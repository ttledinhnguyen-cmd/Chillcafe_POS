// ===== CHILL CAFE POS - Main Script =====
'use strict';

// Prevent pinch zoom on Android Chrome (ignores viewport user-scalable=no)
document.addEventListener('touchmove', function(e) {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

const App = {
    csrfToken: '',
    user: null,
    currentPage: 'dashboard',
    cart: [],
    selectedTable: null,
    discount: { type: '', value: 0 },
    menuItems: [],
    tables: [],
    currentCategory: 'all',
    tableOrders: {},  // { tableId: { cart: [...], discount: {...} } }
    hasOpenShift: false,
    permissions: null, // null = unknown (old backend → legacy fallback); array = explicit grants
    rolesCache: [],   // cached roles list for dropdowns / permission manager
};

// Legacy role permissions used only when the server doesn't send a permission
// list yet (e.g. backend not restarted) so the UI doesn't break in the meantime.
const LEGACY_ROLE_PERMS = {
    manager: ['dashboard.view','pos.use','table.view','table.manage','order.view','order.edit','order.delete','menu.view','menu.edit','menu.delete','shift.view','shift.manage','transaction.view','transaction.edit','transaction.delete','inventory.view','inventory.edit','inventory.delete','staff.view','staff.edit','staff.delete','payroll.view','payroll.edit','report.view'],
    cashier: ['dashboard.view','pos.use','table.view','order.view','menu.view','shift.view'],
    staff: ['dashboard.view','pos.use','table.view','order.view','menu.view'],
};

// Current user has a permission? (admin always yes)
function hasPerm(perm) {
    if (App.user?.role === 'admin') return true;
    if (Array.isArray(App.permissions)) return App.permissions.includes(perm);
    const legacy = LEGACY_ROLE_PERMS[App.user?.role] || LEGACY_ROLE_PERMS.staff;
    return legacy.includes(perm);
}

// ===== API CLIENT =====
const api = {
    async request(method, url, data) {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (App.csrfToken) opts.headers['X-CSRF-Token'] = App.csrfToken;
        if (data) opts.body = JSON.stringify(data);
        const res = await fetch(url, opts);
        const json = await res.json();
        if (!res.ok) {
            const err = new Error(json.error || 'Lỗi server');
            if (json.needLocation) err.needLocation = true;
            throw err;
        }
        return json;
    },
    get: (url) => api.request('GET', url),
    post: (url, data) => api.request('POST', url, data),
    put: (url, data) => api.request('PUT', url, data),
    del: (url) => api.request('DELETE', url),
};

// ===== SSE (Real-time sync) =====
let sseSource = null;
let sseRetryCount = 0;
let sseRetryTimer = null;
function connectSSE() {
    if (sseSource) sseSource.close();
    if (sseRetryTimer) clearTimeout(sseRetryTimer);
    sseSource = new EventSource('/api/sse');
    sseRetryCount = 0;
    sseSource.onmessage = async (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === 'table_order_update') {
                const tid = data.tableId;
                // Skip if this update came from me (same user)
                const isMyUpdate = data.by === App.user?.displayName;
                if (data.cart && data.cart.length > 0) {
                    App.tableOrders[tid] = { cart: data.cart, discount: data.discount || {}, startedAt: data.startedAt };
                } else {
                    delete App.tableOrders[tid];
                }
                // If viewing tables list, refresh it
                if ($('#pos-step-tables')?.style.display !== 'none') {
                    renderPOSTables();
                }
                // If currently on this table AND update is from another user, sync cart
                if (App.selectedTable && App.selectedTable.id === tid && !isMyUpdate) {
                    const saved = App.tableOrders[tid];
                    if (saved) {
                        App.cart = saved.cart;
                        App.discount = saved.discount;
                    } else {
                        App.cart = [];
                        App.discount = { type: '', value: 0 };
                    }
                    renderCart();
                }
            } else if (data.type === 'order_paid' || data.type === 'order_created' || data.type === 'order_status') {
                // Refresh tables view when any order changes
                if ($('#pos-step-tables')?.style.display !== 'none') {
                    renderPOSTables();
                }
                // If on dashboard page, reload it
                if (document.querySelector('[data-page="dashboard"]')?.classList.contains('active')) {
                    loadDashboard?.();
                }
                // If on orders page, reload it
                if (document.querySelector('[data-page="orders"]')?.classList.contains('active')) {
                    loadOrders?.();
                }
                // Show notification for paid orders from other users
                if (data.type === 'order_paid' && data.by !== App.user?.displayName) {
                    toast(`${data.by} đã thanh toán ${data.invoiceNumber} - ${data.tableName || ''}`);
                }
                // Clear table order after payment
                if (data.type === 'order_paid' && data.tableId) {
                    delete App.tableOrders[data.tableId];
                    clearPendingOrder(data.tableId);
                    if (App.selectedTable && App.selectedTable.id === data.tableId) {
                        App.cart = [];
                        App.discount = { type: '', value: 0 };
                        renderCart();
                    }
                }
            } else if (data.type === 'menu_update') {
                // Reload menu when admin changes it
                try {
                    const menu = await api.get('/api/menu');
                    App.menuItems = menu.filter(m => m.status === 'available');
                    if ($('#pos-step-menu')?.style.display !== 'none') {
                        renderPOSMenu();
                    }
                } catch(e) {}
            }
        } catch (err) { /* ignore parse errors */ }
    };
    sseSource.onerror = () => {
        sseSource.close();
        sseRetryCount++;
        // Exponential backoff: 5s, 10s, 20s, 30s max
        const delay = Math.min(5000 * Math.pow(2, sseRetryCount - 1), 30000);
        if (sseRetryCount <= 10) {
            sseRetryTimer = setTimeout(connectSSE, delay);
        }
    };
}

// ===== OFFLINE-SAFE TABLE ORDER SYNC =====
// On weak/lost network a table-order write (PUT/DELETE) can fail. We queue the
// intended state in localStorage so it survives a page reload and keep retrying
// until the server accepts it — otherwise orders entered offline vanish on reload.
const PENDING_ORDERS_KEY = 'pos_pending_table_orders';

function loadPendingOrders() {
    try { return JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY)) || {}; }
    catch (e) { return {}; }
}
function savePendingOrders(p) {
    try { localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(p)); } catch (e) {}
}
function setPendingOrder(tableId, intent) {
    const p = loadPendingOrders();
    p[tableId] = intent; // intent: order object (upsert) or null (delete)
    savePendingOrders(p);
}
function clearPendingOrder(tableId) {
    const p = loadPendingOrders();
    if (tableId in p) { delete p[tableId]; savePendingOrders(p); }
}

async function pushTableOrder(tableId, intent) {
    if (intent && intent.cart && intent.cart.length > 0) {
        await api.put('/api/table-orders/' + tableId, intent);
    } else {
        await api.del('/api/table-orders/' + tableId);
    }
}

async function loadTableOrdersFromServer() {
    try {
        App.tableOrders = await api.get('/api/table-orders');
    } catch (e) {
        console.warn('Failed to load table orders:', e);
        if (!App.tableOrders) App.tableOrders = {};
    }
    // Overlay unsynced local changes so they survive reloads on weak network
    const pending = loadPendingOrders();
    for (const tid of Object.keys(pending)) {
        const intent = pending[tid];
        if (intent && intent.cart && intent.cart.length > 0) App.tableOrders[tid] = intent;
        else delete App.tableOrders[tid];
    }
    retryPendingOrders();
}

async function syncTableOrderToServer(tableId) {
    const order = App.tableOrders[tableId];
    const intent = (order && order.cart && order.cart.length > 0) ? order : null;
    // Persist the intent first so it is not lost if the request fails or the page reloads
    setPendingOrder(tableId, intent);
    try {
        await pushTableOrder(tableId, intent);
        clearPendingOrder(tableId); // confirmed by server
    } catch (e) {
        console.warn('Sync table order failed (queued for retry):', e);
    }
}

let retryingPendingOrders = false;
async function retryPendingOrders() {
    if (retryingPendingOrders) return;
    const pending = loadPendingOrders();
    const ids = Object.keys(pending);
    if (!ids.length) return;
    retryingPendingOrders = true;
    try {
        for (const tid of ids) {
            try {
                await pushTableOrder(tid, pending[tid]);
                clearPendingOrder(tid);
            } catch (e) { /* keep queued, retry later */ }
        }
    } finally { retryingPendingOrders = false; }
}
setInterval(retryPendingOrders, 15000);
window.addEventListener('online', retryPendingOrders);

// ===== UTILS =====
function fmt(n) {
    return Number(n || 0).toLocaleString('vi-VN') + 'd';
}
function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    return dt.toLocaleDateString('vi-VN') + ' ' + dt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}
function fmtShortDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('vi-VN');
}
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function show(el) { if (typeof el === 'string') el = $(el); if (el) el.style.display = ''; }
function hide(el) { if (typeof el === 'string') el = $(el); if (el) el.style.display = 'none'; }

function toast(msg, type = 'success') {
    const container = $('#toast-container');
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function statusBadge(status) {
    const map = {
        pending: ['Đang chờ', 'warning'],
        paid: ['Đã thanh toán', 'success'],
        done: ['Hoàn thành', 'success'],
        cancelled: ['Đã hủy', 'danger'],
        available: ['Trống', 'success'],
        occupied: ['Có khách', 'warning'],
        reserved: ['Đặt trước', 'info'],
        open: ['Đang mở', 'success'],
        closed: ['Đã đóng', 'default'],
        active: ['Hoạt động', 'success'],
        inactive: ['Nghỉ việc', 'default'],
    };
    const [label, cls] = map[status] || [status, 'default'];
    return `<span class="badge badge-${cls}">${label}</span>`;
}

// Menu items use their own wording (avoid the table "Trống" label)
function menuStatusBadge(status) {
    const map = {
        available: ['Còn hàng', 'success'],
        soldout: ['Hết hàng', 'danger'],
    };
    const [label, cls] = map[status] || [status, 'default'];
    return `<span class="badge badge-${cls}">${label}</span>`;
}

function paymentLabel(method) {
    const map = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ', qr: 'QR' };
    return map[method] || method || '';
}

const DEFAULT_CATEGORY_LABELS = {
    all: 'Tất cả', coffee: 'Cà phê', tea: 'Trà', smoothie: 'Sinh tố & Đá xay',
    juice: 'Nước ép', soda: 'Soda', yogurt: 'Yogurt', other: 'Khác'
};
let categoryLabels = { ...DEFAULT_CATEGORY_LABELS };

async function loadCategoryLabels() {
    try {
        const s = await api.get('/api/settings');
        let custom = {};
        try { if (s.category_names) custom = JSON.parse(s.category_names); } catch (e) { custom = {}; }
        categoryLabels = { ...DEFAULT_CATEGORY_LABELS, ...custom };
    } catch (e) { /* keep defaults */ }
}
const roleLabels = { barista: 'Pha chế', cashier: 'Thu ngân', waiter: 'Phục vụ', kitchen: 'Bếp', manager: 'Quản lý' };
const shiftLabels = { morning: 'Sáng', afternoon: 'Chiều', full: 'Cả ngày' };
const payTypeLabels = { hour: 'Theo giờ', shift: 'Theo buổi', month: 'Theo tháng' };
const payTypeUnit = { hour: 'giờ', shift: 'buổi', month: 'tháng' };
const userRoleLabels = { admin: 'Quản trị viên', manager: 'Quản lý', cashier: 'Thu ngân', staff: 'Nhân viên' };
const userRoleColors = { admin: 'danger', manager: 'warning', cashier: 'success', staff: 'default' };

// ===== SCREEN ADAPTER =====
function adaptToScreen() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const root = document.documentElement;
    root.style.setProperty('--screen-w', w + 'px');
    root.style.setProperty('--screen-h', h + 'px');
    let device = 'desktop';
    if (w <= 430) device = 'phone';
    else if (w <= 768) device = 'tablet';
    document.body.dataset.device = device;
    if (device === 'phone') {
        const scale = Math.min(1, w / 390);
        root.style.setProperty('--mobile-scale', scale);
        root.style.fontSize = Math.max(13, 16 * scale) + 'px';
        root.style.setProperty('--menu-cols', w <= 320 ? '1' : '2');
    } else {
        root.style.fontSize = '';
        root.style.setProperty('--mobile-scale', '1');
    }
}
adaptToScreen();
window.addEventListener('resize', adaptToScreen);
window.addEventListener('orientationchange', () => setTimeout(adaptToScreen, 100));

// ===== CLOCK =====
function updateClock() {
    const el = $('#current-time');
    if (el) {
        const now = new Date();
        el.textContent = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
}
setInterval(updateClock, 1000);

// ===== AUTH =====
async function checkAuth() {
    // Always show login page - require manual login every time
    showLogin();
    return false;
}

function showLogin() {
    show('#login-screen');
    hide('#app');
}

async function showApp() {
    hide('#login-screen');
    show('#app');
    $('#display-name').textContent = App.user?.displayName || 'Admin';
    updateClock();
    applyRolePermissions();
    connectSSE();
    await loadTableOrdersFromServer();
    navigate('pos');
}

// Map each sidebar page to the permission required to see it.
// '__admin__' = admin only; null/undefined = always visible when logged in.
const NAV_PERM = {
    dashboard: 'dashboard.view',
    pos: 'pos.use',
    tables: 'table.manage',
    orders: 'order.view',
    menu: 'menu.view',
    shifts: 'shift.view',
    transactions: 'transaction.view',
    inventory: 'inventory.view',
    staff: 'staff.view',
    payroll: 'payroll.view',
    reports: 'report.view',
    users: '__admin__',
    settings: '__admin__',
};

function applyRolePermissions() {
    const role = App.user?.role || 'staff';
    const isAdmin = role === 'admin';
    // Sidebar items gated by permission (works for custom roles too)
    $$('.sidebar-menu li[data-page]').forEach(li => {
        const page = li.dataset.page;
        const need = NAV_PERM[page];
        let show;
        if (need === undefined) show = true;
        else if (need === '__admin__') show = isAdmin;
        else show = hasPerm(need);
        li.style.display = show ? '' : 'none';
    });
    // Action elements gated by [data-perm] (supports legacy admin/manager and permission keys)
    document.querySelectorAll('[data-perm]').forEach(el => {
        const perm = el.dataset.perm;
        let show;
        if (perm === 'admin') show = isAdmin;
        else if (perm === 'manager') show = ['admin', 'manager'].includes(role);
        else show = hasPerm(perm);
        el.style.display = show ? '' : 'none';
    });
    // Land on the first page the user is allowed to use
    const prefer = hasPerm('pos.use') ? 'pos' : (hasPerm('dashboard.view') ? 'dashboard' : null);
    if (prefer === 'pos') {
        const menu = document.querySelector('.sidebar-menu');
        const posItem = menu.querySelector('[data-page="pos"]');
        if (posItem && role !== 'admin' && role !== 'manager') menu.insertBefore(posItem, menu.firstElementChild);
        navigate('pos');
    } else if (prefer === 'dashboard') {
        navigate('dashboard');
    }
}

// Load saved credentials (fill only, user must press login)
(function() {
    const saved = localStorage.getItem('chill_login');
    if (saved) {
        try {
            const { u, p } = JSON.parse(saved);
            if (u) $('#login-username').value = u;
            if (p) $('#login-password').value = p;
        } catch(e) {}
    }
})();

$('#toggle-password')?.addEventListener('click', () => {
    const pw = $('#login-password');
    if (pw.type === 'password') { pw.type = 'text'; $('#toggle-password').innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'; }
    else { pw.type = 'password'; $('#toggle-password').innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'; }
});

$('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const errEl = $('#login-error');
    errEl.textContent = '';

    async function doLogin(lat, lng) {
        const body = { username, password };
        if (lat !== undefined) { body.latitude = lat; body.longitude = lng; }
        const data = await api.post('/api/auth/login', body);
        App.csrfToken = data.csrfToken;
        App.user = { username: data.username, displayName: data.displayName, role: data.role };
        App.permissions = data.permissions || null;
        if ($('#login-remember')?.checked) {
            localStorage.setItem('chill_login', JSON.stringify({ u: username, p: password }));
        } else {
            localStorage.removeItem('chill_login');
        }
        showApp();
    }

    // Try to get GPS first, then login
    try {
        let lat, lng;
        try {
            if (navigator.geolocation) {
                const pos = await new Promise((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, enableHighAccuracy: true });
                });
                lat = pos.coords.latitude;
                lng = pos.coords.longitude;
            }
        } catch(e) { /* GPS not available - ignore all errors */ }
        await doLogin(lat, lng);
    } catch (err) {
        if (err.needLocation) {
            errEl.textContent = 'Vui lòng bật GPS và cho phép truy cập vị trí để đăng nhập.';
        } else {
            errEl.textContent = err.message || 'Lỗi đăng nhập';
        }
    }
});

$('#logout-btn').addEventListener('click', async () => {
    try { await api.post('/api/auth/logout'); } catch (e) { /* ignore */ }
    if (sseSource) { sseSource.close(); sseSource = null; }
    App.user = null;
    App.csrfToken = '';
    App.tableOrders = {};
    showLogin();
});

// ===== NAVIGATION =====
function navigate(page) {
    // Staff chỉ được truy cập: dashboard, pos, orders
    const staffPages = ['dashboard', 'pos', 'orders'];
    if (App.user?.role === 'staff' && !staffPages.includes(page)) {
        toast('Bạn không có quyền truy cập trang này', 'error');
        return;
    }
    App.currentPage = page;
    $$('.sidebar-menu li').forEach(li => li.classList.toggle('active', li.dataset.page === page));
    $$('.page').forEach(p => { p.classList.toggle('active', p.id === `page-${page}`); });

    const titles = {
        dashboard: 'Tổng quan', pos: 'Bán hàng (POS)', tables: 'Quản lý bàn',
        orders: 'Đơn hàng', menu: 'Thực đơn', shifts: 'Ca làm việc',
        transactions: 'Thu chi', inventory: 'Kho hàng', staff: 'Nhân viên',
        payroll: 'Bảng tính lương',
        reports: 'Báo cáo', users: 'Quản lý tài khoản', settings: 'Cài đặt'
    };
    $('#page-title').textContent = titles[page] || page;

    // Close sidebar on mobile
    $('#sidebar').classList.remove('open');
    // Hide mobile cart bar when leaving POS
    if (page !== 'pos') { const mcb = $('#mobile-cart-bar'); if (mcb) mcb.style.display = 'none'; }

    // Load page data
    const loaders = {
        dashboard: loadDashboard, pos: loadPOS, tables: loadTables,
        orders: loadOrders, menu: loadMenu, shifts: loadShifts,
        transactions: loadTransactions, inventory: loadInventory,
        staff: loadStaff, payroll: loadPayroll, reports: loadReports, users: loadUsers,
        settings: loadSettings
    };
    if (loaders[page]) loaders[page]();
}

$$('.sidebar-menu li').forEach(li => {
    li.addEventListener('click', () => navigate(li.dataset.page));
});

$('#menu-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#sidebar').classList.toggle('open');
});

document.addEventListener('click', (e) => {
    const sidebar = $('#sidebar');
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== $('#menu-toggle')) {
        sidebar.classList.remove('open');
    }
});

// ===== MODAL HELPERS =====
function openModal(id) { show(`#${id}`); }
function closeModal(id) { hide(`#${id}`); }

$$('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Close modals on overlay click
$$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay.id);
    });
});

// ===== DASHBOARD =====
async function loadDashboard() {
    try {
        const data = await api.get('/api/dashboard');

        $('#dash-revenue').textContent = fmt(data.revenue);
        $('#dash-orders').textContent = data.ordersCount;
        $('#dash-items').textContent = data.itemsSold;
        $('#dash-avg').textContent = fmt(data.avg);

        // Shift badge
        if (data.currentShift) {
            App.hasOpenShift = true;
            show('#shift-badge');
            $('#shift-badge').textContent = `Ca: ${data.currentShift.staff_name}`;
        } else {
            App.hasOpenShift = false;
            hide('#shift-badge');
        }

        // Revenue chart
        renderBarChart('#revenue-chart', data.revenueByDay || [], 'date', 'revenue');

        // Top items
        const topEl = $('#top-items');
        topEl.innerHTML = (data.topItems || []).map((item, i) =>
            `<div class="top-item"><span class="rank">${i + 1}</span><span class="name">${item.name}</span><span class="count">${item.count}</span></div>`
        ).join('') || '<p style="color:var(--text-muted);font-size:13px">Chưa có dữ liệu</p>';

        // Recent orders
        const tbody = $('#dash-recent-orders tbody');
        tbody.innerHTML = (data.recentOrders || []).map(o =>
            `<tr><td>${o.invoice_number || o.id}</td><td>${o.table_name || '-'}</td><td>${fmt(o.total)}</td><td>${statusBadge(o.status)}</td><td>${fmtDate(o.created_at)}</td></tr>`
        ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Chưa có đơn hàng</td></tr>';

    } catch (err) {
        toast(err.message, 'error');
    }
}

function renderBarChart(selector, data, labelKey, valueKey) {
    const el = $(selector);
    if (!el || !data.length) { if (el) el.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center;padding-top:60px">Chưa có dữ liệu</p>'; return; }
    const maxVal = Math.max(...data.map(d => d[valueKey]), 1);
    el.innerHTML = data.map(d => {
        const pct = Math.max((d[valueKey] / maxVal) * 100, 3);
        const label = labelKey === 'date' ? d[labelKey].slice(5) : d[labelKey];
        return `<div class="bar-col"><span class="bar-value">${fmt(d[valueKey])}</span><div class="bar-fill" style="height:${pct}%"></div><span class="bar-label">${label}</span></div>`;
    }).join('');
}

// ===== POS =====
async function loadPOS() {
    try {
        const [tables, menu, settings, shiftData] = await Promise.all([
            api.get('/api/tables'), api.get('/api/menu'), api.get('/api/settings'),
            api.get('/api/shifts/current')
        ]);
        App.tables = tables;
        App.menuItems = menu.filter(m => m.status === 'available');
        App.bankSettings = settings;
        try {
            const custom = settings.category_names ? JSON.parse(settings.category_names) : {};
            categoryLabels = { ...DEFAULT_CATEGORY_LABELS, ...custom };
        } catch (e) { /* keep current */ }
        App.hasOpenShift = !!shiftData?.shift;
        renderPOSTables();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function renderPOSTables(fullRebuild) {
    show('#pos-step-tables');
    hide('#pos-step-menu');
    const mcb = $('#mobile-cart-bar'); if (mcb) mcb.style.display = 'none';
    const grid = $('#pos-tables');

    // Full rebuild only when needed (first load, table list changes)
    if (fullRebuild || !grid.children.length || grid.children.length !== App.tables.length) {
        grid.innerHTML = App.tables.map(t => `<div class="table-card" data-id="${t.id}"><div class="table-name">${t.name}</div><div class="table-info"></div></div>`).join('');
        // Event delegation - attach once
        grid.onclick = (e) => {
            const card = e.target.closest('.table-card');
            if (card) selectTable(parseInt(card.dataset.id));
        };
    }

    // Update each table's info without rebuilding DOM
    App.tables.forEach(t => {
        const card = grid.querySelector(`[data-id="${t.id}"]`);
        if (!card) return;
        const pending = App.tableOrders[t.id];
        const pendingTotal = pending ? pending.cart.reduce((s, c) => s + c.price * c.qty, 0) : 0;
        let elapsed = '';
        if (pending?.startedAt) {
            const mins = Math.floor((Date.now() - pending.startedAt) / 60000);
            if (mins < 1) elapsed = '<1 phút';
            else if (mins < 60) elapsed = mins + ' phút';
            else {
                const hrs = Math.floor(mins / 60);
                const rem = mins % 60;
                elapsed = rem > 0 ? hrs + 'g' + rem + 'p' : hrs + ' giờ';
            }
        }
        // Update class
        card.className = 'table-card ' + (t.status || '') + (pendingTotal ? ' has-pending' : '');
        // Update info
        const info = card.querySelector('.table-info');
        if (info) {
            info.innerHTML = pendingTotal
                ? `<div class="table-pending">${fmt(pendingTotal)}</div>${elapsed ? `<div class="table-time">${elapsed}</div>` : ''}`
                : `<div class="table-status">${statusBadge(t.status)}</div>`;
        }
    });
}

function selectTable(id) {
    if (!App.hasOpenShift) {
        toast('Vui lòng mở ca trước khi bán hàng', 'error');
        navigate('shifts');
        return;
    }
    const table = App.tables.find(t => t.id === id);
    if (!table) return;

    // Lưu tạm đơn hàng bàn hiện tại (nếu có)
    saveCurrentTableOrder();

    App.selectedTable = table;

    // Khôi phục đơn hàng đã lưu tạm của bàn mới (nếu có)
    const saved = App.tableOrders[id];
    if (saved) {
        App.cart = saved.cart;
        App.discount = saved.discount;
    } else {
        App.cart = [];
        App.discount = { type: '', value: 0 };
    }

    hide('#pos-step-tables');
    const menuStep = $('#pos-step-menu');
    menuStep.style.display = 'flex';

    $('#pos-selected-table').textContent = table.name;
    App.currentCategory = 'all';
    const posSearch = $('#pos-search');
    if (posSearch) posSearch.value = '';
    renderPOSCategories();
    renderPOSMenu();
    renderCart();

    // Nếu bàn đã có món → tự cuộn xuống giỏ hàng (mobile)
    if (App.cart.length > 0 && window.innerWidth <= 768) {
        setTimeout(() => {
            const cartArea = document.querySelector('.pos-cart-area');
            if (cartArea) cartArea.scrollIntoView({ behavior: 'smooth' });
        }, 300);
    }
}

function saveCurrentTableOrder() {
    if (!App.selectedTable) return;
    const tid = App.selectedTable.id;
    if (App.cart.length > 0) {
        const existing = App.tableOrders[tid];
        App.tableOrders[tid] = {
            cart: [...App.cart],
            discount: { ...App.discount },
            startedAt: existing?.startedAt || Date.now()
        };
    } else {
        delete App.tableOrders[tid];
    }
    syncTableOrderToServer(tid);
}
window.selectTable = selectTable;

$('#pos-back-tables').addEventListener('click', () => {
    saveCurrentTableOrder();
    renderPOSTables();
});

function renderPOSCategories() {
    const cats = ['all', ...new Set(App.menuItems.map(m => m.category))];
    const el = $('#pos-categories');
    el.innerHTML = cats.map(c =>
        `<span class="cat-tab ${c === App.currentCategory ? 'active' : ''}" data-cat="${c}">${categoryLabels[c] || c}</span>`
    ).join('');
    el.querySelectorAll('.cat-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            App.currentCategory = tab.dataset.cat;
            el.querySelectorAll('.cat-tab').forEach(t => t.classList.toggle('active', t === tab));
            renderPOSMenu();
        });
    });
}

function removeDiacritics(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function renderPOSMenu() {
    const rawSearch = ($('#pos-search')?.value || '').trim().toLowerCase();
    const search = removeDiacritics(rawSearch);
    const items = App.menuItems.filter(m => {
        if (App.currentCategory !== 'all' && m.category !== App.currentCategory) return false;
        if (search) {
            const name = removeDiacritics(m.name.toLowerCase());
            if (!name.includes(search) && !m.name.toLowerCase().includes(rawSearch)) return false;
        }
        return true;
    });
    const el = $('#pos-menu-items');
    const showImages = !document.getElementById('toggle-images')?.checked;
    el.innerHTML = items.map(m =>
        `<div class="menu-item ${m.status === 'soldout' ? 'soldout' : ''} ${showImages && m.image_url ? 'has-image' : ''}" onclick="addToCart('${m.id}')">
            ${showImages && m.image_url ? `<div class="item-img"><img src="${m.image_url}" alt="${m.name}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
            <div class="item-info">
                <div class="item-name">${m.name}</div>
                <div class="item-price">${fmt(m.price)}</div>
            </div>
            ${showImages && m.image_url ? `<button class="item-add-btn" onclick="event.stopPropagation();addToCart('${m.id}')">+</button>` : ''}
        </div>`
    ).join('') || '<p style="text-align:center;color:var(--text-muted);padding:20px">Không tìm thấy món</p>';
}

$('#pos-search')?.addEventListener('input', renderPOSMenu);

function addToCart(menuId) {
    if (!App.hasOpenShift) { toast('Vui lòng mở ca trước', 'error'); return; }
    const item = App.menuItems.find(m => m.id === menuId);
    if (!item) return;
    const existing = App.cart.find(c => c.id === menuId);
    if (existing) {
        existing.qty++;
    } else {
        App.cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, note: '' });
    }
    renderCart();
    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(30);
}
window.addToCart = addToCart;

function removeFromCart(idx) {
    App.cart.splice(idx, 1);
    renderCart();
}
window.removeFromCart = removeFromCart;

function updateCartQty(idx, delta) {
    App.cart[idx].qty += delta;
    if (App.cart[idx].qty <= 0) App.cart.splice(idx, 1);
    renderCart();
}
window.updateCartQty = updateCartQty;

function setCartNote(idx) {
    const note = prompt('Ghi chú cho món:', App.cart[idx].note || '');
    if (note !== null) App.cart[idx].note = note;
    renderCart();
}
window.setCartNote = setCartNote;

function renderCart() {
    const el = $('#pos-cart-items');
    if (App.cart.length === 0) {
        el.innerHTML = '<div class="cart-empty">Chưa có món nào</div>';
    } else {
        el.innerHTML = App.cart.map((item, i) => `
            <div class="cart-item">
                <div class="item-info">
                    <div class="name">${item.name}</div>
                    <div class="price">${fmt(item.price)}</div>
                    ${item.note ? `<div class="item-note">${item.note}</div>` : ''}
                    <button class="item-note-btn" onclick="setCartNote(${i})">[Ghi chú]</button>
                </div>
                <div class="item-qty">
                    <button onclick="updateCartQty(${i},-1)">-</button>
                    <span>${item.qty}</span>
                    <button onclick="updateCartQty(${i},1)">+</button>
                </div>
                <div class="item-total">${fmt(item.price * item.qty)}</div>
            </div>
        `).join('');
    }

    const subtotal = App.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let discountAmount = 0;
    if (App.discount.type === 'percent') {
        discountAmount = Math.round(subtotal * App.discount.value / 100);
    } else if (App.discount.type === 'fixed') {
        discountAmount = Math.min(App.discount.value, subtotal);
    }
    const total = subtotal - discountAmount;

    $('#pos-subtotal').textContent = fmt(subtotal);
    if (discountAmount > 0) {
        show('#pos-discount-row');
        $('#pos-discount-display').textContent = `-${fmt(discountAmount)}`;
    } else {
        hide('#pos-discount-row');
    }
    $('#pos-total').textContent = fmt(total);
    $('#pos-pay-btn').disabled = App.cart.length === 0;

    // Mobile cart bar
    const mcb = $('#mobile-cart-bar');
    if (mcb) {
        const isMobile = window.innerWidth <= 768;
        const menuVisible = $('#pos-step-menu')?.style.display !== 'none';
        if (isMobile && menuVisible && App.cart.length > 0) {
            mcb.style.display = 'flex';
            const totalQty = App.cart.reduce((s, c) => s + c.qty, 0);
            $('#mcb-count').textContent = totalQty + ' món';
            $('#mcb-total').textContent = fmt(total);
        } else {
            mcb.style.display = 'none';
        }
    }

    // Auto-save table order to server (debounced)
    if (App.selectedTable) {
        const capturedTid = App.selectedTable.id;
        clearTimeout(App._syncTimer);
        App._syncTimer = setTimeout(() => {
            const tid = capturedTid;
            if (!tid) return;
            if (App.cart.length > 0) {
                const existing = App.tableOrders[tid];
                App.tableOrders[tid] = {
                    cart: [...App.cart],
                    discount: { ...App.discount },
                    startedAt: existing?.startedAt || Date.now()
                };
            } else {
                delete App.tableOrders[tid];
            }
            syncTableOrderToServer(tid);
        }, 500);
    }
}

$('#pos-add-more')?.addEventListener('click', () => {
    // Scroll up to menu area
    const menuArea = document.querySelector('.pos-menu-area');
    if (menuArea) menuArea.scrollIntoView({ behavior: 'smooth' });
    // On mobile, scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Desktop cart more menu
$('#cart-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#cart-more-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', () => { const m = $('#cart-more-menu'); if (m) m.style.display = 'none'; });
$('#cart-opt-discount')?.addEventListener('click', (e) => { e.stopPropagation(); $('#cart-more-menu').style.display = 'none'; openDiscountModal(); });
$('#cart-opt-move')?.addEventListener('click', (e) => { e.stopPropagation(); $('#cart-more-menu').style.display = 'none'; moveTable(); });
$('#cart-opt-merge')?.addEventListener('click', (e) => { e.stopPropagation(); $('#cart-more-menu').style.display = 'none'; mergeTables(); });
$('#cart-opt-split')?.addEventListener('click', (e) => { e.stopPropagation(); $('#cart-more-menu').style.display = 'none'; splitOrder(); });
$('#cart-opt-clear')?.addEventListener('click', (e) => {
    e.stopPropagation(); $('#cart-more-menu').style.display = 'none';
    if (App.cart.length && confirm('Xóa hết món trong đơn?')) {
        App.cart = []; App.discount = { type: '', value: 0 };
        if (App.selectedTable) { delete App.tableOrders[App.selectedTable.id]; syncTableOrderToServer(App.selectedTable.id); }
        renderCart();
    }
});

// Discount
function openDiscountModal() {
    $('#disc-type').value = App.discount.type || 'percent';
    $('#disc-value').value = App.discount.value || '';
    openModal('modal-discount');
}

$('#disc-apply-btn').addEventListener('click', () => {
    let val = parseFloat($('#disc-value').value) || 0;
    const type = $('#disc-type').value;
    if (type === 'percent' && val > 100) val = 100;
    if (val > 0) {
        App.discount.type = type;
        App.discount.value = val;
    } else {
        App.discount = { type: '', value: 0 };
    }
    renderCart();
    closeModal('modal-discount');
});

// Payment
$('#pos-pay-btn').addEventListener('click', () => {
    if (!App.hasOpenShift) { toast('Vui lòng mở ca trước', 'error'); return; }
    if (App.cart.length === 0) return;
    const subtotal = App.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let discountAmount = 0;
    if (App.discount.type === 'percent') discountAmount = Math.round(subtotal * App.discount.value / 100);
    else if (App.discount.type === 'fixed') discountAmount = Math.min(App.discount.value, subtotal);
    const total = subtotal - discountAmount;

    $('#pay-summary').innerHTML = `
        <div>Bàn: <strong>${App.selectedTable?.name || ''}</strong></div>
        <div>Số món: ${App.cart.reduce((s, c) => s + c.qty, 0)}</div>
        ${discountAmount > 0 ? `<div>Giảm giá: -${fmt(discountAmount)}</div>` : ''}
        <div class="pay-total">${fmt(total)}</div>
    `;

    // Reset payment method
    $$('.pay-method').forEach(b => b.classList.toggle('active', b.dataset.method === 'cash'));
    $('#pay-amount').value = '';
    $('#pay-change').textContent = '0d';

    // Quick amounts
    const quickEl = $('#pay-quick');
    const rounded = [total, Math.ceil(total / 10000) * 10000, Math.ceil(total / 50000) * 50000, Math.ceil(total / 100000) * 100000];
    const unique = [...new Set(rounded)].filter(v => v >= total).slice(0, 4);
    quickEl.innerHTML = unique.map(v => `<button class="btn btn-sm" onclick="document.getElementById('pay-amount').value=${v};updateChange()">${fmt(v)}</button>`).join('');

    show('#pay-cash-group');
    hide('#pay-transfer-group');
    openModal('modal-payment');
});

// Mobile cart bar - tap area to scroll to cart, pay button to pay
$('#mobile-cart-bar').addEventListener('click', () => {
    const cartArea = document.querySelector('.pos-cart-area');
    if (cartArea) cartArea.scrollIntoView({ behavior: 'smooth' });
});
// More menu toggle
$('#mcb-more-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#mcb-more-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});
// Close more menu when clicking outside
document.addEventListener('click', () => {
    const menu = $('#mcb-more-menu');
    if (menu) menu.style.display = 'none';
});
// More menu options
$('#mcb-opt-discount')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#mcb-more-menu').style.display = 'none';
    openDiscountModal();
});
$('#mcb-opt-move')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#mcb-more-menu').style.display = 'none';
    moveTable();
});
$('#mcb-opt-merge')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#mcb-more-menu').style.display = 'none';
    mergeTables();
});
$('#mcb-opt-split')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#mcb-more-menu').style.display = 'none';
    splitOrder();
});
$('#mcb-pay-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#pos-pay-btn').click();
});

// ===== TABLE OPERATIONS =====
function moveTable() {
    if (!App.selectedTable || App.cart.length === 0) { toast('Chưa có đơn hàng', 'error'); return; }
    const currentId = App.selectedTable.id;
    const tables = App.tables.filter(t => t.id !== currentId);
    let html = '<div style="padding:12px"><p style="margin-bottom:12px">Chuyển đơn từ <b>' + App.selectedTable.name + '</b> sang:</p><div class="table-grid" style="gap:8px">';
    tables.forEach(t => {
        const hasPending = App.tableOrders[t.id];
        html += '<div class="table-card ' + (hasPending ? 'has-pending' : '') + '" onclick="confirmMoveTable(' + t.id + ',\'' + t.name.replace(/'/g,"\\'") + '\')" style="cursor:pointer;padding:10px;text-align:center"><b>' + t.name + '</b>' + (hasPending ? '<div style="color:red;font-size:11px">Đã có đơn</div>' : '') + '</div>';
    });
    html += '</div></div>';
    showTableOpModal('Chuyển bàn', html);
}

window.confirmMoveTable = async function(targetId, targetName) {
    // Cancel any pending debounced auto-save for the source table; otherwise it
    // fires after the DEL below and re-creates the source order (table A lingers).
    clearTimeout(App._syncTimer);
    App._syncTimer = null;
    if (App.selectedTable && App.cart.length > 0) {
        const tid = App.selectedTable.id;
        const existing = App.tableOrders[tid];
        App.tableOrders[tid] = {
            cart: [...App.cart],
            discount: { ...App.discount },
            startedAt: existing?.startedAt || Date.now()
        };
    }
    const currentId = App.selectedTable.id;
    const currentOrder = App.tableOrders[currentId];
    if (!currentOrder) { toast('Không có đơn hàng', 'error'); return; }

    if (App.tableOrders[targetId]) {
        if (!confirm('Bàn ' + targetName + ' đã có đơn. Gộp đơn vào?')) return;
        const target = App.tableOrders[targetId];
        currentOrder.cart.forEach(item => {
            const existing = target.cart.find(c => c.id === item.id);
            if (existing) existing.qty += item.qty;
            else target.cart.push({...item});
        });
    } else {
        App.tableOrders[targetId] = { ...currentOrder };
    }
    delete App.tableOrders[currentId];
    try {
        await syncTableOrderToServer(targetId);
        await syncTableOrderToServer(currentId);
    } catch (e) { console.warn('Move sync failed:', e); }
    closeTableOpModal();
    App.cart = [];
    App.selectedTable = null;
    renderPOSTables();
    toast('Đã chuyển đơn sang ' + targetName);
};

function mergeTables() {
    if (!App.selectedTable) { toast('Chưa chọn bàn', 'error'); return; }
    const currentId = App.selectedTable.id;
    const tablesWithOrders = App.tables.filter(t => t.id !== currentId && App.tableOrders[t.id]);
    if (tablesWithOrders.length === 0) { toast('Không có bàn nào khác có đơn', 'error'); return; }

    let html = '<div style="padding:12px"><p style="margin-bottom:12px">Gộp đơn từ bàn khác vào <b>' + App.selectedTable.name + '</b>:</p><div class="table-grid" style="gap:8px">';
    tablesWithOrders.forEach(t => {
        const order = App.tableOrders[t.id];
        const total = order.cart.reduce((s, c) => s + c.price * c.qty, 0);
        html += '<div class="table-card has-pending" onclick="confirmMergeTable(' + t.id + ',\'' + t.name.replace(/'/g,"\\'") + '\')" style="cursor:pointer;padding:10px;text-align:center"><b>' + t.name + '</b><div style="font-size:12px;color:var(--primary)">' + order.cart.length + ' món - ' + fmt(total) + '</div></div>';
    });
    html += '</div></div>';
    showTableOpModal('Gộp bàn', html);
}

window.confirmMergeTable = function(sourceId, sourceName) {
    if (!confirm('Gộp đơn từ ' + sourceName + ' vào ' + App.selectedTable.name + '?')) return;
    saveCurrentTableOrder();
    const currentId = App.selectedTable.id;
    const source = App.tableOrders[sourceId];
    if (!source) return;

    if (!App.tableOrders[currentId]) {
        App.tableOrders[currentId] = { cart: [], discount: {}, startedAt: Date.now() };
    }
    const target = App.tableOrders[currentId];
    source.cart.forEach(item => {
        const existing = target.cart.find(c => c.id === item.id);
        if (existing) existing.qty += item.qty;
        else target.cart.push({...item});
    });
    delete App.tableOrders[sourceId];
    App.cart = [...target.cart];
    App.discount = { ...target.discount };
    if (typeof syncTableOrderToServer === 'function') {
        syncTableOrderToServer(currentId, target);
        syncTableOrderToServer(sourceId, null);
    }
    closeTableOpModal();
    renderCart();
    renderPOSTables();
    toast('Đã gộp đơn từ ' + sourceName);
};

function splitOrder() {
    if (!App.selectedTable || App.cart.length === 0) { toast('Chưa có đơn hàng', 'error'); return; }
    let html = '<div style="padding:12px"><p style="margin-bottom:12px">Chọn món để tách ra:</p>';
    App.cart.forEach((item, i) => {
        html += '<label style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)"><input type="checkbox" class="split-item" data-index="' + i + '" value="' + i + '"><span style="flex:1">' + item.name + ' x' + item.qty + '</span><span style="color:var(--primary);font-weight:600">' + fmt(item.price * item.qty) + '</span></label>';
    });
    html += '<p style="margin-top:12px;font-size:13px;color:var(--text-muted)">Chọn bàn để chuyển món đã chọn sang:</p>';
    html += '<div class="table-grid" style="gap:8px;margin-top:8px">';
    App.tables.filter(t => t.id !== App.selectedTable.id).forEach(t => {
        html += '<div class="table-card" onclick="confirmSplitOrder(' + t.id + ',\'' + t.name.replace(/'/g,"\\'") + '\')" style="cursor:pointer;padding:8px;text-align:center;font-size:13px"><b>' + t.name + '</b></div>';
    });
    html += '</div></div>';
    showTableOpModal('Tách/Ghép đơn', html);
}

window.confirmSplitOrder = function(targetId, targetName) {
    const checks = document.querySelectorAll('.split-item:checked');
    if (checks.length === 0) { toast('Chọn ít nhất 1 món để tách', 'error'); return; }
    const indices = Array.from(checks).map(c => parseInt(c.dataset.index));

    if (!App.tableOrders[targetId]) {
        App.tableOrders[targetId] = { cart: [], discount: {}, startedAt: Date.now() };
    }
    const target = App.tableOrders[targetId];
    indices.sort((a, b) => b - a).forEach(i => {
        const item = App.cart[i];
        const existing = target.cart.find(c => c.id === item.id);
        if (existing) existing.qty += item.qty;
        else target.cart.push({...item});
        App.cart.splice(i, 1);
    });
    saveCurrentTableOrder();
    if (typeof syncTableOrderToServer === 'function') {
        syncTableOrderToServer(App.selectedTable.id, App.tableOrders[App.selectedTable.id] || null);
        syncTableOrderToServer(targetId, target);
    }
    closeTableOpModal();
    renderCart();
    renderPOSTables();
    toast('Đã tách ' + indices.length + ' món sang ' + targetName);
};

function showTableOpModal(title, bodyHtml) {
    const modal = $('#modal-payment');
    if (modal) {
        modal.querySelector('.modal-header h3').textContent = title;
        modal.querySelector('.modal-body').innerHTML = bodyHtml;
        modal.querySelector('.modal-footer').style.display = 'none';
        modal.style.display = 'flex';
    }
}
function closeTableOpModal() {
    const modal = $('#modal-payment');
    if (modal) {
        modal.style.display = 'none';
        modal.querySelector('.modal-footer').style.display = '';
    }
}

$$('.pay-method').forEach(btn => {
    btn.addEventListener('click', () => {
        $$('.pay-method').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const method = btn.dataset.method;
        if (method === 'cash') {
            show('#pay-cash-group');
            hide('#pay-transfer-group');
        } else {
            hide('#pay-cash-group');
            showPaymentInfo(method);
        }
    });
});

function showPaymentInfo(method) {
    const s = App.bankSettings || {};
    const details = $('#pay-bank-details');
    const qrImg = $('#pay-qr-image');

    if (method === 'card') {
        details.innerHTML = '<div class="bank-detail"><span class="bank-label">Thanh toán bằng thẻ</span><br>Quẹt thẻ tại máy POS</div>';
        qrImg.innerHTML = '';
    } else {
        // transfer or qr
        let html = '';
        if (s.bank_name) html += `<div class="bank-detail"><span class="bank-label">Ngân hàng</span><br><strong>${s.bank_name}</strong></div>`;
        if (s.bank_account) html += `<div class="bank-detail"><span class="bank-label">Số tài khoản</span><br><strong>${s.bank_account}</strong></div>`;
        if (s.bank_owner) html += `<div class="bank-detail"><span class="bank-label">Chủ tài khoản</span><br><strong>${s.bank_owner}</strong></div>`;
        if (!html) html = '<div class="bank-detail" style="color:var(--danger)">Chưa cài đặt thông tin ngân hàng.<br>Vào Cài đặt để thêm.</div>';
        details.innerHTML = html;

        if (s.payment_qr_url) {
            qrImg.innerHTML = `<img src="${s.payment_qr_url}" alt="QR thanh toán">`;
        } else {
            qrImg.innerHTML = method === 'qr' ? '<div style="color:var(--text-muted);font-size:13px;margin-top:8px">Chưa có ảnh QR. Vào Cài đặt để thêm.</div>' : '';
        }
    }
    show('#pay-transfer-group');
}

$('#pay-amount').addEventListener('input', updateChange);

function updateChange() {
    const subtotal = App.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let discountAmount = 0;
    if (App.discount.type === 'percent') discountAmount = Math.round(subtotal * App.discount.value / 100);
    else if (App.discount.type === 'fixed') discountAmount = Math.min(App.discount.value, subtotal);
    const total = subtotal - discountAmount;
    const paid = parseInt($('#pay-amount').value) || 0;
    const change = Math.max(0, paid - total);
    $('#pay-change').textContent = fmt(change);
}
window.updateChange = updateChange;

// Pre-print bill (before payment)
$('#pre-print-btn')?.addEventListener('click', async () => {
    const settings = App.bankSettings || {};
    const activeMethod = $('.pay-method.active')?.dataset.method || 'cash';
    const total = App.cart.reduce((s, c) => s + c.price * c.qty, 0);
    const discountAmount = App.discount?.type === 'percent'
        ? Math.round(total * (App.discount.value || 0) / 100)
        : (App.discount?.value || 0);
    const finalTotal = total - discountAmount;

    lastReceiptData = {
        shopName: settings.name || 'CHILL CAFE',
        address: settings.address || '',
        phone: settings.phone || '',
        invoiceNumber: '(Chưa TT)',
        date: new Date().toISOString(),
        tableName: App.selectedTable?.name || '',
        staffName: App.user?.displayName || '',
        items: App.cart.map(c => ({ name: c.name, qty: c.qty, price: c.price, note: c.note || '' })),
        subtotal: total,
        discountAmount,
        total: finalTotal,
        paymentMethod: activeMethod,
        paidAmount: 0,
        change: 0
    };
    await printReceipt();
});

$('#pay-confirm-btn').addEventListener('click', async () => {
    try {
        const activeMethod = $('.pay-method.active')?.dataset.method || 'cash';

        // 1. Create order
        const orderData = {
            items: App.cart.map(c => ({ id: c.id, qty: c.qty, note: c.note })),
            type: App.selectedTable?.name === 'MANG VE' ? 'takeaway' : 'dine-in',
            table_id: App.selectedTable?.id,
            note: '',
            discount_type: App.discount.type || undefined,
            discount_value: App.discount.value || undefined,
        };
        const orderRes = await api.post('/api/orders', orderData);

        // 2. Pay
        const payAmount = parseInt($('#pay-amount').value) || orderRes.total;
        const payRes = await api.post(`/api/orders/${orderRes.id}/pay`, {
            payment_method: activeMethod,
            payment_amount: payAmount
        });

        closeModal('modal-payment');
        toast(`Thanh toán thành công - ${payRes.invoice_number}`);

        // Show receipt
        showReceipt(payRes.receipt);

        // Reset cart + xóa đơn tạm của bàn
        App.cart = [];
        App.discount = { type: '', value: 0 };
        if (App.selectedTable) {
            delete App.tableOrders[App.selectedTable.id];
            syncTableOrderToServer(App.selectedTable.id);
        }
        renderCart();

        // Refresh tables
        loadPOS();

    } catch (err) {
        toast(err.message, 'error');
    }
});

function showReceipt(r) {
    if (!r) return;
    lastReceiptData = r; // Save for native printing
    const el = $('#receipt-content');
    el.innerHTML = `
        <div class="receipt-header">
            <h3>${r.shopName}</h3>
            <div>${r.address}</div>
            <div>SĐT: ${r.phone}</div>
        </div>
        <div class="receipt-divider"></div>
        <div style="text-align:center;font-weight:bold">HÓA ĐƠN THANH TOÁN</div>
        <div>Mã HĐ: ${r.invoiceNumber}</div>
        <div>Thời gian: ${fmtDate(r.date)}</div>
        ${r.tableName ? `<div>Bàn: ${r.tableName}</div>` : ''}
        <div class="receipt-divider"></div>
        <div class="receipt-items">
            ${(r.items || []).map(i => `<div class="receipt-item"><span>${i.name} x${i.qty}</span><span>${fmt(i.price * i.qty)}</span></div>`).join('')}
        </div>
        <div class="receipt-divider"></div>
        ${r.discountAmount > 0 ? `
            <div class="receipt-item"><span>Tạm tính:</span><span>${fmt(r.subtotal)}</span></div>
            <div class="receipt-item"><span>Giảm giá:</span><span>-${fmt(r.discountAmount)}</span></div>
        ` : ''}
        <div class="receipt-item receipt-total"><span>Tổng tiền:</span><span>${fmt(r.total)}</span></div>
        <div class="receipt-item"><span>Thanh toán:</span><span>${paymentLabel(r.paymentMethod)}</span></div>
        ${r.paymentMethod === 'cash' ? `
            <div class="receipt-item"><span>Khách đưa:</span><span>${fmt(r.paidAmount)}</span></div>
            <div class="receipt-item"><span>Tiền thừa:</span><span>${fmt(r.change)}</span></div>
        ` : ''}
        <div class="receipt-divider"></div>
        ${App.bankSettings?.payment_qr_url ? `
            <div class="receipt-qr">
                <div style="font-size:10px;margin-bottom:4px">Quét mã để thanh toán:</div>
                <img src="${App.bankSettings.payment_qr_url}" alt="QR thanh toán">
            </div>
            <div class="receipt-divider"></div>
        ` : ''}
        <div class="receipt-footer">Chill Cafe hân hạnh phục vụ!</div>
    `;
    openModal('modal-receipt');
}

// Store last receipt data for native printing
let lastReceiptData = null;

$('#print-receipt-btn').addEventListener('click', () => {
    closeModal('modal-receipt');
    printReceipt();
});

async function printReceipt() {
    // Method 1: Native Android App with SUNMI SDK
    if (window.NativePrinter && window.NativePrinter.isConnected()) {
        try { nativeSunmiPrint(); return; } catch(e) { console.warn('Native print failed:', e); }
    }
    // Method 2: Network print via server (Xprinter WiFi)
    if (App.bankSettings?.printer_ip || App.settings?.printer_ip) {
        try { await networkPrint(); return; } catch(e) { console.warn('Network print failed:', e); toast('In qua mạng thất bại, dùng in trình duyệt', 'error'); }
    }
    // Method 3: Fallback to browser print dialog
    window.print();
}

async function networkPrint() {
    const r = lastReceiptData;
    if (!r) { window.print(); return; }
    const payLabels = { cash: 'Tiền mặt', qr: 'QR Code', transfer: 'Chuyển khoản', card: 'Thẻ' };
    const res = await api.post('/api/printer/print', { receipt: {
        shopName: r.shopName,
        address: r.address,
        phone: r.phone,
        invoiceNumber: r.invoiceNumber,
        date: fmtDate(r.date),
        tableName: r.tableName,
        staffName: r.staffName,
        items: (r.items || []).map(i => ({ name: i.name, qty: i.qty, total: fmt(i.price * i.qty), note: i.note || '' })),
        subtotal: fmt(r.subtotal || r.total),
        discountAmount: r.discountAmount > 0 ? fmt(r.discountAmount) : '0',
        total: fmt(r.total),
        paymentMethod: payLabels[r.paymentMethod] || r.paymentMethod,
        paidAmount: r.paidAmount > 0 ? fmt(r.paidAmount) : '0',
        changeAmount: r.change > 0 ? fmt(r.change) : '0'
    }});
    if (res.success) toast('Đã in hóa đơn');
    else throw new Error(res.error);
}

function nativeSunmiPrint() {
    const r = lastReceiptData;
    if (!r) { window.print(); return; }

    // Format items as "name|qty|price;name|qty|price;..."
    const itemsStr = (r.items || []).map(i =>
        i.name + '|' + i.qty + '|' + fmt(i.price * i.qty)
    ).join(';');

    window.NativePrinter.printReceipt(
        r.shopName || '',
        r.address || '',
        r.phone || '',
        r.invoiceNumber || '',
        fmtDate(r.date) || '',
        r.tableName || '',
        itemsStr,
        fmt(r.subtotal || r.total),
        r.discountAmount > 0 ? fmt(r.discountAmount) : '0',
        fmt(r.total),
        paymentLabel(r.paymentMethod),
        r.paymentMethod === 'cash' ? fmt(r.paidAmount) : '',
        r.paymentMethod === 'cash' ? fmt(r.change) : ''
    );

    // Print QR if available
    if (App.bankSettings?.payment_qr_url) {
        window.NativePrinter.printQR(App.bankSettings.payment_qr_url, 6);
    }
}

// ===== TABLES PAGE =====
async function loadTables() {
    try {
        const tables = await api.get('/api/tables');
        const grid = $('#tables-grid');
        grid.innerHTML = tables.map(t =>
            `<div class="table-card ${t.status}">
                <div class="table-name">${t.name}</div>
                <div class="table-status">${statusBadge(t.status)}</div>
                <div style="margin-top:8px;display:flex;gap:4px;justify-content:center">
                    <button class="btn btn-sm" onclick="editTable(${t.id},'${t.name.replace(/'/g, "\\'")}','${t.area || ''}')">Sửa</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteTable(${t.id})">Xóa</button>
                </div>
            </div>`
        ).join('');
    } catch (err) { toast(err.message, 'error'); }
}

$('#add-table-btn').addEventListener('click', () => {
    showFormModal('Thêm bàn', [
        { key: 'name', label: 'Tên bàn', type: 'text', required: true },
        { key: 'area', label: 'Khu vực', type: 'select', options: [['indoor', 'Trong nhà'], ['outdoor', 'Sân'], ['service', 'Dịch vụ']] },
    ], async (data) => {
        await api.post('/api/tables', data);
        toast('Đã thêm bàn');
        loadTables();
    });
});

window.editTable = (id, name, area) => {
    showFormModal('Sửa bàn', [
        { key: 'name', label: 'Tên bàn', type: 'text', value: name, required: true },
        { key: 'area', label: 'Khu vực', type: 'select', value: area, options: [['indoor', 'Trong nhà'], ['outdoor', 'Sân'], ['service', 'Dịch vụ']] },
    ], async (data) => {
        await api.put(`/api/tables/${id}`, data);
        toast('Đã cập nhật bàn');
        loadTables();
    });
};

window.deleteTable = async (id) => {
    if (!confirm('Xóa bàn này?')) return;
    try { await api.del(`/api/tables/${id}`); toast('Đã xóa bàn'); loadTables(); }
    catch (err) { toast(err.message, 'error'); }
};

// ===== ORDERS PAGE =====
async function loadOrders() {
    try {
        const date = $('#orders-date').value;
        const status = $('#orders-status').value;
        let url = '/api/orders?limit=50';
        if (date) url += `&date=${date}`;
        if (status && status !== 'all') url += `&status=${status}`;

        const orders = await api.get(url);
        const tbody = $('#orders-table tbody');
        tbody.innerHTML = orders.map(o => {
            const itemNames = o.items.map(i => `${i.name} x${i.qty}`).join(', ');
            return `<tr>
                <td class="hide-mobile">${o.invoice_number || o.id}</td>
                <td>${o.table_name || '-'}</td>
                <td class="hide-mobile" title="${itemNames}">${itemNames.length > 30 ? itemNames.slice(0, 30) + '...' : itemNames}</td>
                <td>${fmt(o.total)}</td>
                <td class="hide-mobile">${paymentLabel(o.payment_method)}</td>
                <td>${statusBadge(o.status)}</td>
                <td>${fmtDate(o.created_at)}</td>
                <td class="actions">
                    <button class="btn btn-sm" onclick="viewOrder('${o.id}')">Xem</button>
                    ${o.status === 'pending' ? `<button class="btn btn-sm btn-success" onclick="payOrder('${o.id}')">TT</button>
                    ${['admin','manager'].includes(App.user?.role) ? `<button class="btn btn-sm btn-danger" onclick="cancelOrder('${o.id}')">Hủy</button>` : ''}` : ''}
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Không có đơn hàng</td></tr>';
    } catch (err) { toast(err.message, 'error'); }
}

$('#orders-date').addEventListener('change', loadOrders);
$('#orders-status').addEventListener('change', loadOrders);

window.viewOrder = async (id) => {
    try {
        const orders = await api.get(`/api/orders?limit=200`);
        const order = orders.find(o => o.id === id);
        if (!order) return toast('Không tìm thấy đơn', 'error');

        const body = $('#order-detail-body');
        body.innerHTML = `
            <p><strong>Mã:</strong> ${order.invoice_number || order.id}</p>
            <p><strong>Bàn:</strong> ${order.table_name || '-'}</p>
            <p><strong>Trạng thái:</strong> ${statusBadge(order.status)}</p>
            <p><strong>Thời gian:</strong> ${fmtDate(order.created_at)}</p>
            ${order.paid_at ? `<p><strong>Thanh toán:</strong> ${fmtDate(order.paid_at)} - ${paymentLabel(order.payment_method)}</p>` : ''}
            <table class="data-table" style="margin-top:12px">
                <thead><tr><th>Món</th><th>Giá</th><th>SL</th><th>TT</th></tr></thead>
                <tbody>${order.items.map(i => `<tr><td>${i.name}${i.note ? ` <em>(${i.note})</em>` : ''}</td><td>${fmt(i.price)}</td><td>${i.qty}</td><td>${fmt(i.price * i.qty)}</td></tr>`).join('')}</tbody>
            </table>
            ${order.discount_amount > 0 ? `<p style="margin-top:8px"><strong>Giảm giá:</strong> -${fmt(order.discount_amount)}</p>` : ''}
            <p style="margin-top:8px;font-size:16px"><strong>Tổng: ${fmt(order.total)}</strong></p>
        `;

        const footer = $('#order-detail-footer');
        let btns = `<button class="btn" id="od-close-btn">Đóng</button>`;
        if (order.status === 'paid') {
            btns += `<button class="btn" id="od-reprint-btn"><svg class="ico" viewBox="0 0 24 24"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg> In lại</button>`;
        }
        if (order.status === 'pending') {
            btns += `<button class="btn" id="od-edit-btn"><svg class="ico" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Sửa đơn</button>`;
            btns += `<button class="btn btn-success" id="od-pay-btn">Thanh toán</button>`;
        }
        if (order.status === 'paid' && App.user?.role === 'admin') {
            btns += `<button class="btn" id="od-edit-btn"><svg class="ico" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Sửa đơn</button>`;
        }
        if (App.user?.role === 'admin') {
            btns += `<button class="btn btn-danger" id="od-delete-btn"><svg class="ico" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg> Xóa</button>`;
        }
        footer.innerHTML = btns;
        footer.querySelector('#od-close-btn')?.addEventListener('click', () => closeModal('modal-order-detail'));
        footer.querySelector('#od-reprint-btn')?.addEventListener('click', () => reprintOrder(id));
        footer.querySelector('#od-edit-btn')?.addEventListener('click', () => editOrder(id));
        footer.querySelector('#od-pay-btn')?.addEventListener('click', () => { payOrder(String(id)); closeModal('modal-order-detail'); });
        footer.querySelector('#od-delete-btn')?.addEventListener('click', () => deleteOrder(id));
        openModal('modal-order-detail');
    } catch (err) { toast(err.message, 'error'); }
};

window.reprintOrder = async (id) => {
    try {
        const orders = await api.get('/api/orders');
        const order = orders.find(o => o.id === id);
        if (!order) { toast('Không tìm thấy đơn', 'error'); return; }

        const settings = await api.get('/api/settings');
        const payLabels = { cash: 'Tiền mặt', qr: 'QR Code', transfer: 'Chuyển khoản', card: 'Thẻ' };

        lastReceiptData = {
            shopName: settings.name || 'CHILL CAFE',
            address: settings.address || '',
            phone: settings.phone || '',
            invoiceNumber: order.invoice_number || order.code || '',
            date: order.paid_at || order.created_at,
            tableName: order.table_name || '',
            staffName: order.staff_name || '',
            items: order.items || [],
            subtotal: order.subtotal || order.total,
            discountAmount: order.discount_amount || 0,
            total: order.total,
            paymentMethod: order.payment_method || 'cash',
            paidAmount: order.payment_amount || 0,
            change: order.change_amount || 0
        };

        closeModal('modal-order-detail');
        showReceipt(lastReceiptData);
        toast('Sẵn sàng in lại bill');
    } catch (err) { toast(err.message, 'error'); }
};

window.editOrder = async (id) => {
    try {
        const orders = await api.get('/api/orders?limit=200');
        const order = orders.find(o => o.id === id);
        if (!order) { toast('Không tìm thấy đơn', 'error'); return; }

        App._editCart = (order.items || []).map(i => ({
            id: i.id || i.menuId || '',
            name: i.name,
            price: i.price,
            qty: i.qty,
            note: i.note || ''
        }));
        App._editOrderId = id;
        App._editCategory = 'all';

        $('#edit-order-name').textContent = (order.table_name ? order.table_name + ' \u2014 ' : '') + (order.code || id);

        renderEditCart();
        renderEditCategories();
        renderEditMenu();

        closeModal('modal-order-detail');
        openModal('modal-edit-order');
    } catch (err) { toast(err.message, 'error'); }
};

function renderEditCart() {
    const el = $('#edit-order-cart');
    if (!App._editCart || !App._editCart.length) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Chưa có món</div>';
    } else {
        el.innerHTML = App._editCart.map((item, i) => `
            <div class="edit-cart-item">
                <div class="eci-name">${item.name}${item.note ? `<br><em style="font-size:11px;color:var(--text-muted)">${item.note}</em>` : ''}</div>
                <div class="eci-qty">
                    <button onclick="editCartQty(${i},-1)">-</button>
                    <span>${item.qty}</span>
                    <button onclick="editCartQty(${i},1)">+</button>
                </div>
                <div class="eci-price">${fmt(item.price * item.qty)}</div>
            </div>
        `).join('');
    }
    const subtotal = (App._editCart || []).reduce((s, c) => s + c.price * c.qty, 0);
    $('#edit-order-totals').innerHTML = `<strong>Tổng: ${fmt(subtotal)}</strong>`;
}

function renderEditCategories() {
    const seen = new Set();
    const cats = [{ id: 'all', name: 'Tất cả' }];
    App.menuItems.forEach(m => { if (!seen.has(m.category)) { seen.add(m.category); cats.push({ id: m.category, name: m.category }); } });
    $('#edit-order-cats').innerHTML = cats.map(c =>
        `<button class="category-tab${App._editCategory === c.id ? ' active' : ''}" onclick="setEditCategory('${c.id}')">${c.name}</button>`
    ).join('');
}

function renderEditMenu() {
    const rawSearch = ($('#edit-order-search')?.value || '').trim().toLowerCase();
    const search = removeDiacritics(rawSearch);
    const items = App.menuItems.filter(m => {
        if (App._editCategory !== 'all' && m.category !== App._editCategory) return false;
        if (search) {
            const name = removeDiacritics(m.name.toLowerCase());
            if (!name.includes(search) && !m.name.toLowerCase().includes(rawSearch)) return false;
        }
        return true;
    });
    $('#edit-order-menu').innerHTML = items.map(m =>
        `<div class="menu-item${m.status === 'soldout' ? ' soldout' : ''}${m.image_url ? ' has-image' : ''}" onclick="editAddItem('${m.id}')">
            ${m.image_url ? `<div class="item-img"><img src="${m.image_url}" alt="${m.name}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
            <div class="item-info">
                <div class="item-name">${m.name}</div>
                <div class="item-price">${fmt(m.price)}</div>
            </div>
        </div>`
    ).join('') || '<p style="text-align:center;color:var(--text-muted);padding:16px">Không tìm thấy món</p>';
}

window.setEditCategory = (cat) => {
    App._editCategory = cat;
    renderEditCategories();
    renderEditMenu();
};

window.editAddItem = (menuId) => {
    const item = App.menuItems.find(m => m.id === menuId);
    if (!item || item.status === 'soldout') return;
    const existing = App._editCart.find(c => c.id === menuId);
    if (existing) { existing.qty++; } else { App._editCart.push({ id: item.id, name: item.name, price: item.price, qty: 1, note: '' }); }
    renderEditCart();
    if (navigator.vibrate) navigator.vibrate(20);
};

window.editCartQty = (idx, delta) => {
    App._editCart[idx].qty += delta;
    if (App._editCart[idx].qty <= 0) App._editCart.splice(idx, 1);
    renderEditCart();
};

$('#edit-order-search')?.addEventListener('input', renderEditMenu);

$('#edit-order-save-btn')?.addEventListener('click', async () => {
    if (!App._editCart || !App._editCart.length) { toast('Đơn phải có ít nhất 1 món', 'error'); return; }
    try {
        await api.put(`/api/orders/${App._editOrderId}/items`, {
            items: App._editCart.map(c => ({ id: c.id, qty: c.qty, note: c.note }))
        });
        closeModal('modal-edit-order');
        toast('Đã lưu thay đổi');
        loadOrders();
    } catch (err) { toast(err.message, 'error'); }
});

window.deleteOrder = async (id) => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.zIndex = '2000';
    modal.innerHTML = `
        <div class="modal modal-sm" style="max-width:400px">
            <div class="modal-header"><h3>Lý do xóa đơn</h3></div>
            <div class="modal-body" style="padding:16px">
                <div style="display:flex;flex-direction:column;gap:10px">
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:var(--radius)">
                        <input type="radio" name="delete-reason" value="Phục vụ nhầm" checked> Phục vụ nhầm
                    </label>
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px;border:1px solid var(--border);border-radius:var(--radius)">
                        <input type="radio" name="delete-reason" value="other"> Khác
                    </label>
                    <textarea id="delete-reason-text" placeholder="Ghi rõ lý do..." rows="2" style="display:none;width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" id="del-cancel">Hủy</button>
                <button class="btn btn-danger" id="del-confirm"><svg class="ico" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg> Xác nhận xóa</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.querySelectorAll('input[name="delete-reason"]').forEach(r => {
        r.addEventListener('change', () => {
            const txt = modal.querySelector('#delete-reason-text');
            txt.style.display = r.value === 'other' && r.checked ? 'block' : 'none';
            if (r.value === 'other') txt.focus();
        });
    });
    modal.querySelector('#del-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#del-confirm').addEventListener('click', async () => {
        const selected = modal.querySelector('input[name="delete-reason"]:checked').value;
        let reason = selected;
        if (selected === 'other') {
            reason = modal.querySelector('#delete-reason-text').value.trim();
            if (!reason) { toast('Vui lòng ghi lý do xóa', 'error'); return; }
        }
        modal.remove();
        try {
            await api.del(`/api/orders/${id}?reason=${encodeURIComponent(reason)}`);
            closeModal('modal-order-detail');
            toast('Đã xóa đơn hàng');
            loadOrders();
        } catch (err) { toast(err.message, 'error'); }
    });
};

window.payOrder = async (id) => {
    // Simple quick pay with cash
    try {
        const res = await api.post(`/api/orders/${id}/pay`, { payment_method: 'cash', payment_amount: 0 });
        toast(`Thanh toán thành công - ${res.invoice_number}`);
        showReceipt(res.receipt);
        loadOrders();
    } catch (err) { toast(err.message, 'error'); }
};

window.cancelOrder = async (id) => {
    if (!confirm('Hủy đơn hàng này?')) return;
    try {
        await api.put(`/api/orders/${id}/status`, { status: 'cancelled' });
        toast('Đã hủy đơn hàng');
        loadOrders();
    } catch (err) { toast(err.message, 'error'); }
};

// ===== MENU PAGE =====
let menuPageCategory = 'all';

async function loadMenu() {
    try {
        await loadCategoryLabels();
        const menu = await api.get('/api/menu');
        App.currentMenu = menu;
        renderMenuCategories(menu);
        renderMenuTable(menu);
    } catch (err) { toast(err.message, 'error'); }
}

function renderMenuCategories(menu) {
    const cats = ['all', ...new Set(menu.map(m => m.category))];
    const el = $('#menu-categories');
    el.innerHTML = cats.map(c =>
        `<span class="cat-tab ${c === menuPageCategory ? 'active' : ''}" data-cat="${c}">${categoryLabels[c] || c}</span>`
    ).join('');
    el.querySelectorAll('.cat-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            menuPageCategory = tab.dataset.cat;
            el.querySelectorAll('.cat-tab').forEach(t => t.classList.toggle('active', t === tab));
            renderMenuTable(menu);
        });
    });
}

function renderMenuTable(menu) {
    const filtered = menuPageCategory === 'all' ? menu : menu.filter(m => m.category === menuPageCategory);
    const tbody = $('#menu-table tbody');
    tbody.innerHTML = filtered.map(m => `<tr>
        <td><div style="display:flex;align-items:center;gap:8px">
            ${m.image_url ? `<img src="${m.image_url}" style="width:40px;height:40px;border-radius:6px;object-fit:cover">` : `<div style="width:40px;height:40px;border-radius:6px;background:#eee;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999">No img</div>`}
            <span>${m.name}</span>
        </div></td>
        <td class="hide-mobile">${categoryLabels[m.category] || m.category}</td>
        <td>${fmt(m.price)}</td>
        <td class="hide-mobile">${menuStatusBadge(m.status)}</td>
        <td class="actions">
            <button class="btn btn-sm" onclick="editMenuItem('${m.id}')">Sửa</button>
            <button class="btn btn-sm btn-danger" onclick="deleteMenuItem('${m.id}')">Xóa</button>
        </td>
    </tr>`).join('');
}

function getCategoryOptions() {
    const cats = new Set(Object.keys(categoryLabels).filter(k => k !== 'all'));
    App.menuItems.forEach(m => cats.add(m.category));
    const opts = [...cats].map(k => [k, categoryLabels[k] || k]);
    opts.push(['__new__', '+ Thêm danh mục mới...']);
    return opts;
}

function addCategorySelectHandler() {
    setTimeout(() => {
        const sel = document.querySelector('#form-category');
        if (!sel) return;
        sel.addEventListener('change', () => {
            if (sel.value === '__new__') {
                const name = prompt('Nhập tên danh mục mới (tiếng Việt):');
                if (!name || !name.trim()) { sel.value = 'coffee'; return; }
                const key = name.trim().toLowerCase()
                    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a').replace(/[èéẹẻẽêềếệểễ]/g, 'e')
                    .replace(/[ìíịỉĩ]/g, 'i').replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
                    .replace(/[ùúụủũưừứựửữ]/g, 'u').replace(/[ỳýỵỷỹ]/g, 'y').replace(/đ/g, 'd')
                    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
                if (!key) { sel.value = 'coffee'; return; }
                categoryLabels[key] = name.trim();
                const opt = document.createElement('option');
                opt.value = key; opt.textContent = name.trim();
                sel.insertBefore(opt, sel.querySelector('[value="__new__"]'));
                sel.value = key;
                toast('Đã thêm danh mục: ' + name.trim());
            }
        });
    }, 100);
}

$('#add-menu-btn').addEventListener('click', () => {
    showFormModal('Thêm món', [
        { key: 'name', label: 'Tên món', type: 'text', required: true },
        { key: 'category', label: 'Danh mục', type: 'select', options: getCategoryOptions() },
        { key: 'price', label: 'Giá (VNĐ)', type: 'number', required: true },
        { key: 'description', label: 'Mô tả', type: 'text' },
        { key: 'status', label: 'Trạng thái', type: 'select', options: [['available', 'Còn hàng'], ['soldout', 'Hết hàng']] },
    ], async (data) => {
        await api.post('/api/menu', data);
        toast('Đã thêm món');
        loadMenu();
    });
    addCategorySelectHandler();
});

window.editMenuItem = async (id) => {
    const menu = await api.get('/api/menu');
    const item = menu.find(m => m.id === id);
    if (!item) return;
    showFormModal('Sửa món', [
        { key: 'name', label: 'Tên món', type: 'text', value: item.name, required: true },
        { key: 'category', label: 'Danh mục', type: 'select', value: item.category, options: getCategoryOptions() },
        { key: 'price', label: 'Giá (VNĐ)', type: 'number', value: item.price, required: true },
        { key: 'description', label: 'Mô tả', type: 'text', value: item.description },
        { key: 'status', label: 'Trạng thái', type: 'select', value: item.status, options: [['available', 'Còn hàng'], ['soldout', 'Hết hàng']] },
        { key: 'image_url', label: 'Link ảnh (URL)', type: 'text', value: item.image_url || '' },
    ], async (data) => {
        data.id = id;
        await api.post('/api/menu', data);
        toast('Đã cập nhật món');
        loadMenu();
    });
    addCategorySelectHandler();
    // Add image preview and upload button after modal opens
    setTimeout(() => {
        const urlInput = document.querySelector('.modal [name="image_url"]');
        if (urlInput) {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:12px';
            wrapper.innerHTML = `
                <div style="flex-shrink:0">
                    <img id="menu-img-preview" src="${item.image_url || ''}" style="width:80px;height:80px;border-radius:8px;object-fit:cover;border:1px solid #ddd;${item.image_url ? '' : 'display:none'}" onerror="this.style.display='none'">
                </div>
                <div>
                    <input type="file" id="menu-img-file" accept="image/*" style="font-size:12px;max-width:200px">
                    <div style="font-size:11px;color:#888;margin-top:4px">Hoặc nhập URL ở trên</div>
                </div>
            `;
            urlInput.parentElement.appendChild(wrapper);
            document.getElementById('menu-img-file')?.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('image', file);
                try {
                    const res = await fetch('/api/menu/' + id + '/image', {
                        method: 'POST',
                        body: formData,
                        headers: { 'X-CSRF-Token': App.csrfToken }
                    });
                    const result = await res.json();
                    if (result.success) {
                        urlInput.value = result.image_url;
                        const preview = document.getElementById('menu-img-preview');
                        preview.src = result.image_url;
                        preview.style.display = 'block';
                        toast('Đã upload ảnh');
                    } else { toast(result.error, 'error'); }
                } catch(err) { toast('Lỗi upload ảnh', 'error'); }
            });
        }
    }, 100);
};

window.deleteMenuItem = async (id) => {
    if (!confirm('Xóa món này?')) return;
    try { await api.del(`/api/menu/${id}`); toast('Đã xóa món'); loadMenu(); }
    catch (err) { toast(err.message, 'error'); }
};

// ===== EDIT CATEGORIES =====
function openEditCategoriesModal() {
    const menu = App.currentMenu || [];
    const slugs = [...new Set(menu.map(m => m.category).filter(Boolean))].sort();
    Object.keys(categoryLabels).forEach(k => { if (k !== 'all' && !slugs.includes(k)) slugs.push(k); });
    const list = $('#edit-categories-list');
    list.innerHTML = slugs.map(slug => `
        <div style="margin-bottom:10px">
            <input type="text" class="input-sm cat-name-input" data-slug="${slug}" value="${(categoryLabels[slug] || slug).replace(/"/g, '&quot;')}" style="width:100%">
        </div>
    `).join('');
    openModal('modal-edit-categories');
}

$('#edit-categories-btn')?.addEventListener('click', openEditCategoriesModal);

$('#save-categories-btn')?.addEventListener('click', async () => {
    const inputs = $$('#edit-categories-list .cat-name-input');
    const payload = {};
    inputs.forEach(inp => {
        const slug = inp.dataset.slug;
        const name = inp.value.trim();
        if (slug && name) payload[slug] = name;
    });
    try {
        await api.put('/api/settings', { category_names: payload });
        categoryLabels = { ...DEFAULT_CATEGORY_LABELS, ...payload };
        closeModal('modal-edit-categories');
        toast('Đã lưu tên danh mục');
        loadMenu();
    } catch (err) { toast(err.message, 'error'); }
});

// ===== SHIFTS PAGE =====
async function loadShifts() {
    try {
        const [currentData, shifts] = await Promise.all([
            api.get('/api/shifts/current'),
            api.get('/api/shifts?limit=20')
        ]);

        const infoEl = $('#current-shift-info');
        if (currentData.shift) {
            show(infoEl);
            const s = currentData.shift;
            const st = currentData.stats;
            infoEl.innerHTML = `
                <h3>Ca hiện tại: ${s.code} - ${s.staff_name}</h3>
                <p>Mở lúc: ${fmtDate(s.open_time)} | Tiền đầu ca: ${fmt(s.open_amount)}</p>
                <div class="shift-info" style="margin-top:12px">
                    <div class="shift-stat"><div class="value">${st.ordersCount}</div><div class="label">Đơn hàng</div></div>
                    <div class="shift-stat"><div class="value">${fmt(st.revenue)}</div><div class="label">Doanh thu</div></div>
                    <div class="shift-stat"><div class="value">${fmt(st.income)}</div><div class="label">Tổng thu</div></div>
                    <div class="shift-stat"><div class="value">${fmt(st.expense)}</div><div class="label">Tổng chi</div></div>
                </div>
                <div style="margin-top:12px;text-align:right;display:flex;gap:8px;justify-content:flex-end">
                    ${hasPerm('shift.manage') ? `<button class="btn" onclick="editShiftStaff(${s.id},'${s.staff_id || ''}')">Nhân viên ca</button>` : ''}
                    <button class="btn btn-danger" onclick="closeShift(${s.id})">Đóng ca</button>
                </div>
            `;
            $('#open-shift-btn').style.display = 'none';
        } else {
            hide(infoEl);
            $('#open-shift-btn').style.display = '';
        }

        const tbody = $('#shifts-table tbody');
        tbody.innerHTML = shifts.map(s => `<tr>
            <td>${s.code}</td>
            <td>${s.staff_name}</td>
            <td>${fmtDate(s.open_time)}</td>
            <td>${s.close_time ? fmtDate(s.close_time) : '-'}</td>
            <td>${fmt(s.open_amount)}</td>
            <td>${s.close_amount !== null ? fmt(s.close_amount) : '-'}</td>
            <td><strong style="color:var(--primary)">${fmt(s.revenue || 0)}</strong><br><span style="font-size:11px;color:var(--text-muted)">${s.orderCount || 0} đơn</span></td>
            <td>${statusBadge(s.status)}</td>
            <td class="actions">
                ${hasPerm('shift.manage') ? `<button class="btn btn-sm" onclick="editShiftStaff(${s.id},'${s.staff_id || ''}')">NV</button>` : ''}
                ${s.status === 'open' ? `<button class="btn btn-sm btn-danger" onclick="closeShift(${s.id})">Đóng</button>` : ''}
            </td>
        </tr>`).join('');
    } catch (err) { toast(err.message, 'error'); }
}

window.editShiftStaff = async function(shiftId, openerId) {
    try {
        const [staff, attendance] = await Promise.all([api.get('/api/staff'), api.get('/api/shifts/' + shiftId + '/staff')]);
        const active = staff.filter(s => s.status !== 'inactive');
        const attIds = new Set(attendance.map(a => a.staff_id));
        let html = '<div style="padding:4px">';
        html += '<div style="margin-bottom:12px"><label style="font-size:13px;font-weight:600">Người mở ca</label><br>'
            + '<select id="att-opener" style="margin-top:4px;padding:6px;border:1px solid var(--border);border-radius:6px;min-width:180px">'
            + active.map(s => `<option value="${s.id}" ${s.id === openerId ? 'selected' : ''}>${s.name}</option>`).join('')
            + '</select></div>';
        html += '<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Điểm danh nhân viên làm trong ca này:</div>';
        html += active.map(s => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0f0f0;cursor:pointer"><input type="checkbox" class="att-cb" data-sid="${s.id}" ${attIds.has(s.id) ? 'checked' : ''}> ${s.name} <span style="color:var(--text-muted);font-size:12px">(${roleLabel(s.role)})</span></label>`).join('');
        html += '</div>';
        showTableOpModal('Nhân viên trong ca', html);
        const body = document.querySelector('#modal-payment .modal-body');
        body.querySelector('#att-opener')?.addEventListener('change', async (e) => {
            try {
                await api.put('/api/shifts/' + shiftId, { staff_id: e.target.value });
                const cb = body.querySelector(`.att-cb[data-sid="${e.target.value}"]`); if (cb) cb.checked = true;
                toast('Đã đổi người mở ca'); loadShifts();
            } catch (err) { toast(err.message, 'error'); }
        });
        body.querySelectorAll('.att-cb').forEach(cb => {
            cb.addEventListener('change', async () => {
                const sid = cb.dataset.sid;
                try {
                    if (cb.checked) await api.post('/api/shifts/' + shiftId + '/staff', { staff_id: sid });
                    else await api.del('/api/shifts/' + shiftId + '/staff/' + sid);
                } catch (err) { toast(err.message, 'error'); cb.checked = !cb.checked; }
            });
        });
    } catch (e) { toast(e.message, 'error'); }
};

$('#open-shift-btn').addEventListener('click', () => {
    api.get('/api/staff').then(staff => {
        const activeStaff = staff.filter(s => s.status !== 'inactive');
        const staffField = activeStaff.length
            ? { key: 'staff_id', label: 'Nhân viên mở ca', type: 'select', options: activeStaff.map(s => [s.id, s.name]), required: true }
            : { key: 'staff_name', label: 'Nhân viên mở ca', type: 'text', required: true };
        showFormModal('Mở ca làm việc', [
            staffField,
            { key: 'open_amount', label: 'Tiền đầu ca', type: 'number', value: 0 },
            { key: 'note', label: 'Ghi chú', type: 'text' },
        ], async (data) => {
            await api.post('/api/shifts/open', data);
            toast('Đã mở ca');
            loadShifts();
        });
    }).catch(() => toast('Không tải được danh sách nhân viên', 'error'));
});

window.closeShift = (id) => {
    showFormModal('Đóng ca', [
        { key: 'close_amount', label: 'Tiền cuối ca (để trống = tự tính)', type: 'number' },
        { key: 'note', label: 'Ghi chú', type: 'text' },
    ], async (data) => {
        const res = await api.post(`/api/shifts/${id}/close`, data);
        const s = res.summary;
        toast('Đã đóng ca');
        alert(`KẾT CA: ${s.code}\nNhân viên: ${s.staffName}\nĐơn hàng: ${s.ordersCount}\nDoanh thu: ${fmt(s.revenue)}\nThu: ${fmt(s.income)} | Chi: ${fmt(s.expense)}\nTiền đầu ca: ${fmt(s.openAmount)}\nTiền cuối ca: ${fmt(s.closeAmount)}\nTiền mặt dự kiến: ${fmt(s.expectedCash)}`);
        loadShifts();
    });
};

// ===== TRANSACTIONS PAGE =====
async function loadTransactions() {
    try {
        const date = $('#tx-date').value;
        const type = $('#tx-type').value;
        let url = '/api/transactions?limit=50';
        if (date) url += `&date=${date}`;
        if (type) url += `&type=${type}`;

        const txs = await api.get(url);
        let income = 0, expense = 0;
        txs.forEach(t => { if (t.type === 'income') income += t.amount; else expense += t.amount; });

        $('#tx-income').textContent = fmt(income);
        $('#tx-expense').textContent = fmt(expense);

        const tbody = $('#tx-table tbody');
        tbody.innerHTML = txs.map(t => `<tr>
            <td>${t.code || ''}</td>
            <td>${t.type === 'income' ? '<span style="color:var(--success)">Thu</span>' : '<span style="color:var(--danger)">Chi</span>'}</td>
            <td>${t.category}</td>
            <td>${fmt(t.amount)}</td>
            <td>${paymentLabel(t.payment_method)}</td>
            <td>${t.description || ''}</td>
            <td>${fmtDate(t.created_at)}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteTx(${t.id})">Xóa</button></td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Chưa có giao dịch</td></tr>';
    } catch (err) { toast(err.message, 'error'); }
}

$('#tx-date').addEventListener('change', loadTransactions);
$('#tx-type').addEventListener('change', loadTransactions);

$('#add-tx-btn').addEventListener('click', () => {
    showFormModal('Thêm giao dịch', [
        { key: 'type', label: 'Loại', type: 'select', options: [['income', 'Thu'], ['expense', 'Chi']], required: true },
        { key: 'category', label: 'Danh mục', type: 'text', required: true },
        { key: 'amount', label: 'Số tiền', type: 'number', required: true },
        { key: 'payment_method', label: 'PT thanh toán', type: 'select', options: [['cash', 'Tiền mặt'], ['transfer', 'Chuyển khoản'], ['card', 'Thẻ']] },
        { key: 'description', label: 'Mô tả', type: 'text' },
    ], async (data) => {
        await api.post('/api/transactions', data);
        toast('Đã thêm giao dịch');
        loadTransactions();
    });
});

window.deleteTx = async (id) => {
    if (!confirm('Xóa giao dịch này?')) return;
    try { await api.del(`/api/transactions/${id}`); toast('Đã xóa'); loadTransactions(); }
    catch (err) { toast(err.message, 'error'); }
};

// ===== INVENTORY PAGE =====
async function loadInventory() {
    try {
        const inv = await api.get('/api/inventory');
        const tbody = $('#inv-table tbody');
        tbody.innerHTML = inv.map(i => {
            const low = i.qty <= i.min_qty;
            return `<tr>
                <td>${i.name}</td>
                <td>${i.qty}</td>
                <td>${i.unit}</td>
                <td>${i.min_qty}</td>
                <td>${low ? '<span class="badge badge-danger">Sắp hết</span>' : '<span class="badge badge-success">Đủ</span>'}</td>
                <td class="actions">
                    <button class="btn btn-sm" onclick="editInv('${i.id}')">Sửa</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteInv('${i.id}')">Xóa</button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) { toast(err.message, 'error'); }
}

$('#add-inv-btn').addEventListener('click', () => {
    showFormModal('Thêm nguyên liệu', [
        { key: 'name', label: 'Tên', type: 'text', required: true },
        { key: 'qty', label: 'Số lượng', type: 'number', required: true },
        { key: 'unit', label: 'Đơn vị', type: 'text', required: true },
        { key: 'min_qty', label: 'Mức tối thiểu', type: 'number', required: true },
    ], async (data) => {
        await api.post('/api/inventory', data);
        toast('Đã thêm');
        loadInventory();
    });
});

window.editInv = async (id) => {
    const inv = await api.get('/api/inventory');
    const item = inv.find(i => i.id === id);
    if (!item) return;
    showFormModal('Sửa nguyên liệu', [
        { key: 'name', label: 'Tên', type: 'text', value: item.name, required: true },
        { key: 'qty', label: 'Số lượng', type: 'number', value: item.qty, required: true },
        { key: 'unit', label: 'Đơn vị', type: 'text', value: item.unit, required: true },
        { key: 'min_qty', label: 'Mức tối thiểu', type: 'number', value: item.min_qty, required: true },
    ], async (data) => {
        data.id = id;
        await api.post('/api/inventory', data);
        toast('Đã cập nhật');
        loadInventory();
    });
};

window.deleteInv = async (id) => {
    if (!confirm('Xóa nguyên liệu này?')) return;
    try { await api.del(`/api/inventory/${id}`); toast('Đã xóa'); loadInventory(); }
    catch (err) { toast(err.message, 'error'); }
};

// ===== STAFF PAGE =====
async function loadStaff() {
    try {
        // Roles cache → "Vị trí" dùng vai trò của hệ thống tài khoản
        try { App.rolesCache = await api.get('/api/roles'); } catch (e) {}
        const staff = await api.get('/api/staff');
        const tbody = $('#staff-table tbody');
        tbody.innerHTML = !staff.length ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có nhân viên nào. Bấm "Thêm" để tạo hồ sơ đầu tiên.</td></tr>` : staff.map(s => `<tr>
            <td>${s.name}</td>
            <td>${roleLabel(s.role)}</td>
            <td>${s.phone || '-'}</td>
            <td>${shiftLabels[s.shift] || s.shift}</td>
            <td>${payTypeLabels[s.pay_type || 'month']} · ${fmt(s.salary)}${s.pay_type && s.pay_type !== 'month' ? '/' + payTypeUnit[s.pay_type] : ''}</td>
            <td class="actions">
                <button class="btn btn-sm" onclick="editStaff('${s.id}')">Sửa</button>
                <button class="btn btn-sm btn-danger" onclick="deleteStaff('${s.id}')">Xóa</button>
            </td>
        </tr>`).join('');
    } catch (err) { toast(err.message, 'error'); }
}

$('#add-staff-btn').addEventListener('click', () => {
    showFormModal('Thêm nhân viên', [
        { key: 'name', label: 'Họ tên', type: 'text', required: true },
        { key: 'role', label: 'Vị trí (vai trò)', type: 'select', options: roleOptions() },
        { key: 'phone', label: 'SĐT', type: 'text' },
        { key: 'shift', label: 'Ca', type: 'select', options: Object.entries(shiftLabels) },
        { key: 'pay_type', label: 'Hình thức trả', type: 'select', options: Object.entries(payTypeLabels) },
        { key: 'salary', label: 'Đơn giá (đ/giờ, đ/buổi, hoặc đ/tháng)', type: 'number', value: 0 },
    ], async (data) => {
        await api.post('/api/staff', data);
        toast('Đã thêm nhân viên');
        loadStaff();
    });
});

window.editStaff = async (id) => {
    const staff = await api.get('/api/staff');
    const s = staff.find(x => x.id === id);
    if (!s) return;
    showFormModal('Sửa nhân viên', [
        { key: 'name', label: 'Họ tên', type: 'text', value: s.name, required: true },
        { key: 'role', label: 'Vị trí (vai trò)', type: 'select', value: s.role, options: roleOptions() },
        { key: 'phone', label: 'SĐT', type: 'text', value: s.phone },
        { key: 'shift', label: 'Ca', type: 'select', value: s.shift, options: Object.entries(shiftLabels) },
        { key: 'pay_type', label: 'Hình thức trả', type: 'select', value: s.pay_type || 'month', options: Object.entries(payTypeLabels) },
        { key: 'salary', label: 'Đơn giá (đ/giờ, đ/buổi, hoặc đ/tháng)', type: 'number', value: s.salary },
    ], async (data) => {
        data.id = id;
        await api.post('/api/staff', data);
        toast('Đã cập nhật');
        loadStaff();
    });
};

window.deleteStaff = async (id) => {
    if (!confirm('Xóa nhân viên này?')) return;
    try { await api.del(`/api/staff/${id}`); toast('Đã xóa'); loadStaff(); }
    catch (err) { toast(err.message, 'error'); }
};

// ===== PAYROLL + CHẤM CÔNG (theo tháng, nhập tay) =====
let _payrollWired = false;
const PR = { period: '', staff: [], state: {} };
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function daysInPeriod(period) { const [y, m] = period.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function ensurePayrollPeriod() {
    const el = document.getElementById('payroll-period');
    if (!el) return '';
    if (!el.value) { const d = new Date(); el.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
    return el.value;
}
function buoiCount(sid) { return PR.state[sid].m.size + PR.state[sid].a.size; }

async function loadPayroll() {
    const tsHead = document.querySelector('#timesheet-table thead');
    if (!tsHead) return;
    const period = ensurePayrollPeriod();
    PR.period = period;
    if (!_payrollWired) {
        _payrollWired = true;
        document.getElementById('payroll-period')?.addEventListener('change', loadPayroll);
        document.getElementById('payroll-reload')?.addEventListener('click', loadPayroll);
        document.getElementById('payroll-save')?.addEventListener('click', savePayroll);
        document.getElementById('payroll-export')?.addEventListener('click', exportPayrollCSV);
        document.getElementById('payroll-import-btn')?.addEventListener('click', () => document.getElementById('payroll-import-file')?.click());
        document.getElementById('payroll-import-file')?.addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { importPayrollCSV(String(rd.result)); e.target.value = ''; }; rd.readAsText(f); });
        document.querySelector('#timesheet-table tbody')?.addEventListener('click', (e) => { const c = e.target.closest('.ts-cell'); if (c) toggleTsCell(c); });
        document.querySelector('#payroll-table tbody')?.addEventListener('input', (e) => onSalaryInput(e.target.closest('tr')));
        document.querySelector('#payroll-table tbody')?.addEventListener('change', (e) => onSalaryInput(e.target.closest('tr')));
    }
    try {
        const [staff, sheet] = await Promise.all([api.get('/api/staff'), api.get('/api/payroll/' + period)]);
        const saved = {}; (sheet.rows || []).forEach(r => { saved[r.staff_id] = r; });
        PR.staff = staff.filter(s => s.status !== 'inactive');
        PR.state = {};
        PR.staff.forEach(s => {
            const r = saved[s.id] || {};
            PR.state[s.id] = {
                name: s.name,
                pay_type: r.pay_type || s.pay_type || 'month',
                rate: r.rate != null ? r.rate : (s.salary || 0),
                allowance: r.allowance || 0,
                deduction: r.deduction || 0,
                hours: r.hours || 0,
                note: r.note || '',
                m: new Set((r.morning || []).map(Number)),
                a: new Set((r.afternoon || []).map(Number)),
            };
        });
        renderTimesheet();
        renderSalary();
    } catch (e) { toast(e.message, 'error'); }
}

function renderTimesheet() {
    const ndays = daysInPeriod(PR.period);
    const [y, mo] = PR.period.split('-').map(Number);
    const head = document.querySelector('#timesheet-table thead');
    const body = document.querySelector('#timesheet-table tbody');
    const weekend = {};
    let h = '<tr><th style="position:sticky;left:0;background:var(--bg);z-index:3;min-width:90px">Nhân viên</th><th style="min-width:54px">Buổi</th>';
    for (let d = 1; d <= ndays; d++) {
        const wd = new Date(y, mo - 1, d).getDay();
        const we = (wd === 0 || wd === 6); if (we) weekend[d] = 1;
        h += '<th style="text-align:center;min-width:30px;font-size:11px' + (we ? ';background:#e9e9e9' : '') + '">' + d + '<br><span style="font-weight:400;color:var(--text-muted);font-size:10px">' + WD[wd] + '</span></th>';
    }
    head.innerHTML = h + '</tr>';
    const cell = (sid, sess, d) => {
        const on = PR.state[sid][sess].has(d);
        const mark = sess === 'm' ? 's' : 'c';
        const bg = on ? '#ffe680' : (weekend[d] ? '#f3f3f3' : '');
        return '<td class="ts-cell" data-sid="' + sid + '" data-sess="' + sess + '" data-day="' + d + '" style="text-align:center;cursor:pointer;min-width:30px;font-weight:700;color:' + (on ? '#7a5c00' : 'inherit') + (bg ? ';background:' + bg : '') + '">' + (on ? mark : '') + '</td>';
    };
    body.innerHTML = PR.staff.map(s => {
        let r1 = '<tr><td rowspan="2" style="position:sticky;left:0;background:#fff;z-index:1;font-weight:600;vertical-align:middle">' + s.name + '</td><td>Sáng</td>';
        for (let d = 1; d <= ndays; d++) r1 += cell(s.id, 'm', d);
        let r2 = '</tr><tr><td>Chiều</td>';
        for (let d = 1; d <= ndays; d++) r2 += cell(s.id, 'a', d);
        return r1 + r2 + '</tr>';
    }).join('');
}

function toggleTsCell(cell) {
    const sid = cell.dataset.sid, sess = cell.dataset.sess, d = Number(cell.dataset.day);
    const set = PR.state[sid][sess];
    const [y, mo] = PR.period.split('-').map(Number);
    const wd = new Date(y, mo - 1, d).getDay(); const we = (wd === 0 || wd === 6);
    if (set.has(d)) { set.delete(d); cell.textContent = ''; cell.style.background = we ? '#f3f3f3' : ''; cell.style.color = 'inherit'; }
    else { set.add(d); cell.textContent = (sess === 'm' ? 's' : 'c'); cell.style.background = '#ffe680'; cell.style.color = '#7a5c00'; }
    updateSalaryRow(sid);
}

function renderSalary() {
    const tbody = document.querySelector('#payroll-table tbody');
    tbody.innerHTML = PR.staff.map(s => {
        const st = PR.state[s.id];
        const opts = Object.entries(payTypeLabels).map(([v, l]) => '<option value="' + v + '"' + (v === st.pay_type ? ' selected' : '') + '>' + l + '</option>').join('');
        const inp = (cls, val, w) => '<input class="' + cls + '" type="number" value="' + val + '" style="width:' + (w || 90) + 'px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px">';
        return '<tr data-sid="' + s.id + '">' +
            '<td>' + s.name + '</td>' +
            '<td><select class="pr-type" style="padding:4px;border:1px solid var(--border);border-radius:4px;font-size:13px">' + opts + '</select></td>' +
            '<td>' + inp('pr-rate', st.rate) + '</td>' +
            '<td class="pr-buoi" style="font-weight:600;text-align:center">' + buoiCount(s.id) + '</td>' +
            '<td>' + inp('pr-hours', st.hours, 70) + '</td>' +
            '<td class="pr-base" style="font-weight:600">0d</td>' +
            '<td>' + inp('pr-allowance', st.allowance) + '</td>' +
            '<td>' + inp('pr-deduction', st.deduction) + '</td>' +
            '<td class="pr-net" style="font-weight:700;color:var(--primary)">0d</td>' +
            '<td><input class="pr-note" type="text" value="' + String(st.note || '').replace(/"/g, '&quot;') + '" style="width:130px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px"></td>' +
            '</tr>';
    }).join('');
    document.querySelectorAll('#payroll-table tbody tr').forEach(updateSalaryRowEl);
    recalcPayrollTotal();
}

function onSalaryInput(tr) {
    if (!tr) return;
    const st = PR.state[tr.dataset.sid]; if (!st) return;
    st.pay_type = tr.querySelector('.pr-type').value;
    st.rate = Number(tr.querySelector('.pr-rate').value) || 0;
    st.hours = Number(tr.querySelector('.pr-hours').value) || 0;
    st.allowance = Number(tr.querySelector('.pr-allowance').value) || 0;
    st.deduction = Number(tr.querySelector('.pr-deduction').value) || 0;
    st.note = tr.querySelector('.pr-note').value || '';
    updateSalaryRowEl(tr);
    recalcPayrollTotal();
}
function salaryBaseNet(sid) {
    const st = PR.state[sid];
    let base = st.pay_type === 'month' ? st.rate : (st.pay_type === 'hour' ? st.rate * st.hours : st.rate * buoiCount(sid));
    return { base, net: base + st.allowance - st.deduction };
}
function updateSalaryRowEl(tr) {
    const sid = tr.dataset.sid, st = PR.state[sid]; if (!st) return;
    const { base, net } = salaryBaseNet(sid);
    const hEl = tr.querySelector('.pr-hours'); if (hEl) { const dis = st.pay_type !== 'hour'; hEl.disabled = dis; hEl.style.opacity = dis ? '.4' : '1'; }
    const bEl = tr.querySelector('.pr-buoi'); if (bEl) bEl.textContent = buoiCount(sid);
    tr.querySelector('.pr-base').textContent = fmt(base);
    tr.querySelector('.pr-net').textContent = fmt(net);
}
function updateSalaryRow(sid) {
    const tr = document.querySelector('#payroll-table tbody tr[data-sid="' + sid + '"]');
    if (tr) { updateSalaryRowEl(tr); recalcPayrollTotal(); }
}
function recalcPayrollTotal() {
    let total = 0; PR.staff.forEach(s => { total += salaryBaseNet(s.id).net; });
    const el = document.getElementById('payroll-total'); if (el) el.textContent = fmt(total);
}

async function savePayroll() {
    const period = ensurePayrollPeriod();
    const rows = PR.staff.map(s => {
        const st = PR.state[s.id];
        return {
            staff_id: s.id, name: st.name, pay_type: st.pay_type, rate: st.rate,
            qty: buoiCount(s.id), hours: st.hours, allowance: st.allowance, deduction: st.deduction, note: st.note,
            morning: [...st.m].sort((a, b) => a - b), afternoon: [...st.a].sort((a, b) => a - b),
        };
    });
    try { await api.put('/api/payroll/' + period, { rows }); toast('Đã lưu bảng lương ' + period); }
    catch (e) { toast(e.message, 'error'); }
}

// ===== Xuất/Nhập bảng lương qua CSV (Excel mở được) =====
function csvEscape(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function exportPayrollCSV() {
    const period = ensurePayrollPeriod();
    const headers = ['Nhân viên', 'Hình thức', 'Đơn giá', 'Số buổi', 'Số giờ', 'Lương cơ bản', 'Phụ cấp', 'Khấu trừ', 'Thực lãnh', 'Ghi chú'];
    const lines = [headers.map(csvEscape).join(',')];
    PR.staff.forEach(s => {
        const st = PR.state[s.id], { base, net } = salaryBaseNet(s.id);
        lines.push([st.name, payTypeLabels[st.pay_type], st.rate, buoiCount(s.id), st.pay_type === 'hour' ? st.hours : '', base, st.allowance, st.deduction, net, st.note].map(csvEscape).join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bang-luong-' + period + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function parseCSV(text) {
    text = text.replace(/^﻿/, ''); const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
}
function importPayrollCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) { toast('Tệp trống hoặc sai định dạng', 'error'); return; }
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = (n) => header.findIndex(h => h.includes(n));
    const iName = idx('nhân viên') >= 0 ? idx('nhân viên') : 0, iType = idx('hình thức'), iRate = idx('đơn giá'), iHours = idx('số giờ'), iAll = idx('phụ cấp'), iDed = idx('khấu trừ'), iNote = idx('ghi chú');
    const labelToType = {}; Object.entries(payTypeLabels).forEach(([v, l]) => { labelToType[l.toLowerCase()] = v; });
    const num = (s) => Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')) || 0;
    const byName = {}; PR.staff.forEach(s => { byName[s.name.trim().toLowerCase()] = s.id; });
    let matched = 0;
    for (let r = 1; r < rows.length; r++) {
        const cells = rows[r]; if (!cells) continue;
        const nm = (cells[iName] || '').trim().toLowerCase(); if (!nm) continue;
        const sid = byName[nm]; if (!sid) continue; matched++;
        const st = PR.state[sid];
        if (iType >= 0 && cells[iType]) { const t = labelToType[cells[iType].trim().toLowerCase()]; if (t) st.pay_type = t; }
        if (iRate >= 0) st.rate = num(cells[iRate]);
        if (iHours >= 0) st.hours = num(cells[iHours]);
        if (iAll >= 0) st.allowance = num(cells[iAll]);
        if (iDed >= 0) st.deduction = num(cells[iDed]);
        if (iNote >= 0 && cells[iNote] != null) st.note = cells[iNote];
    }
    renderSalary();
    toast(matched ? ('Đã nhập ' + matched + ' dòng — kiểm tra rồi bấm "Lưu bảng lương"') : 'Không khớp nhân viên nào (đối chiếu cột Nhân viên)', matched ? 'success' : 'error');
}

// ===== USERS PAGE =====
function roleLabel(slug) {
    const r = (App.rolesCache || []).find(x => x.slug === slug);
    return r ? r.name : (userRoleLabels[slug] || slug);
}
function roleOptions() {
    const roles = App.rolesCache || [];
    if (roles.length) return roles.map(r => [r.slug, r.name]);
    return Object.entries(userRoleLabels);
}

async function loadUsers() {
    try {
        // Refresh roles cache (for labels + dropdowns) — ignore failure
        try { App.rolesCache = await api.get('/api/roles'); } catch (e) {}
        const users = await api.get('/api/users');
        const tbody = $('#users-table tbody');
        const isAdmin = App.user?.role === 'admin';
        tbody.innerHTML = users.map(u => `<tr>
            <td>${u.username}</td>
            <td>${u.display_name || u.username}</td>
            <td><span class="badge badge-${userRoleColors[u.role] || 'info'}">${roleLabel(u.role)}</span></td>
            <td>${fmtDate(u.created_at)}</td>
            <td class="actions">
                ${isAdmin ? `
                    <button class="btn btn-sm" onclick="editUser('${u.id}','${u.username.replace(/'/g, "\\'")}','${(u.display_name || '').replace(/'/g, "\\'")}','${u.role}')">Sửa</button>
                    ${u.id !== App.user?.id ? `<button class="btn btn-sm btn-danger" onclick="deleteUser('${u.id}','${u.username}')">Xóa</button>` : ''}
                ` : ''}
            </td>
        </tr>`).join('');

        const addBtn = $('#add-user-btn');
        if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';
        const rolesBtn = $('#manage-roles-btn');
        if (rolesBtn) rolesBtn.style.display = isAdmin ? '' : 'none';
    } catch (err) { toast(err.message, 'error'); }
}

$('#add-user-btn')?.addEventListener('click', () => {
    showFormModal('Thêm tài khoản', [
        { key: 'username', label: 'Tên đăng nhập', type: 'text', required: true },
        { key: 'display_name', label: 'Tên hiển thị', type: 'text' },
        { key: 'password', label: 'Mật khẩu', type: 'password', required: true },
        { key: 'role', label: 'Vai trò', type: 'select', options: roleOptions() },
    ], async (data) => {
        await api.post('/api/users', data);
        toast('Đã thêm tài khoản');
        loadUsers();
    });
});

window.editUser = (id, username, displayName, role) => {
    showFormModal('Sửa tài khoản: ' + username, [
        { key: 'display_name', label: 'Tên hiển thị', type: 'text', value: displayName },
        { key: 'role', label: 'Vai trò', type: 'select', value: role, options: roleOptions() },
        { key: 'password', label: 'Mật khẩu mới (để trống nếu không đổi)', type: 'password' },
    ], async (data) => {
        if (!data.password) delete data.password;
        await api.put(`/api/users/${id}`, data);
        toast('Đã cập nhật tài khoản');
        loadUsers();
    });
};

window.deleteUser = async (id, username) => {
    if (!confirm(`Xóa tài khoản "${username}"?`)) return;
    try {
        await api.del(`/api/users/${id}`);
        toast('Đã xóa tài khoản');
        loadUsers();
    } catch (err) { toast(err.message, 'error'); }
};

// ===== ROLE / PERMISSION MANAGER =====
$('#manage-roles-btn')?.addEventListener('click', openPermissionManager);

async function openPermissionManager() {
    try {
        const [cat, roles] = await Promise.all([api.get('/api/permissions'), api.get('/api/roles')]);
        App._permCatalog = cat;
        App.rolesCache = roles;
        renderPermissionManager();
    } catch (e) { toast(e.message, 'error'); }
}

function renderPermissionManager() {
    const cat = App._permCatalog || [];
    const roles = App.rolesCache || [];
    let html = '<div style="max-height:70vh;overflow:auto;padding:2px">';
    html += '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn btn-primary btn-sm" onclick="addRolePrompt()">+ Thêm vai trò</button></div>';
    roles.forEach(r => {
        html += `<div class="perm-role-card" data-role="${r.slug}" style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden">`;
        html += `<div class="perm-role-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;flex-wrap:wrap">`;
        html += `<div onclick="togglePermRole('${r.slug}')" style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:0">`;
        html += `<span class="perm-caret" style="display:inline-block;transition:transform .15s;color:var(--text-muted)">▸</span><b>${r.name}</b>`;
        html += `<span style="font-size:11px;color:var(--text-muted)">${r.user_count} tài khoản${r.is_system ? ' · hệ thống' : ''}</span></div>`;
        html += `<span style="display:flex;gap:6px;align-items:center">`;
        if (!r.is_admin) html += `<button class="btn btn-sm btn-primary" onclick="saveRolePerms('${r.slug}')">Lưu</button>`;
        if (!r.is_system) html += `<button class="btn btn-sm btn-danger" onclick="deleteRoleConfirm('${r.slug}','${r.name.replace(/'/g, "\\'")}')">Xóa</button>`;
        html += `</span></div>`;
        html += `<div class="perm-role-body" style="display:none;padding:0 12px 12px">`;
        if (r.is_admin) {
            html += `<div style="font-size:12px;color:var(--text-muted)">Quản trị viên luôn có toàn quyền (không thể chỉnh).</div>`;
        } else {
            cat.forEach(g => {
                html += `<div style="margin:8px 0"><div style="font-size:12px;font-weight:600;color:var(--text-light);margin-bottom:4px">${g.group}</div><div style="display:flex;flex-wrap:wrap;gap:12px">`;
                g.perms.forEach(p => {
                    const checked = r.permissions.includes(p.key) ? 'checked' : '';
                    html += `<label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer"><input type="checkbox" data-perm="${p.key}" ${checked}> ${p.label}</label>`;
                });
                html += `</div></div>`;
            });
        }
        html += `</div></div>`;
    });
    html += '</div>';
    showTableOpModal('Phân quyền vai trò', html);
}

window.togglePermRole = function(slug) {
    const card = document.querySelector(`.perm-role-card[data-role="${slug}"]`);
    if (!card) return;
    const body = card.querySelector('.perm-role-body');
    const caret = card.querySelector('.perm-caret');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    if (caret) caret.style.transform = open ? '' : 'rotate(90deg)';
};

window.saveRolePerms = async function(slug) {
    const card = document.querySelector(`.perm-role-card[data-role="${slug}"]`);
    if (!card) return;
    const perms = Array.from(card.querySelectorAll('input[type=checkbox][data-perm]:checked')).map(c => c.dataset.perm);
    try {
        await api.put('/api/roles/' + slug, { permissions: perms });
        toast('Đã lưu quyền cho vai trò');
        App.rolesCache = await api.get('/api/roles');
    } catch (e) { toast(e.message, 'error'); }
};

window.addRolePrompt = async function() {
    const name = prompt('Tên vai trò mới (vd: Pha chế):');
    if (!name || !name.trim()) return;
    try {
        await api.post('/api/roles', { name: name.trim(), permissions: [] });
        toast('Đã thêm vai trò');
        await openPermissionManager();
    } catch (e) { toast(e.message, 'error'); }
};

window.deleteRoleConfirm = async function(slug, name) {
    if (!confirm(`Xóa vai trò "${name}"?`)) return;
    try {
        await api.del('/api/roles/' + slug);
        toast('Đã xóa vai trò');
        await openPermissionManager();
    } catch (e) { toast(e.message, 'error'); }
};

// ===== REPORTS PAGE =====
async function loadReports() {
    const today = new Date().toISOString().split('T')[0];
    if (!$('#report-from').value) $('#report-from').value = today;
    if (!$('#report-to').value) $('#report-to').value = today;
}

$('#report-load-btn').addEventListener('click', async () => {
    try {
        const from = $('#report-from').value;
        const to = $('#report-to').value;
        if (!from || !to) return toast('Chọn ngày', 'warning');

        const data = await api.get(`/api/reports/overview?from=${from}&to=${to}`);

        $('#rpt-revenue').textContent = fmt(data.revenue);
        $('#rpt-orders').textContent = data.ordersCount;
        $('#rpt-items').textContent = data.totalItems;
        $('#rpt-avg').textContent = fmt(data.avg);

        // Chart
        const byDateArr = Object.entries(data.byDate).map(([date, d]) => ({ date, revenue: d.revenue }));
        renderBarChart('#rpt-chart', byDateArr, 'date', 'revenue');

        // Payment breakdown
        const payEl = $('#rpt-payment');
        const totalPay = Object.values(data.byPayment).reduce((a, b) => a + b, 0) || 1;
        const payColors = { cash: 'var(--success)', transfer: 'var(--info)', card: 'var(--warning)', qr: 'var(--accent)' };
        payEl.innerHTML = Object.entries(data.byPayment).map(([method, amount]) => {
            const pct = (amount / totalPay * 100).toFixed(0);
            return `<div class="payment-bar">
                <span class="label">${paymentLabel(method)}</span>
                <div class="bar-bg"><div class="bar-fg" style="width:${pct}%;background:${payColors[method] || 'var(--primary)'}"></div></div>
                <span class="value">${fmt(amount)}</span>
            </div>`;
        }).join('');

        // Top products
        const prodEl = $('#rpt-products');
        prodEl.innerHTML = (data.topProducts || []).map((p, i) =>
            `<div class="top-item"><span class="rank">${i + 1}</span><span class="name">${p.name}</span><span class="count">${p.qty}</span></div>`
        ).join('') || '<p style="color:var(--text-muted)">Chưa có dữ liệu</p>';

    } catch (err) { toast(err.message, 'error'); }
});

// ===== TAX REPORT PDF =====
$('#tax-export-btn')?.addEventListener('click', async () => {
    const from = $('#tax-from').value || $('#report-from').value;
    const to = $('#tax-to').value || $('#report-to').value;
    if (!from || !to) { toast('Chọn ngày bắt đầu và kết thúc', 'error'); return; }

    try {
        toast('Đang tạo báo cáo...');
        const data = await api.get(`/api/reports/tax?from=${from}&to=${to}`);
        generateTaxPDF(data);
    } catch (err) { toast(err.message, 'error'); }
});

function generateTaxPDF(data) {
    try {
        const shopName = (data.shopName || 'HỘ KINH DOANH CHILL CAFE').toUpperCase();
        const address = data.address || '80/20 Hoàng Hoa Thám, P.7, Bình Thạnh, TP.HCM';
        const taxId = data.taxId || '080180017263';

        const fromDate = new Date(data.from);
        const toDate = new Date(data.to);
        const months = (toDate.getFullYear() * 12 + toDate.getMonth()) - (fromDate.getFullYear() * 12 + fromDate.getMonth()) + 1;
        let period = '';
        if (months <= 3) period = `Quý ${Math.ceil((fromDate.getMonth() + 1) / 3)} năm ${fromDate.getFullYear()}`;
        else if (months <= 6) period = `6 tháng ${fromDate.getMonth() < 6 ? 'đầu' : 'cuối'} năm ${fromDate.getFullYear()}`;
        else period = `Năm ${fromDate.getFullYear()}`;

        const rows = data.daily.map(d => {
            const dt = new Date(d.date);
            return `<tr>
                <td style="text-align:center">${dt.toLocaleDateString('vi-VN')}</td>
                <td>Doanh thu bán hàng (${d.count} đơn)</td>
                <td style="text-align:right">${d.total.toLocaleString('vi-VN')}</td>
            </tr>`;
        }).join('');

        const today = new Date();
        const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Sổ doanh thu ${data.from} - ${data.to}</title>
<style>
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; }
body { font-family: "Times New Roman", Times, serif; font-size: 12pt; color: #000; margin: 0; padding: 0; }
.header { display: flex; gap: 10px; margin-bottom: 18px; }
.header .box { flex: 1; border: 1px solid #000; padding: 6px 10px; min-height: 72px; }
.box .title { font-weight: bold; font-size: 12pt; }
.box .sub { font-size: 10.5pt; margin-top: 3px; }
.box .italic { font-style: italic; font-size: 10pt; }
.right-box { text-align: center; }
.right-box .model { font-weight: bold; font-size: 11.5pt; }
.right-box .ref { font-style: italic; font-size: 10pt; margin-top: 4px; }
h1 { text-align: center; font-size: 15pt; margin: 10px 0 6px; }
.subtitle { text-align: center; font-size: 11.5pt; margin: 4px 0; }
.unit { text-align: right; font-style: italic; font-size: 10.5pt; margin-top: 8px; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
table th, table td { border: 1px solid #000; padding: 6px 8px; font-size: 11.5pt; }
table th { text-align: center; font-weight: bold; background: #f5f5f5; }
table th .code { font-weight: normal; font-size: 10pt; display: block; }
.total-row td { font-weight: bold; text-align: center; }
.total-row td:last-child { text-align: right; }
.signature { margin-top: 24px; width: 50%; margin-left: 50%; text-align: center; }
.signature .date { font-style: italic; font-size: 11pt; margin-bottom: 4px; }
.signature .role { font-weight: bold; font-size: 11.5pt; line-height: 1.3; }
.signature .hint { font-style: italic; font-size: 10pt; margin-top: 4px; }
@media print { .no-print { display: none !important; } }
.no-print { position: fixed; top: 10px; right: 10px; z-index: 999; background: #006064; color: #fff; border: none; padding: 10px 18px; font-size: 13pt; border-radius: 6px; cursor: pointer; font-family: inherit; }
</style></head><body>
<button class="no-print" onclick="window.print()">In / Lưu PDF</button>
<div class="header">
    <div class="box">
        <div class="title">${escapeHtmlSafe(shopName)}</div>
        <div class="sub">Mã số thuế: ${escapeHtmlSafe(taxId)}</div>
        <div class="sub">Địa chỉ: ${escapeHtmlSafe(address)}</div>
    </div>
    <div class="box right-box">
        <div class="model">Mẫu số S1a-HKD</div>
        <div class="ref">(Kèm theo Thông tư số 152/2025/TT-BTC<br>ngày 31 tháng 12 năm 2025 của Bộ trưởng Bộ Tài chính)</div>
    </div>
</div>
<h1>SỔ CHI TIẾT DOANH THU BÁN HÀNG HÓA, DỊCH VỤ</h1>
<div class="subtitle">Địa điểm kinh doanh: ${escapeHtmlSafe(shopName)}</div>
<div class="subtitle">Kỳ kê khai: ${period}</div>
<div class="unit">Đơn vị tính: VNĐ</div>
<table>
    <thead><tr>
        <th style="width:22%">Ngày tháng<span class="code">A</span></th>
        <th>Giao dịch<span class="code">B</span></th>
        <th style="width:22%">Số tiền<span class="code">1</span></th>
    </tr></thead>
    <tbody>
        ${rows}
        <tr class="total-row"><td></td><td>Tổng cộng</td><td>${data.grandTotal.toLocaleString('vi-VN')}</td></tr>
    </tbody>
</table>
<div class="signature">
    <div class="date">Ngày ${today.getDate()} tháng ${today.getMonth() + 1} năm ${today.getFullYear()}</div>
    <div class="role">NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/<br>CÁ NHÂN KINH DOANH</div>
    <div class="hint">(Ký, họ tên, đóng dấu)</div>
</div>
<script>setTimeout(function(){window.print()}, 300);</script>
</body></html>`;

        const w = window.open('', '_blank');
        if (!w) { toast('Trình duyệt chặn popup. Hãy cho phép popup rồi thử lại.', 'error'); return; }
        w.document.open();
        w.document.write(html);
        w.document.close();
        toast('Đã mở trang in. Dùng nút "Lưu PDF" trong hộp thoại in.');
    } catch (e) {
        console.error('PDF error:', e);
        toast('Lỗi tạo báo cáo: ' + e.message, 'error');
    }
}

function escapeHtmlSafe(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== SETTINGS PAGE =====
async function loadSettings() {
    try {
        const s = await api.get('/api/settings');
        $('#set-name').value = s.name || '';
        $('#set-address').value = s.address || '';
        $('#set-phone').value = s.phone || '';
        $('#set-hours').value = s.hours || '';
        $('#set-facebook').value = s.facebook || '';
        $('#set-prefix').value = s.invoice_prefix || 'POS';
        // Bank settings
        $('#set-bank-name').value = s.bank_name || '';
        $('#set-bank-account').value = s.bank_account || '';
        $('#set-bank-owner').value = s.bank_owner || '';
        $('#set-qr-url').value = s.payment_qr_url || '';
        const preview = $('#qr-preview');
        if (s.payment_qr_url) {
            preview.innerHTML = `<img src="${s.payment_qr_url}" style="max-width:180px;border-radius:8px;border:1px solid var(--border)">`;
        } else {
            preview.innerHTML = '';
        }
        // Printer settings
        if ($('#set-printer-ip')) $('#set-printer-ip').value = s.printer_ip || '';
        if ($('#set-printer-port')) $('#set-printer-port').value = s.printer_port || '9100';
        // Geo settings
        if ($('#set-geo-restrict')) $('#set-geo-restrict').value = s.geo_restrict || 'on';
        if ($('#set-geo-radius')) $('#set-geo-radius').value = s.geo_radius || '200';
        if ($('#shop-location-info')) {
            if (s.shop_lat && s.shop_lng) {
                $('#shop-location-info').innerHTML = `<svg class="ico" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Vị trí quán: ${parseFloat(s.shop_lat).toFixed(6)}, ${parseFloat(s.shop_lng).toFixed(6)}`;
                if ($('#set-shop-lat')) $('#set-shop-lat').value = s.shop_lat;
                if ($('#set-shop-lng')) $('#set-shop-lng').value = s.shop_lng;
            } else {
                $('#shop-location-info').innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><path d="M12 17h.01"/></svg> Chưa thiết lập vị trí quán';
            }
        }
    } catch (err) { toast(err.message, 'error'); }
}

$('#printer-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api.post('/api/settings/printer', {
            printer_ip: $('#set-printer-ip').value,
            printer_port: $('#set-printer-port').value || '9100',
        });
        App.bankSettings = await api.get('/api/settings');
        App.settings = App.bankSettings;
        toast('Đã lưu cài đặt máy in');
    } catch (err) { toast(err.message, 'error'); }
});

$('#test-print-btn')?.addEventListener('click', async () => {
    const ip = $('#set-printer-ip')?.value;
    const port = $('#set-printer-port')?.value || '9100';
    if (!ip) { toast('Nhập IP máy in trước', 'error'); return; }
    try {
        const res = await api.post('/api/printer/test', { ip, port });
        if (res.success) toast(res.message || 'In thử thành công!');
    } catch (err) { toast(err.message || 'Lỗi kết nối máy in', 'error'); }
});

$('#set-shop-location-btn')?.addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Trình duyệt không hỗ trợ GPS', 'error'); return; }
    toast('Đang lấy vị trí...');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            $('#set-shop-lat').value = pos.coords.latitude.toFixed(6);
            $('#set-shop-lng').value = pos.coords.longitude.toFixed(6);
            $('#shop-location-info').innerHTML = `<svg class="ico" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg> Vị trí mới: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)} (chưa lưu)`;
            toast('Đã lấy vị trí! Bấm "Lưu" để áp dụng.');
        },
        (err) => { toast('Không lấy được vị trí: ' + err.message, 'error'); },
        { timeout: 10000, enableHighAccuracy: true }
    );
});

$('#geo-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const data = {
            geo_restrict: $('#set-geo-restrict').value,
            geo_radius: $('#set-geo-radius').value || '200',
        };
        const lat = $('#set-shop-lat')?.value;
        const lng = $('#set-shop-lng')?.value;
        if (lat && lng) {
            data.shop_lat = lat;
            data.shop_lng = lng;
        }
        await api.put('/api/settings', data);
        loadSettings();
        toast('Đã lưu cài đặt vị trí');
    } catch (err) { toast(err.message, 'error'); }
});

$('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api.put('/api/settings', {
            name: $('#set-name').value,
            address: $('#set-address').value,
            phone: $('#set-phone').value,
            hours: $('#set-hours').value,
            facebook: $('#set-facebook').value,
            invoice_prefix: $('#set-prefix').value,
        });
        toast('Đã lưu cài đặt');
    } catch (err) { toast(err.message, 'error'); }
});

$('#bank-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api.put('/api/settings', {
            bank_name: $('#set-bank-name').value,
            bank_account: $('#set-bank-account').value,
            bank_owner: $('#set-bank-owner').value,
            payment_qr_url: $('#set-qr-url').value,
        });
        toast('Đã lưu thông tin thanh toán');
        // Update preview
        const url = $('#set-qr-url').value;
        $('#qr-preview').innerHTML = url ? `<img src="${url}" style="max-width:180px;border-radius:8px;border:1px solid var(--border)">` : '';
    } catch (err) { toast(err.message, 'error'); }
});

$('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api.put('/api/auth/password', {
            oldPassword: $('#pw-old').value,
            newPassword: $('#pw-new').value,
            confirmPassword: $('#pw-confirm').value,
        });
        toast('Đã đổi mật khẩu');
        $('#pw-old').value = '';
        $('#pw-new').value = '';
        $('#pw-confirm').value = '';
    } catch (err) { toast(err.message, 'error'); }
});

// ===== GENERIC FORM MODAL =====
let formModalCallback = null;

function showFormModal(title, fields, onSave) {
    formModalCallback = onSave;
    $('#modal-form-title').textContent = title;
    const body = $('#modal-form-body');
    body.innerHTML = fields.map(f => {
        let input;
        if (f.type === 'select') {
            input = `<select id="form-${f.key}" name="${f.key}">${f.options.map(([v, l]) =>
                `<option value="${v}" ${f.value === v ? 'selected' : ''}>${l}</option>`
            ).join('')}</select>`;
        } else if (f.type === 'textarea') {
            input = `<textarea id="form-${f.key}" name="${f.key}" rows="3">${f.value || ''}</textarea>`;
        } else {
            input = `<input type="${f.type}" id="form-${f.key}" name="${f.key}" value="${f.value !== undefined ? f.value : ''}" ${f.required ? 'required' : ''}>`;
        }
        return `<div class="form-group"><label>${f.label}</label>${input}</div>`;
    }).join('');

    // Store field keys for retrieval
    body.dataset.fields = JSON.stringify(fields.map(f => f.key));
    openModal('modal-form');
}

$('#modal-form-save').addEventListener('click', async () => {
    if (!formModalCallback) return;
    const fields = JSON.parse($('#modal-form-body').dataset.fields || '[]');
    const data = {};
    for (const key of fields) {
        const el = $(`#form-${key}`);
        if (el) data[key] = el.value;
    }
    try {
        await formModalCallback(data);
        closeModal('modal-form');
    } catch (err) {
        toast(err.message, 'error');
    }
});

// ===== INIT =====
checkAuth();
