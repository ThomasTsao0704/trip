const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = 3000;
const VAULT_DIR = path.join(__dirname, 'vault');
const IMAGES_DIR = path.join(VAULT_DIR, 'images');

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// Ensure vault/images directory exists
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ===== API STATUS =====
app.get('/api/status', (req, res) => {
  res.json({ ok: true });
});

// ===== SAVE NOTE =====
app.post('/api/save', (req, res) => {
  try {
    const { path: notePath, content } = req.body;
    if (!notePath || typeof content !== 'string') {
      return res.json({ ok: false, error: '參數錯誤' });
    }
    // Security: only allow saving inside vault/
    const resolved = path.resolve(__dirname, notePath);
    if (!resolved.startsWith(path.resolve(VAULT_DIR))) {
      return res.json({ ok: false, error: '路徑不合法' });
    }
    fs.writeFileSync(resolved, content, 'utf8');
    // Rebuild index
    try { execSync('node build-index.js', { cwd: __dirname }); } catch {}
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== NEW NOTE =====
app.post('/api/new', (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.json({ ok: false, error: '請提供標題' });

    const safeName = title
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 80);
    const filename = safeName + '.md';
    const filePath = path.join(VAULT_DIR, filename);

    if (fs.existsSync(filePath)) {
      return res.json({ ok: false, error: '已有同名筆記' });
    }

    const today = new Date().toISOString().split('T')[0];
    const content = `---\ntitle: ${title}\ntags: []\ndate: ${today}\n---\n`;
    fs.writeFileSync(filePath, content, 'utf8');

    try { execSync('node build-index.js', { cwd: __dirname }); } catch {}

    res.json({ ok: true, path: `vault/${filename}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== IMAGE UPLOAD =====
app.post('/api/upload', (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!filename || !data) return res.json({ ok: false, error: '參數錯誤' });

    const ext = path.extname(filename).toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif'];
    if (!allowed.includes(ext)) {
      return res.json({ ok: false, error: '不支援的圖片格式' });
    }

    const safeName = path.basename(filename)
      .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
    const destPath = path.join(IMAGES_DIR, safeName);

    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(destPath, buf);

    res.json({ ok: true, path: `vault/images/${safeName}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Knowledge Base server running at http://localhost:${PORT}`);
});
