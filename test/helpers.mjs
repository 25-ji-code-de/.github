/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 建临时 fixture 目录、跑脚本、拿回输出的共用工具。 */

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/**
 * 按 `{ '相对路径': '内容' }` 铺一棵目录树，返回根路径。
 * 内容为对象时按 JSON 序列化。
 */
export function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'sekai-fixture-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** 跑脚本，返回 `{ code, out }`（stdout 与 stderr 合并，便于断言）。 */
export function run(script, args) {
  try {
    const out = execFileSync(process.execPath, [join(SCRIPTS, script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 一个各项都合规的仓，用作"只改一处"的基线。 */
export function goodRepo(prefix = 'fixture', overrides = {}) {
  const base = {
    [`${prefix}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${prefix}/LICENSE`]: 'Apache License\nVersion 2.0, January 2004\n',
    [`${prefix}/README.md`]: '# fixture\n',
    [`${prefix}/CONTRIBUTING.md`]: '# Contributing\n',
    [`${prefix}/SECURITY.md`]: '# Security\n',
    [`${prefix}/CODE_OF_CONDUCT.md`]: '# CoC\n',
    [`${prefix}/package.json`]: {
      name: prefix,
      author: 'The 25-ji-code-de Team',
      repository: { type: 'git', url: `git+https://github.com/25-ji-code-de/${prefix}.git` },
      license: 'Apache-2.0',
    },
  };
  return { ...base, ...overrides };
}
