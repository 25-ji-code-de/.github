/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 静态站与纯 JS Worker 仓的通用检查。
 *
 * 之前这些逻辑内联在 workflow 的 `node -e '...'` 里，结果被 bash 的单引号
 * 字符串坑了一次 —— CSP 校验的正则含字面 `'self'`，直接把 bash 字符串截断，
 * 报 "syntax error near unexpected token". 挪成文件后不再有转义问题。
 *
 * 用法：node static-check.mjs <repo-root> [ignore-regex]
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { argv, env } from 'node:process';

const root = argv[2] || '.';
const ignore = new RegExp(
  argv[3] || 'node_modules|[\\\\/]libs[\\\\/]|\\.min\\.js$|package-lock\\.json$',
);

/** checkout 共享脚本用的目录，不参与扫描。 */
const META_DIR = '_sekai_meta';

const problems = [];
const fail = (msg) => problems.push(msg);

function collect(extensions) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git' || entry === META_DIR) continue;
      const full = join(dir, entry);
      if (ignore.test(full)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((e) => full.endsWith(e))) out.push(full);
    }
  })(root);
  return out;
}

/* ── 1. JavaScript 语法 ─────────────────────────────────────── */
{
  const files = collect(['.js', '.mjs']);
  let failed = 0;
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed += 1;
      fail(`${file}: JavaScript 语法错误\n${String(err.stderr).trim().split('\n')[0]}`);
    }
  }
  console.log(`checked ${files.length} JavaScript file(s), ${failed} failed`);
}

/* ── 2. JSON 合法性 ───────────────────────────────────────────
 *
 * 有几类文件**官方就是 JSONC**（允许注释与尾逗号）：`tsconfig.json`、
 * `jsconfig.json`、`*.jsonc`、`.vscode/*.json`、`wrangler.jsonc`。
 * 直接 JSON.parse 会把这些合法文件判成语法错误 ——
 * nako 与 sekai-pass 的 tsconfig 里就有注释（那是有用的注释，
 * 解释了为什么开 allowImportingTsExtensions）。
 *
 * 这两个仓目前没用这个 reusable workflow，所以还没炸过。但一旦
 * 接进来就会立刻红在一个完全合法的文件上 —— 那种红最消耗信任。
 */
{
  /** 这些路径按 JSONC 处理。 */
  const JSONC = /(?:^|[\\/])(?:tsconfig|jsconfig)[^\\/]*\.json$|\.jsonc$|[\\/]\.vscode[\\/][^\\/]+\.json$/i;

  /**
   * 去掉注释与尾逗号。
   *
   * 必须逐字符走：简单的正则会把字符串里的 `//` 当成注释开头，
   * 而 JSON 里到处是 URL（`"https://…"`）。
   */
  function stripJsonc(text) {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
      const c = text[i];
      if (inString) {
        out += c;
        if (c === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === '"') inString = false;
        i += 1;
        continue;
      }
      if (c === '"') {
        inString = true;
        out += c;
        i += 1;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      out += c;
      i += 1;
    }
    // 尾逗号：`,` 后面只跟空白再跟 } 或 ]
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  const files = collect(['.json', '.jsonc']);
  let failed = 0;
  let jsonc = 0;
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const isJsonc = JSONC.test(file);
    if (isJsonc) jsonc += 1;
    try {
      JSON.parse(isJsonc ? stripJsonc(raw) : raw);
    } catch (err) {
      failed += 1;
      fail(`${file}: ${err.message}`);
    }
  }
  console.log(
    `validated ${files.length} JSON file(s)（其中 ${jsonc} 个按 JSONC 处理），${failed} failed`,
  );
}

/* ── 3. 内联的上游文件与 tag 一致 ──────────────────────────────
 *
 * `.js` 与 `.css` 都扫。CSS 是后加的：各前端开始 vendored
 * sekai-design 的 token 之后，"复制粘贴之后没人知道什么时候开始
 * 不一样了"这个老问题会原样搬到样式上 —— hub 的 :root 就是从
 * sekai-pass 抄来的，两边的 --error-color 已经分成 `#e57373` 和
 * `229 115 115` 两种拼写，谁都没发现。
 *
 * 两种注释语法各认各的：JS 用行注释起头的 `@sekai-vendor …`，
 * CSS 用块注释包住的同一行内容。具体形状见下面两个正则。
 */
{
  const MARKERS = [
    /^\/\/\s*@sekai-vendor\s+(\S+)@(\S+)\s+(\S+)\s*$/m,
    /^\/\*\s*@sekai-vendor\s+(\S+)@(\S+)\s+(\S+)\s*\*\/\s*$/m,
  ];
  const REPO_BY_PKG = {
    '@25-ji-code-de/sekai-auth': '25-ji-code-de/sekai-auth',
    '@25-ji-code-de/sekai-worker-kit': '25-ji-code-de/sekai-worker-kit',
    '@25-ji-code-de/sekai-design': '25-ji-code-de/sekai-design',
  };
  const normalize = (s) => s.replace(/\r\n/g, '\n').trimEnd();

  let checked = 0;
  for (const file of collect(['.js', '.css'])) {
    const content = readFileSync(file, 'utf8');
    let match = null;
    for (const m of MARKERS) {
      match = content.match(m);
      if (match) break;
    }
    if (!match) continue;

    checked += 1;
    const [, pkg, tag, path] = match;
    const repo = REPO_BY_PKG[pkg];
    if (!repo) {
      fail(`${file}: 未知的内联包 ${pkg}`);
      continue;
    }

    const url = `https://raw.githubusercontent.com/${repo}/${tag}/${path}`;
    const response = await fetch(url);
    if (!response.ok) {
      fail(`${file}: 无法拉取 ${url}（HTTP ${response.status}）`);
      continue;
    }
    if (normalize(content).endsWith(normalize(await response.text()))) {
      console.log(`✓ ${file} matches ${pkg}@${tag}`);
    } else {
      fail(`${file}: 与 ${pkg}@${tag} 不一致\n    上游：${url}`);
    }
  }
  console.log(`checked ${checked} vendored file(s)`);
}

/* ── 4. Cloudflare Pages _headers ───────────────────────────── */
{
  const headersPath = join(root, '_headers');
  if (!existsSync(headersPath)) {
    console.log('no _headers file — skipping');
  } else {
    let raw = readFileSync(headersPath, 'utf8');

    // BOM 会让第一条路径规则看起来是缩进的，Pages 侧同样会解析失败
    if (raw.charCodeAt(0) === 0xfeff) {
      fail('_headers: 文件带 UTF-8 BOM，必须是无 BOM 的纯 UTF-8');
      raw = raw.slice(1);
    }

    const lines = raw.split(/\r?\n/);
    const seen = new Map();
    let rule = null;

    lines.forEach((line, i) => {
      const n = i + 1;
      if (!line.trim() || line.trimStart().startsWith('#')) return;
      if (!/^\s/.test(line)) {
        rule = line.trim();
        // 同一路径出现多个块，行为依赖 Pages 的合并语义 —— 曾经踩过
        if (seen.has(rule)) {
          fail(`_headers:${n}: 路径规则 "${rule}" 重复（首次出现在第 ${seen.get(rule)} 行），应合并为一个块`);
        }
        seen.set(rule, n);
        return;
      }
      if (!rule) {
        fail(`_headers:${n}: 头部行出现在任何路径规则之前`);
        return;
      }
      if (!/^\s+[A-Za-z0-9-]+:\s*.+$/.test(line)) {
        fail(`_headers:${n}: 头部行格式错误：${line.trim()}`);
      }
    });

    for (const header of [
      'X-Content-Type-Options',
      'Referrer-Policy',
      'X-Frame-Options',
      'Permissions-Policy',
    ]) {
      if (!raw.includes(header)) fail(`_headers: 缺少必需的安全头 ${header}`);
    }

    // CSP 写错不会报错，只会静默失效（或更糟：静默拦掉正常资源）
    const KNOWN_DIRECTIVES = new Set([
      'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src',
      'connect-src', 'object-src', 'frame-src', 'worker-src', 'manifest-src',
      'base-uri', 'form-action', 'frame-ancestors', 'report-uri', 'report-to',
      'upgrade-insecure-requests', 'block-all-mixed-content',
    ]);
    const SOURCE_OK =
      /^('self'|'none'|'unsafe-inline'|'unsafe-eval'|'strict-dynamic'|data:|blob:|https:|wss:|'nonce-[\w+/=-]+'|'sha(256|384|512)-[\w+/=-]+'|https?:\/\/[^\s]+|\*)$/;

    for (const m of raw.matchAll(/^\s+(Content-Security-Policy(?:-Report-Only)?):\s*(.+)$/gm)) {
      const [, header, value] = m;
      const dirs = value.split(';').map((s) => s.trim()).filter(Boolean);
      const names = dirs.map((d) => d.split(/\s+/)[0]);
      const dupes = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
      if (dupes.length) fail(`${header}: 重复指令 ${dupes.join(', ')}`);
      for (const d of dirs) {
        const [name, ...sources] = d.split(/\s+/);
        if (!KNOWN_DIRECTIVES.has(name)) fail(`${header}: 未知指令 "${name}"`);
        for (const s of sources) {
          if (!SOURCE_OK.test(s)) fail(`${header}: ${name} 里有可疑来源 "${s}"`);
        }
      }
    }

    console.log(`_headers: ${seen.size} 条路径规则，安全头齐全`);
  }
}

/* ── 输出 ───────────────────────────────────────────────────── */
if (problems.length) {
  console.log('');
  for (const p of problems) console.error(`✗ ${p}`);
  console.log(`\n共 ${problems.length} 处问题。`);
  if (env.GITHUB_STEP_SUMMARY) {
    // 与 check-consistency.mjs 一致：结果也写进 job summary
    console.log('::error::static-check 发现问题，详见上方日志');
  }
  process.exitCode = 1;
} else {
  console.log('\nstatic-check 全部通过。');
  process.exitCode = 0;
}
