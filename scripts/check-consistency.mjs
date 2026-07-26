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
 * 生态里已经因为缺这层检查踩过：五份漂移的 auth 客户端、三种互不兼容的
 * 错误信封、跨越两年的 compatibility_date、指向旧账号的 repository 字段。
 *
 * 用法：
 *   node check-consistency.mjs <checkout-root>
 *
 * <checkout-root> 下每个子目录是一个仓库的检出。
 */

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';

const root = argv[2] || '.';

/**
 * 不参与一致性约束的仓。
 *
 * 现在是空的。puzzle-sekai 曾经在这里 —— 那时维护者要求不要动它，
 * 后来解除了。**这个豁免掩盖了一个真问题**：它是生态里第五份独立的
 * auth 客户端实现，而排除在外意味着检查器从来没数到它。
 *
 * 所以往这里加仓要慎重：被排除的仓不是"没问题"，只是"看不见"。
 * 真要豁免，优先在**具体某一项检查**里跳过，而不是整仓排除。
 */
const EXCLUDED = new Set();

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

/*
 * 只有含 .git 的目录才算一个仓库的检出。
 *
 * 早先这里是"根目录下的任意子目录"，于是本地检出根里随便一个临时目录
 * 都会被当成仓库，然后报一堆"缺少社区文件"的假阳性。CI 里因为是逐仓
 * checkout 所以看不出来，本地跑就会踩到 —— 而本地跑恰恰是这个脚本
 * 最该好用的场景。
 */
const repos = readdirSync(root).filter((name) => {
  const p = join(root, name);
  if (name.startsWith('.') || EXCLUDED.has(name)) return false;
  if (!statSync(p).isDirectory()) return false;
  return existsSync(join(p, '.git'));
});

if (!repos.length) {
  console.error(`${root} 下没有找到任何仓库检出（判据：子目录含 .git）`);
  process.exit(1);
}

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

/* ── 5. package.json 的 author / repository / license ─────────
 *
 * repository 缺失不只是元数据不全：`npm view`、GitHub 的包关联、以及
 * 生态内 `github:` 形式的依赖解析都靠它。author 缺失则让"这是谁的东西"
 * 在不同仓给出不同答案。
 */
{
  const authors = [];
  for (const repo of repos) {
    const pkg = readJson(repo, 'package.json');
    if (!pkg) continue;

    if (pkg.author) authors.push([repo, pkg.author]);
    else fail(`${repo}/package.json: 缺少 author`);

    const url = pkg.repository?.url ?? pkg.repository;
    if (typeof url !== 'string') {
      fail(`${repo}/package.json: 缺少 repository`);
    } else {
      const m = url.match(/github\.com[/:]([^/]+)\//);
      if (m && m[1] !== '25-ji-code-de') {
        fail(`${repo}/package.json: repository 指向 ${m[1]}，应为 25-ji-code-de`);
      }
      if (!url.startsWith('git+')) {
        fail(`${repo}/package.json: repository.url 应以 git+ 开头 — 当前 ${url}`);
      }
    }

    // license 字段与 LICENSE 正文必须说的是同一件事。
    // 生态内各仓的授权本就不同（应用 AGPL、SDK Apache、docs CC-BY），
    // 这里不要求跨仓一致，只要求**同一个仓内部**不自相矛盾。
    const licenseText = read(repo, 'LICENSE');
    if (licenseText) {
      const expect = /GNU AFFERO/i.test(licenseText)
        ? 'AGPL-3.0-only'
        : /Apache License/i.test(licenseText)
          ? 'Apache-2.0'
          : /^MIT License/im.test(licenseText)
            ? 'MIT'
            : /Creative Commons Attribution 4\.0/i.test(licenseText)
              ? 'CC-BY-4.0'
              : null;
      if (expect && pkg.license !== expect) {
        fail(
          `${repo}/package.json: license 字段为 ${JSON.stringify(pkg.license ?? null)}，` +
            `但 LICENSE 正文是 ${expect}`,
        );
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

/* ── 8. lockfile ─────────────────────────────────────────────
 *
 * sekai-pass 曾把 package-lock.json 写进 .gitignore，导致
 * actions/setup-node 的 `cache: npm` 在 CI 里直接失败（"lock file is not
 * found"），而且失败发生在 setup 阶段 —— 名为 "typecheck" 的 check 其实
 * 从来没执行过类型检查。这类问题应该被自动发现，而不是靠翻日志。
 */
{
  const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
  for (const repo of repos) {
    const pkg = readJson(repo, 'package.json');
    if (!pkg) continue;

    const depCount =
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;

    // CI 里用了 setup-node 的 cache: npm 就必须有 lockfile，否则 setup 阶段直接失败
    let usesNpmCache = false;
    const wfDir = join(root, repo, '.github', 'workflows');
    if (existsSync(wfDir)) {
      usesNpmCache = readdirSync(wfDir).some((file) =>
        /cache:\s*npm/.test(read(repo, join('.github', 'workflows', file)) ?? ''),
      );
    }

    const present = LOCKFILES.filter((f) => existsSync(join(root, repo, f)));

    if (present.length === 0) {
      // 零依赖的包（如两个 SDK）本来就没有 lockfile，这是正常的
      if (usesNpmCache) {
        fail(`${repo}: CI 用了 setup-node 的 cache: npm 但仓库里没有 lockfile — setup 阶段会直接失败`);
      } else if (depCount > 0) {
        fail(`${repo}: 有 ${depCount} 个依赖但没有提交 lockfile，依赖不锁定`);
      }
    } else if (present.length > 1) {
      fail(`${repo}: 同时存在多个 lockfile — ${present.join(', ')}`);
    }

    if (depCount > 0) {
      const gitignore = read(repo, '.gitignore') ?? '';
      for (const lock of LOCKFILES) {
        if (new RegExp(`^${lock.replace(/\./g, '\\.')}\\s*$`, 'm').test(gitignore)) {
          fail(`${repo}/.gitignore: 忽略了 ${lock}。本仓是要部署的应用，应锁定依赖`);
        }
      }
    }
  }
}

/* ── 9. Worker 仓是否有测试 ─────────────────────────────────── */
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

/* 同时写进 GitHub 的 job summary，省得每次翻日志。 */
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    '# 跨仓一致性检查',
    '',
    `检查了 **${repos.length}** 个仓：${repos.map((r) => `\`${r}\``).join('、')}`,
    '',
  ];
  if (problems.length) {
    md.push(`## ❌ 发现 ${problems.length} 处不一致`, '');
    for (const p of problems) {
      const [head, ...rest] = p.split('\n');
      md.push(`- **${head}**`);
      if (rest.length) md.push('', '  ```', ...rest.map((l) => `  ${l}`), '  ```', '');
    }
    md.push('');
  } else {
    md.push('## ✅ 未发现跨仓不一致', '');
  }
  if (notes.length) {
    md.push('<details><summary>已确认一致的项</summary>', '');
    for (const n of notes) md.push(`- ${n}`);
    md.push('', '</details>');
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
}
