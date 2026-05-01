const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const VAULT_DIR = path.join(__dirname, 'vault');
const OUTPUT = path.join(__dirname, 'search-index.json');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const frontmatter = yaml.load(match[1]) || {};
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function makeExcerpt(body, len = 160) {
  return body
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/[*_`>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, len);
}

function makeId(filePath) {
  return path.basename(filePath, '.md').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-');
}

function scanVault(dir, baseDir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'images') continue;
      results.push(...scanVault(full, baseDir));
    } else if (entry.name.endsWith('.md')) {
      const content = fs.readFileSync(full, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      const relPath = path.relative(baseDir, full).replace(/\\/g, '/');
      const id = makeId(full);
      results.push({
        id,
        path: relPath,
        title: frontmatter.title || path.basename(full, '.md'),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : (frontmatter.tags ? [frontmatter.tags] : []),
        date: frontmatter.date || '',
        excerpt: makeExcerpt(body),
      });
    }
  }
  return results;
}

const notes = scanVault(VAULT_DIR, __dirname);
const tags = [...new Set(notes.flatMap(n => n.tags))].sort();

const index = { notes, tags, updatedAt: new Date().toISOString() };
fs.writeFileSync(OUTPUT, JSON.stringify(index, null, 2), 'utf8');
console.log(`✓ Built index: ${notes.length} notes, ${tags.length} tags → search-index.json`);
