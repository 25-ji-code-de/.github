/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * check-consistency.mjs 的回归测试。
 *
 * 这个脚本是**全生态唯一**能看见跨仓漂移的东西，而它自己此前没有任何测试。
 * 一条规则悄悄失效不会有人发现 —— 每天的定时任务照样绿，只是什么都没检查出来。
 * 所以每条规则都要有一个"违规必报"和一个"合规不报"的用例。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fixture, cleanup, run, goodRepo } from './helpers.mjs';

const SCRIPT = 'check-consistency.mjs';

/** 铺一个 fixture 根、跑检查、清理，返回 `{ code, out }`。 */
function check(files) {
  const root = fixture(files);
  try {
    return run(SCRIPT, [root]);
  } finally {
    cleanup(root);
  }
}

describe('仓库发现', () => {
  test('只把含 .git 的目录当仓库', () => {
    // 检出根里没有 .git 的散目录（半克隆、临时导出、正在初始化的新仓）
    // 不该被当成仓库报"缺社区文件"
    const { out } = check({
      ...goodRepo('real'),
      'stray/tokens/primitives.css': ':root{}\n',
    });
    assert.match(out, /检查了 1 个仓：real/);
    assert.doesNotMatch(out, /stray/);
  });

  test('根目录下没有仓库时报错退出', () => {
    const { code, out } = check({ 'nothing/here.txt': 'x' });
    assert.equal(code, 1);
    assert.match(out, /没有找到任何仓库检出/);
  });

  test('全部合规时零问题退出', () => {
    const { code, out } = check(goodRepo());
    assert.equal(code, 0);
    assert.match(out, /未发现跨仓不一致/);
  });
});

describe('package.json 元数据', () => {
  test('缺 author 会报', () => {
    const { code, out } = check(
      goodRepo('a', { 'a/package.json': { name: 'a', license: 'Apache-2.0',
        repository: { type: 'git', url: 'git+https://github.com/25-ji-code-de/a.git' } } }),
    );
    assert.equal(code, 1);
    assert.match(out, /a\/package\.json: 缺少 author/);
  });

  test('缺 repository 会报', () => {
    const { code, out } = check(
      goodRepo('a', { 'a/package.json': { name: 'a', author: 'The 25-ji-code-de Team', license: 'Apache-2.0' } }),
    );
    assert.equal(code, 1);
    assert.match(out, /a\/package\.json: 缺少 repository/);
  });

  test('repository 指向别的账号会报', () => {
    const { code, out } = check(
      goodRepo('a', { 'a/package.json': { name: 'a', author: 'The 25-ji-code-de Team', license: 'Apache-2.0',
        repository: { type: 'git', url: 'git+https://github.com/someone-else/a.git' } } }),
    );
    assert.equal(code, 1);
    assert.match(out, /指向 someone-else，应为 25-ji-code-de/);
  });

  test('repository.url 少 git+ 前缀会报', () => {
    const { code, out } = check(
      goodRepo('a', { 'a/package.json': { name: 'a', author: 'The 25-ji-code-de Team', license: 'Apache-2.0',
        repository: { type: 'git', url: 'https://github.com/25-ji-code-de/a.git' } } }),
    );
    assert.equal(code, 1);
    assert.match(out, /应以 git\+ 开头/);
  });

  test('author 跨仓不一致会报', () => {
    const { code, out } = check({
      ...goodRepo('a'),
      ...goodRepo('b', { 'b/package.json': { name: 'b', author: 'Someone Else', license: 'Apache-2.0',
        repository: { type: 'git', url: 'git+https://github.com/25-ji-code-de/b.git' } } }),
    });
    assert.equal(code, 1);
    assert.match(out, /package\.json author: 出现 2 个不同的值/);
  });
});

describe('license 字段与 LICENSE 正文', () => {
  const CASES = [
    ['Apache 正文 + MIT 字段', 'Apache License\nVersion 2.0\n', 'MIT', /LICENSE 正文是 Apache-2\.0/],
    ['AGPL 正文 + 无字段', 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\n', undefined, /LICENSE 正文是 AGPL-3\.0-only/],
    ['MIT 正文 + Apache 字段', 'MIT License\n\nCopyright\n', 'Apache-2.0', /LICENSE 正文是 MIT/],
    ['CC-BY 正文 + 无字段', 'Creative Commons Attribution 4.0 International License\n', undefined, /LICENSE 正文是 CC-BY-4\.0/],
  ];

  for (const [label, licenseText, licenseField, expected] of CASES) {
    test(`${label} → 报矛盾`, () => {
      const { code, out } = check(
        goodRepo('a', {
          'a/LICENSE': licenseText,
          'a/package.json': { name: 'a', author: 'The 25-ji-code-de Team', license: licenseField,
            repository: { type: 'git', url: 'git+https://github.com/25-ji-code-de/a.git' } },
        }),
      );
      assert.equal(code, 1);
      assert.match(out, expected);
    });
  }

  test('对得上时不报 —— 各仓授权本就不同，不要求跨仓一致', () => {
    const { code } = check({
      ...goodRepo('sdk'),
      ...goodRepo('app', {
        'app/LICENSE': 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\n',
        'app/package.json': { name: 'app', author: 'The 25-ji-code-de Team', license: 'AGPL-3.0-only',
          repository: { type: 'git', url: 'git+https://github.com/25-ji-code-de/app.git' } },
      }),
    });
    assert.equal(code, 0);
  });

  test('无法识别的 LICENSE 正文不做判断', () => {
    const { code } = check(
      goodRepo('a', { 'a/LICENSE': '本项目版权归…（自定义条款）\n' }),
    );
    assert.equal(code, 0);
  });
});

describe('其它规则', () => {
  test('缺社区文件会报', () => {
    const files = goodRepo('a');
    delete files['a/SECURITY.md'];
    delete files['a/CODE_OF_CONDUCT.md'];
    const { code, out } = check(files);
    assert.equal(code, 1);
    assert.match(out, /a: 缺少社区文件 — SECURITY\.md, CODE_OF_CONDUCT\.md/);
  });

  test('同一仓内 CI 用了多个 Node 版本会报', () => {
    const { code, out } = check(
      goodRepo('a', {
        'a/.github/workflows/ci.yml': "      node-version: '24'\n",
        'a/.github/workflows/nightly.yml': '      node-version: 22\n',
      }),
    );
    assert.equal(code, 1);
    assert.match(out, /a: 同一仓内 CI 使用了多个 Node 版本/);
  });

  test('跨仓 Node 版本不一致会报', () => {
    const { code, out } = check({
      ...goodRepo('a', { 'a/.github/workflows/ci.yml': "      node-version: '24'\n" }),
      ...goodRepo('b', { 'b/.github/workflows/ci.yml': "      node-version: '20'\n" }),
    });
    assert.equal(code, 1);
    assert.match(out, /CI Node 版本: 出现 2 个不同的值/);
  });

  test('内联 SDK 的 tag 不一致会报', () => {
    const vendored = (tag) =>
      `// @sekai-vendor @25-ji-code-de/sekai-auth@${tag} dist/sekai-auth.global.js\nvoid 0;\n`;
    const { code, out } = check({
      ...goodRepo('a', { 'a/js/libs/sekai-auth.js': vendored('v0.1.2') }),
      ...goodRepo('b', { 'b/js/libs/sekai-auth.js': vendored('v0.1.1') }),
    });
    assert.equal(code, 1);
    assert.match(out, /内联 @25-ji-code-de\/sekai-auth 的版本: 出现 2 个不同的值/);
  });

  test('生态内 SDK 依赖版本不一致会报', () => {
    const pkg = (name, spec) => ({
      name, author: 'The 25-ji-code-de Team', license: 'Apache-2.0',
      repository: { type: 'git', url: `git+https://github.com/25-ji-code-de/${name}.git` },
      dependencies: { '@25-ji-code-de/sekai-worker-kit': spec },
    });
    const { code, out } = check({
      ...goodRepo('a', { 'a/package.json': pkg('a', 'github:25-ji-code-de/sekai-worker-kit#v0.1.1') }),
      ...goodRepo('b', { 'b/package.json': pkg('b', 'github:25-ji-code-de/sekai-worker-kit#v0.1.0') }),
    });
    assert.equal(code, 1);
    assert.match(out, /依赖 @25-ji-code-de\/sekai-worker-kit 的版本: 出现 2 个不同的值/);
  });

  test('compatibility_date 不一致会报', () => {
    const { code, out } = check({
      ...goodRepo('a', { 'a/wrangler.toml.example': 'compatibility_date = "2026-02-10"\n' }),
      ...goodRepo('b', { 'b/wrangler.toml.example': 'compatibility_date = "2024-01-01"\n' }),
    });
    assert.equal(code, 1);
    assert.match(out, /wrangler compatibility_date: 出现 2 个不同的值/);
  });

  test('有依赖却没有 lockfile 会报', () => {
    const { code, out } = check(
      goodRepo('a', {
        'a/package.json': { name: 'a', author: 'The 25-ji-code-de Team', license: 'Apache-2.0',
          repository: { type: 'git', url: 'git+https://github.com/25-ji-code-de/a.git' },
          dependencies: { hono: '^4.0.0' } },
      }),
    );
    assert.equal(code, 1);
    assert.match(out, /有 1 个依赖但没有提交 lockfile/);
  });

  test('零依赖没有 lockfile 是正常的', () => {
    const { code } = check(goodRepo());
    assert.equal(code, 0);
  });

  test('CI 用了 cache: npm 却没有 lockfile 会报', () => {
    const { code, out } = check(
      goodRepo('a', { 'a/.github/workflows/ci.yml': "        with:\n          cache: npm\n" }),
    );
    assert.equal(code, 1);
    assert.match(out, /cache: npm 但仓库里没有 lockfile/);
  });

  test('.gitignore 忽略 lockfile 会报', () => {
    const { code, out } = check(
      goodRepo('a', {
        'a/.gitignore': 'node_modules/\npackage-lock.json\n',
        'a/package-lock.json': '{"lockfileVersion":3}',
        'a/package.json': { name: 'a', author: 'The 25-ji-code-de Team', license: 'Apache-2.0',
          repository: { type: 'git', url: 'git+https://github.com/25-ji-code-de/a.git' },
          dependencies: { hono: '^4.0.0' } },
      }),
    );
    assert.equal(code, 1);
    assert.match(out, /忽略了 package-lock\.json/);
  });

  test('同时存在多个 lockfile 会报', () => {
    const { code, out } = check(
      goodRepo('a', {
        'a/package-lock.json': '{}',
        'a/yarn.lock': '',
      }),
    );
    assert.equal(code, 1);
    assert.match(out, /同时存在多个 lockfile/);
  });

  test('package.json 不是合法 JSON 会报', () => {
    const { code, out } = check(goodRepo('a', { 'a/package.json': '{ not json' }));
    assert.equal(code, 1);
    assert.match(out, /a\/package\.json: 不是合法 JSON/);
  });
});

describe('已知仓的定向规则', () => {
  test('静态站缺 _headers 会报', () => {
    const { code, out } = check(goodRepo('hub'));
    assert.equal(code, 1);
    assert.match(out, /hub: 静态站缺少 _headers/);
  });

  test('静态站 _headers 缺安全头会报', () => {
    const { code, out } = check(
      goodRepo('hub', { 'hub/_headers': '/*\n  X-Frame-Options: DENY\n' }),
    );
    assert.equal(code, 1);
    assert.match(out, /hub\/_headers: 缺少安全头/);
  });

  test('静态站之间 X-Frame-Options 不一致会报', () => {
    const headers = (v) =>
      `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n` +
      `  X-Frame-Options: ${v}\n  Permissions-Policy: camera=()\n`;
    const { code, out } = check({
      ...goodRepo('hub', { 'hub/_headers': headers('DENY') }),
      ...goodRepo('stickers', { 'stickers/_headers': headers('SAMEORIGIN') }),
    });
    assert.equal(code, 1);
    assert.match(out, /静态站 X-Frame-Options: 出现 2 个不同的值/);
  });

  test('Worker 仓没有 test/ 会报', () => {
    const { code, out } = check(goodRepo('nako'));
    assert.equal(code, 1);
    assert.match(out, /nako: Worker 仓没有 test\/ 目录/);
  });

  test('Worker 仓有 test/ 就不报', () => {
    const { code } = check(goodRepo('nako', { 'nako/test/smoke.test.mjs': '\n' }));
    assert.equal(code, 0);
  });
});
