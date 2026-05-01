// ===== INDEXEDDB LAYER =====
// 取代 server.js 的所有檔案 I/O，純前端離線儲存

const DB_NAME = 'kb_db';
const DB_VERSION = 2;   // v2: 加入 images 存儲

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'username' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function dbOp(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function extractExcerpt(body) {
  return body
    .replace(/#{1,6}\s/g, '')
    .replace(/[*_`\[\]]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ===== NOTE OPERATIONS =====

async function db_getAllNotes() {
  const notes = await dbOp('notes', 'readonly', s => s.getAll());
  return notes
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, tags, date, excerpt }) => ({ id, title, tags, date, excerpt }));
}

async function db_getNote(id) {
  return dbOp('notes', 'readonly', s => s.get(id));
}

async function db_createNote(title) {
  const id = genId();
  const today = new Date().toISOString().split('T')[0];
  const content = `---\ntitle: ${title}\ntags: []\ndate: ${today}\n---\n`;
  const note = { id, title, tags: [], date: today, excerpt: '', content, updatedAt: Date.now() };
  await dbOp('notes', 'readwrite', s => s.put(note));
  return note;
}

async function db_saveNote(id, content) {
  const existing = await db_getNote(id);
  // parseFrontmatter 在 app.js 中定義，執行時已可用
  const { frontmatter, body } = parseFrontmatter(content);
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const note = {
    ...(existing || {}),
    id,
    title: frontmatter.title || existing?.title || '未命名',
    tags,
    date: frontmatter.date || existing?.date || new Date().toISOString().split('T')[0],
    excerpt: extractExcerpt(body),
    content,
    updatedAt: Date.now(),
  };
  await dbOp('notes', 'readwrite', s => s.put(note));
  return note;
}

async function db_saveNoteWithSource(id, content, vaultSource) {
  const note = await db_saveNote(id, content);
  const updated = { ...note, vaultSource };
  await dbOp('notes', 'readwrite', s => s.put(updated));
  return updated;
}

async function db_deleteNote(id) {
  return dbOp('notes', 'readwrite', s => s.delete(id));
}

async function db_getNotesBySource(source) {
  const notes = await dbOp('notes', 'readonly', s => s.getAll());
  return notes.filter(n => n.vaultSource === source);
}

// ===== USER OPERATIONS =====

async function db_getAllUsers() {
  return dbOp('users', 'readonly', s => s.getAll());
}

async function db_putUser(user) {
  return dbOp('users', 'readwrite', s => s.put(user));
}

// ===== IMAGE OPERATIONS =====

async function db_storeImage(filename, dataUrl) {
  const id = genId();
  await dbOp('images', 'readwrite', s => s.put({ id, filename, dataUrl }));
  return id;
}

async function db_storeImageWithId(id, filename, dataUrl) {
  await dbOp('images', 'readwrite', s => s.put({ id, filename, dataUrl }));
  return id;
}

async function db_getImage(id) {
  return dbOp('images', 'readonly', s => s.get(id));
}

async function db_getImages(ids) {
  if (!ids.length) return [];
  return Promise.all(ids.map(id => db_getImage(id)));
}
