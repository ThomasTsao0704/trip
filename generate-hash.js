const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.log('用法: node generate-hash.js <密碼>');
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(password).digest('hex');
console.log(hash);
