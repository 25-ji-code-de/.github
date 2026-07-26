/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 跨仓一致性检查。
 *
 * 单仓 CI 只能看见自己那一份，看不见"我和别人不一样"。这个脚本把全部仓
 * 拉到一起比对那些**必须一致、但没有任何单仓机制能保证一致**的东西。
 *
 * 生态里已经因为缺这层检查踩过：四份漂移的 auth 客户端、三种互不兼容的
 * 错误信封、跨越两年的 compatibility_date、指向旧账号的 repository 字段。
 *
 * 用法：
 *   node check-consistency.mjs <checkout-root>
 *
 * <checkout-root> 下每个子目录是一个仓库的检出。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';

const root = argv[2] || '.';

/**
 * 不参与一致性约束的仓。
 *
 * puzzle-sekai 是独立演进的应用（Capacitor + yarn + flat eslint config），
 * 与生态其余部分刻意不共享工具链约定，维护者明确要求不要按统一标准去改它。
 */
const EXCLUDED = new Set(['puzzle-sekai']);

/** 静态站点仓（无构建步骤，应有 _headers）。 */
const STATIC_SITES = ['hub', 'nightcord', 'stickers', '25ji-sagyo'];

/** Cloudflare Worker 仓。 */
const WORKERS = ['gateway', 'nako', 'sekai-pass', 'storage-worker'];

/** 每个仓都应具备的社区文件。 */
const COMMUNITY_FILES = ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}
function note(msg) {
  notes.push(msg);
}

const repos = readdirSync(root).filter((name) => {
  const p = join(root, name);
  return !name.startsWith('.') && !EXCLUDED.has(name) && statSync(p).isDirectory();
});

function read(repo, file) {
  const p = join(root, repo, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function readJson(repo, file) {
  const raw = read(repo, file);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${repo}/${file}: 不是合法 JSON`);
    return null;
  }
}

/** 收集 <repo, value> 后，若出现多个不同 value 就报告分叉。 */
function requireConsistent(label, entries, { allowMissing = true } = {}) {
  const present = entries.filter(([, v]) => v != null);
  if (!present.length) return;
  if (!allowMissing && present.length !== entries.length) {
    const missing = entries.filter(([, v]) => v == null).map(([r]) => r);
    fail(`${label}: 以下仓缺失该项 — ${missing.join(', ')}`);
  }
  const byValue = new Map();
  for (const [repo, value] of present) {
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(repo);
  }
  if (byValue.size > 1) {
    const detail = [...byValue.entries()]
      .map(([v, rs]) => `    ${JSON.stringify(v)} ← ${rs.join(', ')}`)
      .join('\n');
    fail(`${label}: 出现 ${byValue.size} 个不同的值\n${detail}`);
  } else {
    note(`${label}: 一致（${[...byValue.keys()][0]}），共 ${present.length} 个仓`);
  }
}

/* ── 1. CI 的 Node 版本 ───────────────────────────────────────── */
{
  const entries = [];
  for (const repo of repos) {
    const dir = join(root, repo, '.github', 'workflows');
    if (!existsSync(dir)) continue;
    const versions = new Set();
    for (const file of readdirSync(dir)) {
      const yml = read(repo, join('.github', 'workflows', file));
      if (!yml) continue;
      for (const m of yml.matchAll(/node-version:\s*'?"?([\d.]+)'?"?/g)) {
        versions.add(m[1]);
      }
    }
    if (versions.size > 1) {
      fail(`${repo}: 同一仓内 CI 使用了多个 Node 版本 — ${[...versions].join(', ')}`);
    }
    if (versions.size === 1) entries.push([repo, [...versions][0]]);
  }
  requireConsistent('CI Node 版本', entries);
}

/* ── 2. 内联 SDK 的版本 ──────────────────────────────────────── */
{
  const MARKER = /^\/\/\s*@sekai-vendor\s+(\S+)@(\S+)\s+\S+\s*$/m;
  const byPkg = new Map();
  for (const repo of repos) {
    const repoDir = join(root, repo);
    const found = [];
    (function walk(dir) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (entry === '.git' || entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.js')) {
          const m = readFileSync(full, 'utf8').match(MARKER);
          if (m) found.push([m[1], m[2]]);
        }
      }
    })(repoDir);
    for (const [pkg, tag] of found) {
      if (!byPkg.has(pkg)) byPkg.set(pkg, []);
      byPkg.get(pkg).push([repo, tag]);
    }
  }
  for (const [pkg, entries] of byPkg) {
    requireConsistent(`内联 ${pkg} 的版本`, entries);
  }
}

/* ── 3. SDK 的 npm/git 依赖版本 ──────────────────────────────── */
{
  const byPkg = new Map();
  for (const repo of repos) {
    const pkg = readJson(repo, 'package.json');
    if (!pkg) continue;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith('@25-ji-code-de/')) continue;
      if (!byPkg.has(name)) byPkg.set(name, []);
      byPkg.get(name).push([repo, spec]);
    }
  }
  for (const [name, entries] of byPkg) {
    requireConsistent(`依赖 ${name} 的版本`, entries);
  }
}

/* ── 4. wrangler 的 compatibility_date ───────────────────────── */
{
  const entries = [];
  for (const repo of repos) {
    for (const file of [
      'wrangler.toml.example',
      'wrangler.jsonc.example',
      'wrangler.json.example',
    ]) {
      const raw = read(repo, file);
      if (!raw) continue;
      const m = raw.match(/compatibility_date"?\s*[:=]\s*"([\d-]+)"/);
      if (m) entries.push([`${repo}/${file}`, m[1]]);
    }
  }
  requireConsistent('wrangler compatibility_date', entries);
}

/* ── 5. package.json 的 author 与 repository owner ───────────── */
{
  const authors = [];
  for (const repo of repos) {
    const pkg = readJson(repo, 'package.json');
    if (!pkg) continue;
    if (pkg.author) authors.push([repo, pkg.author]);

    const url = pkg.repository?.url ?? pkg.repository;
    if (typeof url === 'string') {
      const m = url.match(/github\.com[/:]([^/]+)\//);
      if (m && m[1] !== '25-ji-code-de') {
        fail(`${repo}/package.json: repository 指向 ${m[1]}，应为 25-ji-code-de`);
      }
    }
  }
  requireConsistent('package.json author', authors);
}

/* ── 6. 社区文件 ─────────────────────────────────────────────── */
{
  for (const repo of repos) {
    const missing = COMMUNITY_FILES.filter((f) => !existsSync(join(root, repo, f)));
    if (missing.length) {
      fail(`${repo}: 缺少社区文件 — ${missing.join(', ')}`);
    }
  }
}

/* ── 7. 静态站的安全响应头 ───────────────────────────────────── */
{
  const REQUIRED = [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
  ];
  const frameOptions = [];
  for (const repo of STATIC_SITES) {
    if (!repos.includes(repo)) continue;
    const raw = read(repo, '_headers');
    if (!raw) {
      fail(`${repo}: 静态站缺少 _headers`);
      continue;
    }
    const missing = REQUIRED.filter((h) => !raw.includes(h));
    if (missing.length) fail(`${repo}/_headers: 缺少安全头 — ${missing.join(', ')}`);

    const m = raw.match(/X-Frame-Options:\s*(\S+)/);
    if (m) frameOptions.push([repo, m[1]]);
  }
  requireConsistent('静态站 X-Frame-Options', frameOptions);
}

/* ── 8. Worker 仓是否有测试 ─────────────────────────────────── */
{
  for (const repo of WORKERS) {
    if (!repos.includes(repo)) continue;
    if (!existsSync(join(root, repo, 'test'))) {
      fail(`${repo}: Worker 仓没有 test/ 目录`);
    }
  }
}

/* ── 输出 ────────────────────────────────────────────────────── */
console.log(`检查了 ${repos.length} 个仓：${repos.join(', ')}\n`);

if (notes.length) {
  console.log('一致项：');
  for (const n of notes) console.log(`  ✓ ${n}`);
  console.log('');
}

if (problems.length) {
  console.log('发现不一致：');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`\n共 ${problems.length} 处。`);
  process.exitCode = 1;
} else {
  console.log('未发现跨仓不一致。');
  process.exitCode = 0;
}
