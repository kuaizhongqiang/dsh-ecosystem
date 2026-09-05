// extract-dsw-tokens.mjs
// 从已安装的 @deepseek-ai/dsh-client-ui-theme 打包产物中提取 dsw 设计令牌 CSS，
// 输出到 ui/tokens.css。用法：node scripts/extract-dsw-tokens.mjs [themeClientJs路径]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const DEFAULT_SRC = 'D:/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';
const src = process.argv[2] ?? DEFAULT_SRC;

let raw;
try {
  raw = readFileSync(src, 'utf8');
} catch (e) {
  console.error(`无法读取 ${src}\n${e.message}\n可传参指定路径: node scripts/extract-dsw-tokens.mjs <client.js 路径>`);
  process.exit(1);
}

// 提取所有 var <name>_css_default = "..." 字面量（含转义），并还原为真实 CSS 文本
const cssModules = [];
const re = /var\s+(\w+)_css_default\s*=\s*"((?:[^"\\]|\\.)*)"/g;
let m;
while ((m = re.exec(raw)) !== null) {
  const [, name, body] = m;
  // JS 字符串字面量还原：处理 \" \\ \n \uXXXX 等
  let css = body;
  try {
    css = JSON.parse('"' + body + '"');
  } catch {
    // 保底：手动解转义
    css = body.replace(/\\(["\\])/g, '$1');
  }
  cssModules.push({ name, css });
}

const header = `/* dsw 设计令牌 —— 提取自 @deepseek-ai/dsh-client-ui-theme (lib/client.js)
   生成脚本: scripts/extract-dsw-tokens.mjs
   只读资产：不要手改令牌值；新增 UI 样式请追加到 launcher.css */
`;

const out = header + cssModules.map(({ name, css }) => `/* ==== ${name} ==== */\n${css}\n`).join('\n');
mkdirSync(join(repoRoot, 'ui'), { recursive: true });
writeFileSync(join(repoRoot, 'ui', 'tokens.css'), out, 'utf8');
console.log(`提取完成: ${cssModules.length} 个 CSS 模块 -> ui/tokens.css (${out.length} 字节)`);
cssModules.forEach(({ name, css }) => console.log(`  - ${name}: ${css.length} 字节`));
