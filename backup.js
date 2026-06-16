// POS — hot backup of ALL SQLite databases in data/ (run daily via scheduled task)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
const backupDir = path.join(dataDir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const RETAIN_DAYS = 14;

(async () => {
  const files = fs.readdirSync(dataDir).filter(f => f.toLowerCase().endsWith('.db'));
  for (const name of files) {
    const src = path.join(dataDir, name);
    let st; try { st = fs.statSync(src); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;           // skip empty placeholder DBs
    const dest = path.join(backupDir, name.replace(/\.db$/i, `_${stamp}.db`));
    const db = new Database(src, { readonly: true });
    try { await db.backup(dest); console.log('OK backup', name, '->', path.basename(dest)); }
    catch (e) { console.error('FAIL', name, e.message); }
    finally { db.close(); }
  }
  const sk = path.join(dataDir, 'session_secret.key');
  if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(backupDir, `session_secret_${stamp}.key`));

  const cutoff = Date.now() - RETAIN_DAYS * 86400000;
  for (const f of fs.readdirSync(backupDir)) {
    const fp = path.join(backupDir, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); console.log('pruned', f); } } catch {}
  }
  console.log('backup done', stamp);
})().catch(e => { console.error('BACKUP FAILED', e); process.exit(1); });
