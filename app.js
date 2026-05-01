// ===== CONFIG =====
const SESSION_KEY = 'kb_session';

// ===== IMAGE CACHE =====
// kb-image://id → dataUrl（記憶體快取，避免每次都查 IndexedDB）
const imageCache = new Map();

async function preloadImages(content) {
  const ids = [...new Set(
    [...(content || '').matchAll(/kb-image:\/\/([a-zA-Z0-9]+)/g)].map(m => m[1])
  )];
  if (!ids.length) return;
  const imgs = await db_getImages(ids);
  imgs.forEach(img => { if (img) imageCache.set(img.id, img.dataUrl); });
}

// ===== STATE =====
const state = {
  user: null,
  notes: [],
  tags: [],
  activeTag: null,
  activeNoteId: null,
  editMode: false,
  searchFocusIndex: -1,
  searchResults: [],
  fuse: null,
};

// ===== CRYPTO =====
async function sha256(str) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===== AUTH =====

// 依序嘗試：users.json → IndexedDB → 預設帳號
async function findUser(username, hash) {
  // 1. 嘗試從 users.json 讀取（有 HTTP 伺服器時有效）
  try {
    const users = await fetch('users.json', { cache: 'no-store' }).then(r => r.json());
    const found = users.find(u => u.username === username && u.hash === hash);
    if (found) return found;
    // users.json 存在但找不到此帳號，不繼續 fallback
    if (users.length > 0) return null;
  } catch { /* 離線或 file:// 無法讀取，繼續 fallback */ }

  // 2. 從 IndexedDB 讀取已儲存的帳號
  const dbUsers = await db_getAllUsers();
  if (dbUsers.length > 0) {
    return dbUsers.find(u => u.username === username && u.hash === hash) || null;
  }

  // 3. 首次使用：自動建立預設帳號 admin / admin123
  const defaultHash = await sha256('admin123');
  const defaultUser = { username: 'admin', hash: defaultHash, displayName: '管理員' };
  await db_putUser(defaultUser);
  if (username === 'admin' && hash === defaultHash) return defaultUser;
  return null;
}

async function doLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginSubmitBtn');

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '登入中...';

  try {
    const hash = await sha256(password);
    const user = await findUser(username, hash);

    if (user) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        username: user.username,
        displayName: user.displayName || user.username,
        loginAt: Date.now(),
      }));
      await initApp(user);
    } else {
      errEl.textContent = '帳號或密碼錯誤';
      btn.disabled = false;
      btn.textContent = '登入';
    }
  } catch {
    errEl.textContent = '登入失敗，請稍後再試';
    btn.disabled = false;
    btn.textContent = '登入';
  }
}

function doLogout() {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}

// ===== DATA =====
async function loadIndex() {
  try {
    const notes = await db_getAllNotes();
    const tags = [...new Set(notes.flatMap(n => n.tags || []))].sort();
    return { notes, tags };
  } catch {
    return { notes: [], tags: [] };
  }
}

async function reloadIndex() {
  const data = await loadIndex();
  state.notes = data.notes || [];
  state.tags = data.tags || [];
  state.fuse = state.notes.length > 0 ? buildFuseIndex(state.notes) : null;
  renderTagList();
  renderNoteList();
}

function buildFuseIndex(notes) {
  return new Fuse(notes, {
    keys: [
      { name: 'title', weight: 0.5 },
      { name: 'tags', weight: 0.3 },
      { name: 'excerpt', weight: 0.2 },
    ],
    threshold: 0.4,
    includeMatches: true,
    minMatchCharLength: 1,
    ignoreLocation: true,
  });
}

// ===== SIDEBAR RENDER =====
function renderTagList() {
  const el = document.getElementById('tagList');
  if (!state.tags.length) {
    el.innerHTML = '<span style="font-size:0.75rem;color:#a1a1aa;padding:0 4px">暫無標籤</span>';
    return;
  }
  const counts = {};
  state.notes.forEach(n => (n.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  el.innerHTML = state.tags.map(tag => {
    const active = state.activeTag === tag ? 'active' : '';
    return `<button class="tag-chip ${active}" onclick="toggleTag('${esc(tag)}')">${esc(tag)} <span class="count">${counts[tag] || 0}</span></button>`;
  }).join('');
}

function renderNoteList() {
  const el = document.getElementById('noteList');
  const notes = state.activeTag
    ? state.notes.filter(n => (n.tags || []).includes(state.activeTag))
    : state.notes;

  if (!notes.length) {
    const msg = state.activeTag
      ? `沒有「${esc(state.activeTag)}」的筆記`
      : '點右上角「新增」建立第一篇筆記';
    el.innerHTML = `<div style="padding:16px 10px;color:#a1a1aa;font-size:0.8rem;text-align:center">${msg}</div>`;
    return;
  }

  el.innerHTML = notes.map(note => {
    const active = state.activeNoteId === note.id ? 'active' : '';
    const tagsHtml = (note.tags || []).slice(0, 3)
      .map(t => `<span class="note-item-tag">${esc(t)}</span>`).join('');
    return `<div class="note-item ${active}" data-id="${esc(note.id)}" onclick="openNote('${esc(note.id)}')">
      <div class="note-item-title">${esc(note.title)}</div>
      ${tagsHtml ? `<div class="note-item-tags">${tagsHtml}</div>` : ''}
    </div>`;
  }).join('');
}

// ===== NOTE VIEWER =====
async function openNote(id) {
  if (state.editMode) exitEditMode(false);

  state.activeNoteId = id;
  const note = state.notes.find(n => n.id === id);
  if (!note) return;

  document.querySelectorAll('.note-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  const content = document.getElementById('noteContent');
  content.innerHTML = '<div class="note-loading">載入中...</div>';

  document.getElementById('editNoteBtn').classList.remove('hidden');
  document.getElementById('deleteNoteBtn').classList.remove('hidden');

  try {
    const fullNote = await db_getNote(id);
    const md = fullNote?.content || '';
    await preloadImages(md);
    const { body } = parseFrontmatter(md);
    const htmlRaw     = parseAndRenderMd(body);
    const htmlWithIds = addHeadingIds(htmlRaw);
    const tocHtml     = generateToc(htmlWithIds);

    const tagsHtml = (note.tags || []).map(t =>
      `<span class="note-header-tag">${esc(t)}</span>`
    ).join('');
    const dateHtml = note.date ? `<span class="note-header-date">${esc(note.date)}</span>` : '';

    content.innerHTML = `
      <div class="note-header">
        <h1>${esc(note.title)}</h1>
        ${(tagsHtml || dateHtml) ? `<div class="note-header-meta">${tagsHtml}${dateHtml}</div>` : ''}
      </div>
      ${tocHtml}
      <div class="note-body">${htmlWithIds}</div>
    `;

    if (tocHtml) {
      initTocScrollSpy();
      initTocControls();
    }
  } catch {
    content.innerHTML = '<div class="empty-state"><p>無法載入筆記内容</p></div>';
  }

  closeSearch();
  if (window.innerWidth <= 768) closeSidebar();
}

// ===== EDIT MODE =====
async function openEditorForNote() {
  const note = state.notes.find(n => n.id === state.activeNoteId);
  if (!note) return;

  const fullNote = await db_getNote(note.id);
  await preloadImages(fullNote?.content || '');
  const { frontmatter, body } = parseFrontmatter(fullNote?.content || '');

  const tagsArr = Array.isArray(frontmatter.tags)
    ? frontmatter.tags
    : (frontmatter.tags ? [frontmatter.tags] : note.tags || []);

  enterEditMode({
    title: frontmatter.title || note.title,
    tags: tagsArr.join(', '),
    body,
    noteName: note.title,
  });
}

function enterEditMode({ title = '', tags = '', body = '', noteName = '' } = {}) {
  state.editMode = true;
  document.getElementById('viewTopbar').classList.add('hidden');
  document.getElementById('editTopbar').classList.remove('hidden');
  document.getElementById('editNoteNameLabel').textContent = noteName;

  // Inject inline editor directly into the note content area
  const content = document.getElementById('noteContent');
  content.innerHTML = `
    <div class="inline-editor">
      <input type="text" class="inline-title-input" id="editorTitle"
             placeholder="筆記標題..." value="${esc(title)}">
      <div class="inline-editor-meta">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:#a1a1aa;flex-shrink:0"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        <input type="text" class="inline-tags-input" id="editorTags"
               placeholder="標籤（逗號分隔）" value="${esc(tags)}">
      </div>
      <div class="inline-toolbar">
        <button class="toolbar-btn" id="insertImageBtn" title="插入圖片（支援拖曳、貼上）">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          圖片
        </button>
        <button class="toolbar-btn" id="insertCardBtn" title="插入卡片摘要">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="3"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="7" y1="14" x2="14" y2="14"/></svg>
          卡片
        </button>
        <button class="toolbar-btn" id="insertLinkBtn" title="插入筆記連結 [[...]]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          連結
        </button>
        <button class="toolbar-btn" id="insertDialogBtn" title="插入對話框">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          對話
        </button>
        <span class="toolbar-upload-status" id="uploadStatus"></span>
        <span class="toolbar-hint">拖曳或貼上圖片也可插入</span>
      </div>
      <textarea class="inline-textarea" id="editorTextarea"
                placeholder="在此輸入 Markdown..." spellcheck="false"></textarea>
      <input type="file" id="imageFileInput" accept="image/*" style="display:none">
    </div>
  `;

  const ta = document.getElementById('editorTextarea');
  ta.value = body;

  // Auto-resize textarea to content height
  const autoResize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.max(400, ta.scrollHeight) + 'px';
  };
  ta.addEventListener('input', () => { autoResize(); updatePreview(ta.value); });
  autoResize();
  updatePreview(body);   // 初始即渲染預覽

  setupImageUpload();
  ta.focus();
}

function exitEditMode(reload = true) {
  state.editMode = false;
  document.getElementById('editTopbar').classList.add('hidden');
  document.getElementById('viewTopbar').classList.remove('hidden');
  document.getElementById('saveStatus').textContent = '';
  if (reload && state.activeNoteId) {
    openNote(state.activeNoteId);
  } else {
    document.getElementById('noteContent').innerHTML = `
      <div class="welcome">
        <div class="welcome-icon">🔍</div>
        <h2>歡迎使用 Knowledge Base</h2>
        <p>按 <kbd>Ctrl+K</kbd> 或 <kbd>/</kbd> 開始搜尋<br>或從左側選擇筆記</p>
      </div>`;
  }
}

async function saveNote() {
  if (!state.activeNoteId) return;

  const title = document.getElementById('editorTitle').value.trim();
  const tagsRaw = document.getElementById('editorTags').value;
  const body = document.getElementById('editorTextarea').value;
  const tagsArr = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
  const tagsYaml = tagsArr.length ? '[' + tagsArr.join(', ') + ']' : '[]';

  const note = state.notes.find(n => n.id === state.activeNoteId);
  const date = note?.date || new Date().toISOString().split('T')[0];
  const content = `---\ntitle: ${title}\ntags: ${tagsYaml}\ndate: ${date}\n---\n${body}`;

  const btn = document.getElementById('saveNoteBtn');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  status.textContent = '儲存中...';

  try {
    await db_saveNote(state.activeNoteId, content);
    status.textContent = '已儲存 ✓';
    await reloadIndex();
    setTimeout(() => exitEditMode(true), 600);
  } catch {
    status.textContent = '儲存失敗';
  } finally {
    btn.disabled = false;
  }
}

// ===== TOC MODULE =====
let _tocScrollCleanup = null;

function addHeadingIds(html) {
  const seen = {};
  return html.replace(/<(h[1-3])([^>]*)>([\s\S]*?)<\/h[1-3]>/gi, (match, tag, attrs, content) => {
    if (/\bid=/.test(attrs)) return match; // already has id
    const text = content.replace(/<[^>]+>/g, '').trim();
    let base = text.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 60) || tag;
    let id = base, n = 1;
    while (seen[id]) id = base + '-' + (n++);
    seen[id] = true;
    return `<${tag} id="${id}"${attrs}>${content}</${tag}>`;
  });
}

function generateToc(html) {
  const headings = [];
  const re = /<h([1-3])[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    headings.push({ level: +m[1], id: m[2], text: m[3].replace(/<[^>]+>/g, '').trim() });
  }
  if (headings.length < 2) return '';

  const minLv = Math.min(...headings.map(h => h.level));
  const items = headings.map(h =>
    `<div class="toc-item" style="padding-left:${(h.level - minLv) * 14}px">
      <a href="#${encodeURIComponent(h.id)}" class="toc-link">${esc(h.text)}</a>
    </div>`
  ).join('');

  return `<div class="note-toc" id="noteToc">
    <div class="note-toc-header" id="tocHeader">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
      目錄
      <button class="note-toc-toggle" id="tocToggle" title="折疊">▾</button>
    </div>
    <div class="note-toc-body" id="tocBody">${items}</div>
  </div>`;
}

function initTocScrollSpy() {
  if (_tocScrollCleanup) { _tocScrollCleanup(); _tocScrollCleanup = null; }

  const container = document.getElementById('noteContent');
  const links = Array.from(document.querySelectorAll('.toc-link'));
  if (!links.length) return;

  const headings = links.map(a => {
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    return { a, el: document.getElementById(id) };
  }).filter(h => h.el);

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const top = container.getBoundingClientRect().top;
      let current = headings[0];
      for (const h of headings) {
        if (h.el.getBoundingClientRect().top - top <= 60) current = h;
      }
      links.forEach(a => a.classList.remove('active'));
      if (current) current.a.classList.add('active');
      ticking = false;
    });
  }

  container.addEventListener('scroll', onScroll, { passive: true });
  _tocScrollCleanup = () => container.removeEventListener('scroll', onScroll);
  onScroll();
}

function initTocControls() {
  // Collapse toggle
  document.getElementById('tocToggle')?.addEventListener('click', () => {
    const body = document.getElementById('tocBody');
    const btn  = document.getElementById('tocToggle');
    const collapsed = body.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▸' : '▾';
  });

  // Smooth scroll to heading (inside #noteContent, not window)
  document.querySelectorAll('.toc-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      const target = document.getElementById(id);
      if (!target) return;
      const container = document.getElementById('noteContent');
      const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
      container.scrollBy({ top: offset, behavior: 'smooth' });
    });
  });
}

// ===== CARD MODULE =====
// Syntax inside notes:
//   :::card
//   title: 標題
//   url: https://example.com
//   ---
//   - 重點一
//   - 重點二
//   :::

function parseCardBlock(inner) {
  let title = '', url = '', width = '', body = inner.trim();
  const sepIdx = inner.indexOf('\n---\n');
  if (sepIdx !== -1) {
    const meta = inner.slice(0, sepIdx);
    body = inner.slice(sepIdx + 5).trim();
    meta.split('\n').forEach(line => {
      const m = line.match(/^(title|url|width):\s*(.*)$/);
      if (!m) return;
      if (m[1] === 'title') title = m[2].trim();
      if (m[1] === 'url')   url   = m[2].trim();
      if (m[1] === 'width') width = m[2].trim();
    });
  }
  return { title, url, width, body };
}

function renderCard(card, idx) {
  const { title, url, width, body } = card;
  const isValidUrl = url && /^https?:\/\//i.test(url);
  const styleAttr = width ? ` style="width:${width}"` : '';
  const idxAttr   = idx != null ? ` data-card-idx="${idx}"` : '';

  let headerHtml = '';
  if (title) {
    const inner = isValidUrl
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="note-card-title-link">${esc(title)}</a>`
      : `<span>${esc(title)}</span>`;
    headerHtml = `<div class="note-card-header">${inner}</div>`;
  }
  const urlHtml = isValidUrl
    ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="note-card-url">${esc(url)}</a>`
    : '';
  const bodyHtml = body ? marked.parse(body) : '';

  return `<div class="note-card"${idxAttr}${styleAttr}>
    ${headerHtml}
    ${!title && urlHtml ? urlHtml : ''}
    ${title  && urlHtml ? urlHtml : ''}
    ${bodyHtml ? `<div class="note-card-body">${bodyHtml}</div>` : ''}
  </div>`;
}

// 在 marked 處理前，把 kb-image://id 轉成真實 <img> HTML
// 這樣 marked 看到的是 HTML tag，不會誤判成文字
function resolveKbImages(md) {
  // markdown 語法：![alt](kb-image://id)
  let out = md.replace(/!\[([^\]]*)\]\(kb-image:\/\/([a-zA-Z0-9]+)\)/g, (match, alt, id) => {
    const dataUrl = imageCache.get(id);
    if (!dataUrl) return match;
    const safeAlt = alt.replace(/"/g, '&quot;');
    return `<img src="${dataUrl}" data-kb-ref="kb-image://${id}" alt="${safeAlt}">`;
  });
  // HTML 語法（已調整尺寸的圖片）：<img src="kb-image://id" ...>
  out = out.replace(/src="kb-image:\/\/([a-zA-Z0-9]+)"/g, (match, id) => {
    const dataUrl = imageCache.get(id);
    if (!dataUrl) return match;
    return `src="${dataUrl}" data-kb-ref="kb-image://${id}"`;
  });
  return out;
}

function parseAndRenderMd(md) {
  // 0. 先把 kb-image:// 換成真實圖片（在 marked 之前，避免 marked 誤判 scheme）
  let processed = resolveKbImages(md);

  // 1. Extract :::dialog blocks
  const dialogs = [];
  processed = processed.replace(/:::dialog\n([\s\S]*?):::/g, (_, inner) => {
    const idx = dialogs.length;
    dialogs.push(parseDialogBlock(inner));
    return `<!-- KBDIALOG:${idx} -->`;
  });

  // 2. Extract :::card blocks
  const cards = [];
  processed = processed.replace(/:::card\n([\s\S]*?):::/g, (_, inner) => {
    const idx = cards.length;
    cards.push(parseCardBlock(inner));
    return `<!-- KBCARD:${idx} -->`;
  });

  // 3. Convert [[Title]] wiki-links to HTML spans
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const found = state.notes.find(n => n.title === title);
    const cls = found ? 'note-link' : 'note-link note-link-broken';
    const safeTitle = title.replace(/"/g, '&quot;');
    return `<span class="${cls}" data-note-link="${safeTitle}" role="link" tabindex="0">${esc(title)}</span>`;
  });

  let html = marked.parse(processed);
  html = html.replace(/<!-- KBDIALOG:(\d+) -->/g, (_, i) => renderDialog(dialogs[+i], +i));
  html = html.replace(/<!-- KBCARD:(\d+) -->/g, (_, i) => renderCard(cards[+i], +i));

  return html;
}

const CARD_TEMPLATE =
`\n:::card\ntitle: \nurl: \n---\n- \n- \n- \n:::\n`;

// ===== DIALOG MODULE =====
// Syntax:
//   :::dialog
//   left: 小明
//   right: 小華
//   ---
//   L: 你好！
//   R: 你好，很高興認識你！
//   L: 你最近怎麼樣？
//   R: 還不錯，謝謝關心。
//   :::

function parseDialogBlock(inner) {
  let leftName = '', rightName = '', body = inner.trim();
  const sepIdx = inner.indexOf('\n---\n');
  if (sepIdx !== -1) {
    const meta = inner.slice(0, sepIdx);
    body = inner.slice(sepIdx + 5).trim();
    meta.split('\n').forEach(line => {
      const m = line.match(/^(left|right):\s*(.*)$/);
      if (!m) return;
      if (m[1] === 'left')  leftName  = m[2].trim();
      if (m[1] === 'right') rightName = m[2].trim();
    });
  }
  return { leftName, rightName, body };
}

function renderDialog(dialog, idx) {
  const { leftName, rightName, body } = dialog;
  const idxAttr = idx != null ? ` data-dialog-idx="${idx}"` : '';

  const rows = [];
  for (const line of body.split('\n')) {
    const lm = line.match(/^L:\s*(.*)/);
    const rm = line.match(/^R:\s*(.*)/);
    if (lm) {
      rows.push({ side: 'left',  text: lm[1] });
    } else if (rm) {
      rows.push({ side: 'right', text: rm[1] });
    } else if (rows.length > 0 && line.trim()) {
      // 非 L:/R: 的非空行 → 接在上一個氣泡後面（換行）
      rows[rows.length - 1].text += '\n' + line;
    }
  }

  if (!rows.length) return '';

  const rowsHtml = rows.map(row => {
    const name = row.side === 'left' ? leftName : rightName;
    const nameHtml = name ? `<div class="note-dialog-name">${esc(name)}</div>` : '';
    return `<div class="note-dialog-row ${row.side}">
      ${nameHtml}<div class="note-dialog-bubble">${esc(row.text)}</div>
    </div>`;
  }).join('');

  return `<div class="note-dialog"${idxAttr}>${rowsHtml}</div>`;
}

const DIALOG_TEMPLATE =
`\n:::dialog\nleft: \nright: \n---\nL: \nR: \nL: \nR: \n:::\n`;

// ===== PREVIEW =====
function updatePreview(md) {
  const preview = document.getElementById('editorPreview');
  if (!preview) return;
  preview.innerHTML = parseAndRenderMd(md);
  // Mark images; prefer kb-image:// ref for applyImageSize matching
  preview.querySelectorAll('img').forEach(img => {
    img.classList.add('resizable-img');
    img.dataset.rawSrc = img.dataset.kbRef || decodeURIComponent(img.getAttribute('src') || '');
  });
}

// ── Global delegation: note-link / image / card ──
document.addEventListener('click', e => {
  const bar = document.getElementById('imgResizer');

  // Note-link: navigate to target note (view & edit mode)
  const noteLink = e.target.closest('.note-link');
  if (noteLink) {
    e.preventDefault();
    const title = noteLink.dataset.noteLink;
    const target = state.notes.find(n => n.title === title);
    if (target) {
      if (state.editMode) exitEditMode(false);
      openNote(target.id);
    }
    return;
  }

  // Image / card resize (edit mode only)
  if (state.editMode) {
    const img  = e.target.closest('.resizable-img');
    const card = e.target.closest('.note-card[data-card-idx]');
    if (img)  { e.stopPropagation(); showImgResizer(img, e.clientX, e.clientY);   return; }
    if (card) { e.stopPropagation(); showCardResizer(card, e.clientX, e.clientY); return; }
  }

  if (bar && !bar.contains(e.target)) bar.remove();
});

function showCardResizer(card, cx, cy) {
  document.getElementById('imgResizer')?.remove();
  const bar = document.createElement('div');
  bar.id = 'imgResizer';
  bar.className = 'img-resizer';
  bar.innerHTML = `
    <span class="img-resizer-label">卡片尺寸：</span>
    <button data-size="25%">小 25%</button>
    <button data-size="50%">中 50%</button>
    <button data-size="75%">大 75%</button>
    <button data-size="100%">全寬</button>
    <button data-size="">原始</button>
    <button class="img-resizer-close">✕</button>
  `;
  document.body.appendChild(bar);
  const bw = 340;
  bar.style.left = Math.min(cx, window.innerWidth - bw - 12) + 'px';
  bar.style.top  = Math.max(8, cy - 52) + 'px';

  const cardIdx = +card.dataset.cardIdx;
  bar.querySelector('.img-resizer-close').addEventListener('click', e => {
    e.stopPropagation(); bar.remove();
  });
  bar.querySelectorAll('[data-size]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      applyCardSize(cardIdx, btn.dataset.size);
      bar.remove();
    });
  });
}

function applyCardSize(cardIdx, size) {
  const ta = document.getElementById('editorTextarea');
  if (!ta) return;
  // Normalize CRLF → LF so regex reliably matches on Windows
  let md = ta.value.replace(/\r\n/g, '\n');
  let count = 0;
  md = md.replace(/:::card\n([\s\S]*?):::/g, (match, inner) => {
    if (count++ !== cardIdx) return match;

    const sepIdx = inner.indexOf('\n---\n');
    if (sepIdx !== -1) {
      // Has metadata section — update/remove width line
      let meta = inner.slice(0, sepIdx).replace(/^width:.*\n?/m, '').trimEnd();
      if (size) meta += `\nwidth: ${size}`;
      return `:::card\n${meta}\n---\n${inner.slice(sepIdx + 5)}:::`;
    } else {
      // No metadata — add a metadata section with width
      if (!size) return match;
      return `:::card\nwidth: ${size}\n---\n${inner}:::`;
    }
  });
  ta.value = md;
  ta.style.height = 'auto';
  ta.style.height = Math.max(300, ta.scrollHeight) + 'px';
  updatePreview(md);
}

function showImgResizer(img, cx, cy) {
  document.getElementById('imgResizer')?.remove();

  const bar = document.createElement('div');
  bar.id = 'imgResizer';
  bar.className = 'img-resizer';
  bar.innerHTML = `
    <span class="img-resizer-label">尺寸：</span>
    <button data-size="25%">小 25%</button>
    <button data-size="50%">中 50%</button>
    <button data-size="75%">大 75%</button>
    <button data-size="100%">全寬</button>
    <button data-size="">原始</button>
    <button class="img-resizer-close">✕</button>
  `;
  document.body.appendChild(bar);

  // Position near click, keep within viewport
  const bw = 320;
  bar.style.left = Math.min(cx, window.innerWidth - bw - 12) + 'px';
  bar.style.top  = Math.max(8, cy - 52) + 'px';

  bar.querySelector('.img-resizer-close').addEventListener('click', e => {
    e.stopPropagation(); bar.remove();
  });
  bar.querySelectorAll('[data-size]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      applyImageSize(img, btn.dataset.size);
      bar.remove();
    });
  });
}

function applyImageSize(imgEl, size) {
  const ta = document.getElementById('editorTextarea');
  if (!ta) return;

  // Use dataset.rawSrc (decoded, set by updatePreview); fallback to getAttribute
  let rawSrc = imgEl.dataset.rawSrc !== undefined ? imgEl.dataset.rawSrc : (imgEl.getAttribute('src') || '');
  rawSrc = decodeURIComponent(rawSrc);
  if (rawSrc.startsWith(location.origin)) rawSrc = rawSrc.slice(location.origin.length).replace(/^\//, '');
  const alt = imgEl.getAttribute('alt') || '';
  let md = ta.value;

  const newTag = size
    ? `<img src="${rawSrc}" alt="${alt}" style="width:${size}">`
    : `![${alt}](${rawSrc})`;

  if (rawSrc.startsWith('data:')) {
    // base64: use string search (too long for regex)
    const mdMark  = `![${alt}](${rawSrc})`;
    const tagMark = `<img src="${rawSrc}"`;
    if (md.includes(mdMark)) {
      md = md.slice(0, md.indexOf(mdMark)) + newTag + md.slice(md.indexOf(mdMark) + mdMark.length);
    } else if (md.includes(tagMark)) {
      const s = md.indexOf(tagMark);
      md = md.slice(0, s) + newTag + md.slice(md.indexOf('>', s) + 1);
    }
  } else {
    const esc    = rawSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mdPat  = new RegExp(`!\\[[^\\]]*\\]\\(${esc}[^)]*\\)`);
    const htmlPat = new RegExp(`<img[^>]*src=["']${esc}["'][^>]*/?>`, 's');
    md = mdPat.test(md)  ? md.replace(mdPat, newTag)
       : htmlPat.test(md) ? md.replace(htmlPat, newTag)
       : md;
  }

  ta.value = md;
  ta.style.height = 'auto';
  ta.style.height = Math.max(300, ta.scrollHeight) + 'px';
  updatePreview(md);
}

// ===== NOTE LINK PICKER =====
function showNoteLinkPicker() {
  document.getElementById('noteLinkPicker')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'noteLinkPicker';
  overlay.innerHTML = `
    <div class="modal-card note-picker-card">
      <h3>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px;margin-right:5px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        插入筆記連結
      </h3>
      <input type="text" id="noteLinkSearch" class="note-picker-search" placeholder="搜尋筆記標題..." autocomplete="off">
      <div id="noteLinkList" class="note-picker-list"></div>
      <div class="modal-actions">
        <button class="modal-cancel-btn" id="noteLinkCancelBtn">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const searchEl = document.getElementById('noteLinkSearch');
  const listEl   = document.getElementById('noteLinkList');

  function renderList(query) {
    const notes = query.trim()
      ? state.notes.filter(n => n.title.toLowerCase().includes(query.toLowerCase()))
      : state.notes.slice(0, 30);
    if (!notes.length) {
      listEl.innerHTML = '<div class="note-picker-empty">找不到筆記</div>';
      return;
    }
    listEl.innerHTML = notes.map(n => `
      <div class="note-picker-item" data-title="${esc(n.title)}">
        <span class="note-picker-title">${esc(n.title)}</span>
        ${n.tags?.length ? `<span class="note-picker-meta">${n.tags.slice(0,4).map(t => '#' + esc(t)).join(' ')}</span>` : ''}
      </div>`).join('');
    listEl.querySelectorAll('.note-picker-item').forEach(item => {
      item.addEventListener('click', () => {
        insertAtCursor(`[[${item.dataset.title}]]`);
        overlay.remove();
      });
    });
  }

  renderList('');
  searchEl.addEventListener('input', e => renderList(e.target.value));
  document.getElementById('noteLinkCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.remove();
    if (e.key === 'Enter') {
      const first = listEl.querySelector('.note-picker-item');
      if (first) first.click();
    }
  });
  setTimeout(() => searchEl.focus(), 50);
}

// ===== DELETE NOTE =====
async function deleteNote() {
  if (!state.activeNoteId) return;
  const note = state.notes.find(n => n.id === state.activeNoteId);
  if (!note) return;

  if (!confirm(`確定要刪除「${note.title}」？\n此操作無法復原。`)) return;

  await db_deleteNote(state.activeNoteId);
  state.activeNoteId = null;

  document.getElementById('editNoteBtn').classList.add('hidden');
  document.getElementById('deleteNoteBtn').classList.add('hidden');
  document.getElementById('noteContent').innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🔍</div>
      <h2>歡迎使用 Knowledge Base</h2>
      <p>按 <kbd>Ctrl+K</kbd> 或 <kbd>/</kbd> 開始搜尋<br>或從左側選擇筆記</p>
    </div>`;

  await reloadIndex();
}

// ===== NEW NOTE MODAL =====
function openNewNoteModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'newNoteModal';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>新增筆記</h3>
      <div class="field">
        <label>標題</label>
        <input type="text" id="newNoteTitle" placeholder="輸入筆記標題..." autocomplete="off">
      </div>
      <p class="modal-error" id="newNoteError"></p>
      <div class="modal-actions">
        <button class="modal-cancel-btn" onclick="closeNewNoteModal()">取消</button>
        <button class="modal-confirm-btn" id="newNoteConfirmBtn" onclick="confirmNewNote()">建立</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeNewNoteModal(); });

  setTimeout(() => {
    const input = document.getElementById('newNoteTitle');
    input.focus();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmNewNote(); }
      if (e.key === 'Escape') closeNewNoteModal();
    });
  }, 50);
}

function closeNewNoteModal() {
  document.getElementById('newNoteModal')?.remove();
}

async function confirmNewNote() {
  const title = document.getElementById('newNoteTitle').value.trim();
  const errEl = document.getElementById('newNoteError');
  const btn = document.getElementById('newNoteConfirmBtn');

  if (!title) { errEl.textContent = '請輸入標題'; return; }

  btn.disabled = true;
  btn.textContent = '建立中...';
  errEl.textContent = '';

  try {
    const newNote = await db_createNote(title);
    closeNewNoteModal();
    await reloadIndex();
    const found = state.notes.find(n => n.id === newNote.id);
    if (found) {
      await openNote(found.id);
      openEditorForNote();
    }
  } catch {
    errEl.textContent = '建立失敗';
    btn.disabled = false;
    btn.textContent = '建立';
  }
}

// ===== IMAGE UPLOAD SETUP (called after inline editor is injected) =====
function setupImageUpload() {
  const imageFileInput = document.getElementById('imageFileInput');
  const insertImageBtn = document.getElementById('insertImageBtn');
  const ta = document.getElementById('editorTextarea');
  if (!imageFileInput || !insertImageBtn || !ta) return;

  insertImageBtn.addEventListener('click', () => imageFileInput.click());
  document.getElementById('insertCardBtn')?.addEventListener('click', () => {
    insertAtCursor(CARD_TEMPLATE);
    switchEditorTab('preview');
  });
  document.getElementById('insertDialogBtn')?.addEventListener('click', () => {
    insertAtCursor(DIALOG_TEMPLATE);
    switchEditorTab('preview');
  });
  document.getElementById('insertLinkBtn')?.addEventListener('click', showNoteLinkPicker);
  imageFileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) await uploadImage(file);
    imageFileInput.value = '';
  });

  ta.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      ta.classList.add('drag-over');
    }
  });
  ta.addEventListener('dragleave', () => ta.classList.remove('drag-over'));
  ta.addEventListener('drop', async e => {
    ta.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await uploadImage(f);
  });
  ta.addEventListener('paste', async e => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) await uploadImage(file);
    }
  });
}

// ===== IMAGE UPLOAD =====
function insertAtCursor(text) {
  const ta = document.getElementById('editorTextarea');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + text.length;
  ta.focus();
  updatePreview(ta.value);
}

async function uploadImage(file) {
  const status = document.getElementById('uploadStatus');
  const btn = document.getElementById('insertImageBtn');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '處理中...';

  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = async e => {
      const dataUrl = e.target.result;
      const safeName = file.name.replace(/\s+/g, '_');
      try {
        const id = await db_storeImage(safeName, dataUrl);
        imageCache.set(id, dataUrl);                        // 立即加入快取
        insertAtCursor(`![${safeName}](kb-image://${id})`); // 短 ID 參照
      } catch {
        // DB 失敗時 fallback：base64 inline
        insertAtCursor(`![${safeName}](${dataUrl})`);
      }
      switchEditorTab();
      if (status) status.textContent = '';
      if (btn) btn.disabled = false;
      resolve();
    };
    reader.readAsDataURL(file);
  });
}

// ===== EDITOR TAB SWITCHING =====
function switchEditorTab() {
  const ta = document.getElementById('editorTextarea');
  if (ta) updatePreview(ta.value);
}

// ===== MOBILE SIDEBAR =====
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const isOpen = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', !isOpen);
  backdrop.classList.toggle('active', !isOpen);
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('active');
}

// ===== TAG FILTER =====
function toggleTag(tag) {
  state.activeTag = state.activeTag === tag ? null : tag;
  renderTagList();
  renderNoteList();
}

// ===== SEARCH =====
function openSearch() {
  if (state.editMode) return;
  state.searchFocusIndex = -1;
  state.searchResults = [];
  const overlay = document.getElementById('searchOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('searchInput').value = '';
  showRecentNotes();
  document.getElementById('searchInput').focus();
}

function closeSearch() {
  document.getElementById('searchOverlay').classList.add('hidden');
}

function showRecentNotes() {
  const container = document.getElementById('searchResults');
  const recent = state.notes.slice(0, 8);
  if (!recent.length) {
    container.innerHTML = '<div class="search-empty">尚無筆記</div>';
    return;
  }
  container.innerHTML =
    '<div class="search-results-hint">最近筆記</div>' +
    recent.map((note, i) => renderResultItem(note, i, null)).join('');
  state.searchResults = recent.map(n => n.id);
}

function performSearch(query) {
  const container = document.getElementById('searchResults');
  if (!query.trim()) { showRecentNotes(); return; }

  if (!state.fuse) {
    container.innerHTML = '<div class="search-empty">搜尋索引未就緒</div>';
    return;
  }

  const results = state.fuse.search(query, { limit: 12 });
  state.searchFocusIndex = -1;

  if (!results.length) {
    container.innerHTML = `<div class="search-empty">找不到「${esc(query)}」的相關筆記</div>`;
    state.searchResults = [];
    return;
  }

  state.searchResults = results.map(r => r.item.id);
  container.innerHTML =
    `<div class="search-results-hint">${results.length} 筆結果</div>` +
    results.map((r, i) => {
      const titleMatch = r.matches?.find(m => m.key === 'title');
      const title = titleMatch
        ? highlightMatches(r.item.title, titleMatch.indices)
        : esc(r.item.title);
      return renderResultItem(r.item, i, title);
    }).join('');
}

function renderResultItem(note, i, titleHtml) {
  const title = titleHtml || esc(note.title);
  const tagsHtml = (note.tags || []).slice(0, 4)
    .map(t => `<span class="search-result-tag">${esc(t)}</span>`).join('');
  const excerpt = note.excerpt ? esc(note.excerpt.slice(0, 120)) + '…' : '';
  return `<div class="search-result-item" data-idx="${i}" data-id="${esc(note.id)}" onclick="openNote('${esc(note.id)}')">
    <div class="search-result-title">${title}</div>
    ${excerpt ? `<div class="search-result-excerpt">${excerpt}</div>` : ''}
    ${tagsHtml ? `<div class="search-result-tags">${tagsHtml}</div>` : ''}
  </div>`;
}

function navigateSearch(dir) {
  const items = document.querySelectorAll('.search-result-item');
  if (!items.length) return;
  items[state.searchFocusIndex]?.classList.remove('focused');
  state.searchFocusIndex = Math.max(0, Math.min(items.length - 1, state.searchFocusIndex + dir));
  items[state.searchFocusIndex]?.classList.add('focused');
  items[state.searchFocusIndex]?.scrollIntoView({ block: 'nearest' });
}

function selectSearchResult() {
  if (state.searchFocusIndex >= 0) {
    const id = state.searchResults[state.searchFocusIndex];
    if (id) openNote(id);
  }
}

// ===== UTILS =====
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const yaml = match[1];
  const body = match[2];
  const fm = {};
  yaml.split('\n').forEach(line => {
    const ci = line.indexOf(':');
    if (ci < 0) return;
    const key = line.slice(0, ci).trim();
    const val = line.slice(ci + 1).trim();
    if (!key) return;
    if (val.startsWith('[')) {
      fm[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    } else {
      fm[key] = val.replace(/['"]/g, '');
    }
  });
  return { frontmatter: fm, body };
}

function highlightMatches(text, indices) {
  if (!indices?.length) return esc(text);
  let result = '';
  let last = 0;
  const sorted = [...indices].sort((a, b) => a[0] - b[0]);
  sorted.forEach(([s, e]) => {
    result += esc(text.slice(last, s));
    result += `<mark>${esc(text.slice(s, e + 1))}</mark>`;
    last = e + 1;
  });
  result += esc(text.slice(last));
  return result;
}

function isInputFocused() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ===== KEYBOARD =====
document.addEventListener('keydown', e => {
  // Ctrl+K or / → open search (not in edit mode)
  if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && !isInputFocused())) {
    e.preventDefault();
    openSearch();
    return;
  }
  // Ctrl+S → save note (in edit mode)
  if (e.ctrlKey && e.key === 's' && state.editMode) {
    e.preventDefault();
    saveNote();
    return;
  }
  const overlay = document.getElementById('searchOverlay');
  if (!overlay?.classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateSearch(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); navigateSearch(-1); }
    if (e.key === 'Enter') { e.preventDefault(); selectSearchResult(); }
  }
});

// ===== VAULT SYNC =====
// 每次登入都從伺服器同步：
//   優先讀取 vault/db.json（完整匯出版）
//   找不到時 fallback 到 vault/index.json + 個別 .md 檔
// db.json 中的筆記視為 master，永遠覆蓋本機同 ID 筆記
// 使用者自建（ID 不在 db.json 內）的筆記不受影響
async function syncVaultNotes() {
  // 1. 嘗試 vault/db.json
  try {
    const res = await fetch('vault/db.json', { cache: 'no-store' });
    if (res.ok) {
      const dbJson = await res.json();
      if (Array.isArray(dbJson?.notes) && dbJson.notes.length) {
        // 先匯入圖片（讓筆記內容可正確參照）
        for (const img of (dbJson.images || [])) {
          try { await db_storeImageWithId(img.id, img.filename, img.dataUrl); } catch {}
        }
        // Upsert 所有筆記（db.json 為 master，直接覆蓋同 ID）
        for (const noteData of dbJson.notes) {
          try {
            await dbOp('notes', 'readwrite', s => s.put({
              ...noteData,
              tags: noteData.tags || [],
              content: noteData.content || '',
              updatedAt: noteData.updatedAt || Date.now(),
            }));
          } catch {}
        }
        return;
      }
    }
  } catch { /* db.json 不存在或格式錯誤，繼續 fallback */ }

  // 2. Fallback：vault/index.json + 個別 .md 檔
  try {
    const index = await fetch('vault/index.json', { cache: 'no-store' }).then(r => r.json());
    if (!Array.isArray(index) || !index.length) return;

    const allNotes = await dbOp('notes', 'readonly', s => s.getAll());
    const vaultMap = {};
    allNotes.filter(n => n.vaultSource).forEach(n => { vaultMap[n.vaultSource] = n.id; });

    for (const filename of index) {
      try {
        const raw = await fetch('vault/' + filename, { cache: 'no-store' }).then(r => r.text());
        if (!raw.trim()) continue;
        const { frontmatter } = parseFrontmatter(raw);
        const title = frontmatter.title || filename.replace(/\.md$/, '');

        if (vaultMap[filename]) {
          await db_saveNote(vaultMap[filename], raw);
        } else {
          const note = await db_createNote(title);
          await db_saveNoteWithSource(note.id, raw, filename);
        }
      } catch {}
    }
  } catch {}
}

// ===== EXPORT DATABASE =====
async function exportDatabase() {
  const btn = document.getElementById('updateDbBtn');
  if (btn) { btn.disabled = true; btn.querySelector('.btn-label').textContent = '匯出中...'; }

  try {
    const allNotes = await dbOp('notes', 'readonly', s => s.getAll());

    // 收集所有筆記內容引用的圖片 ID
    const imageIds = new Set();
    allNotes.forEach(n => {
      [...(n.content || '').matchAll(/kb-image:\/\/([a-zA-Z0-9]+)/g)]
        .forEach(m => imageIds.add(m[1]));
    });
    const images = imageIds.size ? await db_getImages([...imageIds]) : [];

    const exportData = {
      version: 1,
      exported: new Date().toISOString(),
      notes: allNotes.map(({ id, title, tags, date, content, vaultSource, updatedAt }) => ({
        id, title,
        tags: tags || [],
        date: date || '',
        content: content || '',
        vaultSource: vaultSource || null,
        updatedAt: updatedAt || Date.now(),
      })),
      images: images.filter(Boolean).map(({ id, filename, dataUrl }) => ({ id, filename, dataUrl })),
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'db.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('.btn-label').textContent = '更新資料庫'; }
  }
}

// ===== INIT APP =====
async function initApp(user) {
  state.user = user;
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('currentUser').textContent = user.displayName || user.username;

  await syncVaultNotes();

  const data = await loadIndex();
  state.notes = data.notes || [];
  state.tags = data.tags || [];

  if (state.notes.length > 0) {
    state.fuse = buildFuseIndex(state.notes);
  }

  renderTagList();
  renderNoteList();
}

// ===== BOOT =====
async function boot() {
  // Search
  document.getElementById('searchInput').addEventListener('input', e => {
    performSearch(e.target.value);
  });
  document.getElementById('searchOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('searchOverlay')) closeSearch();
  });

  // Mobile sidebar toggle
  document.getElementById('sidebarToggleBtn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);

  // Auth
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  document.getElementById('updateDbBtn').addEventListener('click', exportDatabase);

  // View mode
  document.getElementById('searchTriggerBtn').addEventListener('click', openSearch);
  document.getElementById('sidebarSearchHint').addEventListener('click', openSearch);
  document.getElementById('newNoteBtn').addEventListener('click', openNewNoteModal);
  document.getElementById('sidebarNewBtn').addEventListener('click', openNewNoteModal);
  document.getElementById('editNoteBtn').addEventListener('click', openEditorForNote);
  document.getElementById('deleteNoteBtn').addEventListener('click', deleteNote);

  // Edit mode (save/cancel — image upload is set up dynamically in enterEditMode)
  document.getElementById('cancelEditBtn').addEventListener('click', () => exitEditMode(true));
  document.getElementById('saveNoteBtn').addEventListener('click', saveNote);

  // Always wire up login form (login screen is visible by default)
  document.getElementById('loginForm').addEventListener('submit', doLogin);

  // Session check
  const session = getSession();
  if (session) {
    await initApp(session);
  } else {
    setTimeout(() => document.getElementById('loginUsername').focus(), 50);
  }
}

boot();
