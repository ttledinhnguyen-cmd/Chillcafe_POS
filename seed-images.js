const Database = require('better-sqlite3');
const db = new Database('data/chill.db');

const BASE = 'https://images.unsplash.com/photo-';
const Q = '?w=600&q=80&auto=format&fit=crop';

// Category-level defaults (fallback)
const CATEGORY_DEFAULT = {
    coffee: BASE + '1509042239860-f550ce710b93' + Q,
    tea: BASE + '1556679343-c7306c1976bc' + Q,
    smoothie: BASE + '1553530666-ba11a7da3888' + Q,
    juice: BASE + '1613478223719-2ab802602423' + Q,
    soda: BASE + '1544145945-f90425340c7e' + Q,
    yogurt: BASE + '1488477181946-6428a0291777' + Q,
    tra_sua: BASE + '1558857563-b371033873b8' + Q,
    do_an: BASE + '1576092768241-dec231879fc3' + Q,
    nuoc_ngot: BASE + '1624552184280-9e9631bbeee9' + Q,
    topping: BASE + '1497534446932-c925b458314e' + Q,
    other: BASE + '1497534446932-c925b458314e' + Q,
};

const IMAGES = {
    // Coffee
    'Cà Phê Đen': BASE + '1509042239860-f550ce710b93' + Q,
    'Cà Phê Sữa': BASE + '1568649929103-28ffbefaca1e' + Q,
    'Bạc Xỉu': BASE + '1461023058943-07fcbe16d735' + Q,
    'Cacao Sữa': BASE + '1572442388796-11668a67e53d' + Q,
    'Cappuchino/Latte': BASE + '1572442388796-11668a67e53d' + Q,
    'Cà Phê Muối': BASE + '1485808191679-5f86510681a2' + Q,

    // Đồ ăn
    'Bò Viên': BASE + '1576092768241-dec231879fc3' + Q,
    'Cá Viên': BASE + '1576092768241-dec231879fc3' + Q,
    'Khoai Tây Chiên': BASE + '1573080496219-bb080dd4f877' + Q,
    'Phô Mai Que': BASE + '1541592106381-b31e9677c0e5' + Q,
    'Tôm Viên': BASE + '1576092768241-dec231879fc3' + Q,
    'Xúc Xích': BASE + '1612392062631-94dd858cba88' + Q,
    'combo 1': BASE + '1576092768241-dec231879fc3' + Q,
    'combo 2': BASE + '1576092768241-dec231879fc3' + Q,

    // Juice (Nước ép)
    'Cam Ép': BASE + '1613478223719-2ab802602423' + Q,
    'Nước Chanh': BASE + '1556679343-c7306c1976bc' + Q,
    'Nước Ép Chanh Dây': BASE + '1601001815894-4bb6c81416d7' + Q,
    'Ép Cà Chua': BASE + '1600271886742-f049cd451bba' + Q,
    'Ép Dưa Hấu': BASE + '1587049352846-4a222e784d38' + Q,
    'Ép Thơm': BASE + '1545665277-5937489579f2' + Q,
    'Ép táo': BASE + '1619158401201-8fa932695178' + Q,
    'Ép Ổi': BASE + '1613478223719-2ab802602423' + Q,

    // Nuoc ngot
    'Bò Húc/yến': BASE + '1624552184280-9e9631bbeee9' + Q,
    'Coca/sting': BASE + '1624552184280-9e9631bbeee9' + Q,
    'Dừa Tươi': BASE + '1615484477778-ca3b77940c25' + Q,
    'Nước Suối': BASE + '1548839140-29a749e1cf4d' + Q,
    'Trà Xanh': BASE + '1556679343-c7306c1976bc' + Q,
    'bí đao/nuti': BASE + '1624552184280-9e9631bbeee9' + Q,
    'number/revive': BASE + '1624552184280-9e9631bbeee9' + Q,

    // Other
    'Kem': BASE + '1497534446932-c925b458314e' + Q,
    'Sữa Đá Me': BASE + '1461023058943-07fcbe16d735' + Q,
    'Đá Me': BASE + '1556679343-c7306c1976bc' + Q,

    // Smoothie
    'Chanh Tuyết': BASE + '1556679343-c7306c1976bc' + Q,
    'Coffee Caramel Đá Xay': BASE + '1497534446932-c925b458314e' + Q,
    'Cookies Đá Xay': BASE + '1497534446932-c925b458314e' + Q,
    'Matcha Đá Xay': BASE + '1536256263959-770b48d82b0a' + Q,
    'Sinh Tố Bơ': BASE + '1546173159-315724a31696' + Q,
    'Sinh Tố Chanh Dây': BASE + '1601001815894-4bb6c81416d7' + Q,
    'Sinh Tố Chuối': BASE + '1587049352846-4a222e784d38' + Q,
    'Sinh Tố Dâu': BASE + '1553530666-ba11a7da3888' + Q,
    'Sinh Tố Mãng Cầu': BASE + '1546173159-315724a31696' + Q,
    'Sinh Tố Sapoche': BASE + '1546173159-315724a31696' + Q,
    'Sinh Tố Thập Cẩm': BASE + '1553530666-ba11a7da3888' + Q,
    'Sinh Tố Xoài': BASE + '1623065422902-30a2d299bbe4' + Q,
    'Socola Đá Xay': BASE + '1619158401201-8fa932695178' + Q,
    'Sữa Đá Chanh': BASE + '1556679343-c7306c1976bc' + Q,

    // Soda
    'Soda Blue Curacao': BASE + '1544145945-f90425340c7e' + Q,
    'Soda Bạc Hà': BASE + '1544145945-f90425340c7e' + Q,
    'Soda Chanh': BASE + '1544145945-f90425340c7e' + Q,
    'Soda Chanh Dây': BASE + '1544145945-f90425340c7e' + Q,
    'Soda Dâu': BASE + '1553530666-ba11a7da3888' + Q,
    'Soda Kiwi': BASE + '1544145945-f90425340c7e' + Q,
    'Soda Việt Quất': BASE + '1544145945-f90425340c7e' + Q,
    'Soda Xoài': BASE + '1623065422902-30a2d299bbe4' + Q,

    // Tea
    'Hồng Trà Chanh': BASE + '1556679343-c7306c1976bc' + Q,
    'Hồng Trà Foam Milk': BASE + '1558857563-b371033873b8' + Q,
    'Lipton Cam Mật Ong': BASE + '1613478223719-2ab802602423' + Q,
    'Lipton Nóng/Đá': BASE + '1558857563-b371033873b8' + Q,
    'Trà Gừng Mật Ong': BASE + '1576092768241-dec231879fc3' + Q,
    'Trà Đào': BASE + '1541807084-5c52b6b3adef' + Q,
    'Trà Đào Chanh Dây': BASE + '1541807084-5c52b6b3adef' + Q,
    'Trà Đào Chanh Sả': BASE + '1541807084-5c52b6b3adef' + Q,
    'oolong nóng/đá': BASE + '1556679343-c7306c1976bc' + Q,

    // Topping
    '3Q': BASE + '1497534446932-c925b458314e' + Q,
    'TC đen': BASE + '1558857563-b371033873b8' + Q,
    'hạt đác': BASE + '1497534446932-c925b458314e' + Q,

    // Trà sữa
    'Matcha Latte': BASE + '1536256263959-770b48d82b0a' + Q,
    'Sữa Nóng': BASE + '1461023058943-07fcbe16d735' + Q,
    'Sữa Tươi': BASE + '1461023058943-07fcbe16d735' + Q,
    'Sữa Tươi Trân Châu Đường Đen': BASE + '1558857563-b371033873b8' + Q,
    'TS Dâu ': BASE + '1553530666-ba11a7da3888' + Q,
    'TS Dâu': BASE + '1553530666-ba11a7da3888' + Q,
    'TS bạc hà': BASE + '1558857563-b371033873b8' + Q,
    'TS socola': BASE + '1619158401201-8fa932695178' + Q,
    'TS việt quất': BASE + '1558857563-b371033873b8' + Q,
    'Trà Sữa Không Trân Châu': BASE + '1558857563-b371033873b8' + Q,
    'Trà Sữa Trân Châu': BASE + '1558857563-b371033873b8' + Q,

    // Yogurt
    'Yogurt Chanh Dây': BASE + '1488477181946-6428a0291777' + Q,
    'Yogurt Dâu': BASE + '1488477181946-6428a0291777' + Q,
    'Yogurt Hạt Đác': BASE + '1488477181946-6428a0291777' + Q,
    'Yogurt Kiwi': BASE + '1488477181946-6428a0291777' + Q,
    'Yogurt Việt Quất': BASE + '1488477181946-6428a0291777' + Q,
    'Yogurt Xoài': BASE + '1488477181946-6428a0291777' + Q,
    'hũ sữa chua': BASE + '1488477181946-6428a0291777' + Q,
    'yogurt đá': BASE + '1488477181946-6428a0291777' + Q,
};

const update = db.prepare('UPDATE menu SET image_url = ? WHERE id = ?');
const items = db.prepare('SELECT id, name, category FROM menu').all();
let updated = 0, used = [];

for (const item of items) {
    const key = item.name.trim();
    let url = IMAGES[item.name] || IMAGES[key];
    if (!url && CATEGORY_DEFAULT[item.category]) url = CATEGORY_DEFAULT[item.category];
    if (url) {
        update.run(url, item.id);
        updated++;
    } else {
        used.push(item.name + ' (' + item.category + ')');
    }
}

console.log(`Updated ${updated}/${items.length} items.`);
if (used.length) console.log('No image:', used);
