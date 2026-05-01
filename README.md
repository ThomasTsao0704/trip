完成總覽
檔案結構：


trip/
├── index.html          ← 登入頁 + 主應用
├── styles.css          ← UI 樣式
├── app.js              ← 核心邏輯
├── users.json          ← 帳號密碼（SHA-256）
├── search-index.json   ← 搜尋索引（自動產生）
├── build-index.js      ← 更新索引腳本
├── generate-hash.js    ← 新增帳號工具
└── vault/              ← Obsidian 筆記庫（在此建立 .md）
    └── 範例筆記.md
預設帳號（請務必更改）：

帳號	密碼
admin	admin123
guest	guest123
更改密碼 / 新增帳號：


node generate-hash.js 你的新密碼
# 將輸出的 hash 填入 users.json
每次新增筆記後：


node build-index.js
使用 Obsidian： 直接開啟 vault/ 資料夾作為 Vault 即可。