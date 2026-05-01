// 產生 PWA 所需的 PNG 圖示（不需要額外安裝套件）
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);   c.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, c]);
}

function makePNG(size) {
  // Draw: rounded-square purple bg + simple "KB" shape using pixel painting
  const R = 0x4f, G = 0x46, B = 0xe5; // #4f46e5 indigo
  const radius = Math.round(size * 0.19);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte = None
    for (let x = 0; x < size; x++) {
      // Rounded corners: set to white/transparent outside the rounded rect
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let inside = true;
      if (dx < radius && dy < radius) {
        const ddx = radius - dx - 1, ddy = radius - dy - 1;
        inside = (ddx * ddx + ddy * ddy) < (radius * radius);
      }
      if (inside) {
        row.push(R, G, B, 255);
      } else {
        row.push(0, 0, 0, 0); // transparent
      }
    }
    rows.push(...row);
  }

  const raw  = Buffer.from(rows);
  const comp = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', comp),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'icons');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

[192, 512].forEach(size => {
  const file = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(file, makePNG(size));
  console.log(`✓ icons/icon-${size}.png (${size}×${size})`);
});
