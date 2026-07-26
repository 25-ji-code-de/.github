/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * static-check.mjs 的回归测试。
 *
 * 这个脚本被 4 个仓当 reusable workflow 调用，坏一次就是 4 个仓一起红 ——
 * 而它此前也是零测试。它的前身内联在 workflow 的 `node -e '...'` 里，
 * 被 bash 单引号坑过一次（CSP 正则里的字面 `'self'` 截断了字符串），
 * 那次就是因为没有任何测试才拖到 CI 全红才发现。
 *
 * 注意：内联 SDK 的检查会发真实网络请求，所以这里的 fixture 一律
 * **不带** `@sekai-vendor` 标记，只测那条不需要联网的分支。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fixture, cleanup, run } from './helpers.mjs';

const SCRIPT = 'static-check.mjs';

function check(files, extraArgs = []) {
  const root = fixture(files);
  try {
    return run(SCRIPT, [root, ...extraArgs]);
  } finally {
    cleanup(root);
  }
}

/** 合规的 _headers 基线，"只改一处"用。 */
const GOOD_HEADERS = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  X-Frame-Options: DENY',
  '  Permissions-Policy: camera=(), microphone=()',
  "  Content-Security-Policy: default-src 'self'; object-src 'none'; frame-ancestors 'none'",
  '',
].join('\n');

describe('JavaScript 语法', () => {
  test('合法 JS 通过', () => {
    const { code, out } = check({ 'js/app.js': 'export const a = 1;\n' });
    assert.equal(code, 0);
    assert.match(out, /checked 1 JavaScript file\(s\), 0 failed/);
  });

  test('语法错误被抓', () => {
    const { code, out } = check({ 'js/broken.js': 'function ( { \n' });
    assert.equal(code, 1);
    assert.match(out, /broken\.js: JavaScript 语法错误/);
  });

  test('.mjs 也检查', () => {
    const { code } = check({ 'scripts/x.mjs': 'const = ;\n' });
    assert.equal(code, 1);
  });

  test('默认忽略 node_modules / libs / .min.js', () => {
    const { code, out } = check({
      'node_modules/pkg/broken.js': 'function ( {\n',
      'js/libs/vendor.js': 'function ( {\n',
      'js/thing.min.js': 'function ( {\n',
      'js/ok.js': 'const a = 1;\n',
    });
    assert.equal(code, 0);
    assert.match(out, /checked 1 JavaScript file\(s\)/);
  });

  test('自定义 ignore 正则生效', () => {
    const { code } = check({ 'generated/broken.js': 'function ( {\n' }, ['generated']);
    assert.equal(code, 0);
  });
});

describe('JSON 合法性', () => {
  test('合法 JSON 通过', () => {
    const { code, out } = check({ 'data/x.json': '{"a":1}' });
    assert.equal(code, 0);
    assert.match(out, /validated 1 JSON file\(s\), 0 failed/);
  });

  test('非法 JSON 被抓', () => {
    const { code, out } = check({ 'data/x.json': '{ not json }' });
    assert.equal(code, 1);
    assert.match(out, /x\.json/);
  });
});

describe('_headers —— 结构', () => {
  test('合规的 _headers 通过', () => {
    const { code, out } = check({ _headers: GOOD_HEADERS });
    assert.equal(code, 0);
    assert.match(out, /_headers: 1 条路径规则，安全头齐全/);
  });

  test('没有 _headers 时跳过而不是报错', () => {
    const { code, out } = check({ 'js/a.js': 'const a=1;\n' });
    assert.equal(code, 0);
    assert.match(out, /no _headers file — skipping/);
  });

  test('同一路径出现两个块会报（Pages 的合并语义踩过坑）', () => {
    const { code, out } = check({
      _headers: `${GOOD_HEADERS}\n/*\n  X-Extra: 1\n`,
    });
    assert.equal(code, 1);
    assert.match(out, /路径规则 "\/\*" 重复/);
  });

  test('带 BOM 会报', () => {
    const { code, out } = check({ _headers: `﻿${GOOD_HEADERS}` });
    assert.equal(code, 1);
    assert.match(out, /带 UTF-8 BOM/);
  });

  test('头部行出现在任何路径规则之前会报', () => {
    const { code, out } = check({ _headers: '  X-Frame-Options: DENY\n' });
    assert.equal(code, 1);
    assert.match(out, /头部行出现在任何路径规则之前/);
  });

  test('头部行格式错误会报', () => {
    const { code, out } = check({ _headers: '/*\n  这不是一个头部行\n' });
    assert.equal(code, 1);
    assert.match(out, /头部行格式错误/);
  });

  test('注释与空行不影响解析', () => {
    const { code } = check({ _headers: `# 说明\n\n${GOOD_HEADERS}\n# 尾注\n` });
    assert.equal(code, 0);
  });

  test('CRLF 换行也能解析', () => {
    const { code } = check({ _headers: GOOD_HEADERS.replace(/\n/g, '\r\n') });
    assert.equal(code, 0);
  });
});

describe('_headers —— 安全头与 CSP', () => {
  test('缺必需安全头会报', () => {
    const { code, out } = check({ _headers: '/*\n  X-Frame-Options: DENY\n' });
    assert.equal(code, 1);
    assert.match(out, /缺少必需的安全头 X-Content-Type-Options/);
    assert.match(out, /缺少必需的安全头 Permissions-Policy/);
  });

  test('CSP 未知指令会报 —— 写错只会静默失效', () => {
    const { code, out } = check({
      _headers: GOOD_HEADERS.replace('object-src', 'objekt-src'),
    });
    assert.equal(code, 1);
    assert.match(out, /未知指令 "objekt-src"/);
  });

  test('CSP 重复指令会报', () => {
    const { code, out } = check({
      _headers: GOOD_HEADERS.replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'none'; object-src 'self'",
      ),
    });
    assert.equal(code, 1);
    assert.match(out, /重复指令 object-src/);
  });

  test('CSP 里可疑来源会报', () => {
    const { code, out } = check({
      _headers: GOOD_HEADERS.replace("default-src 'self'", 'default-src self'),
    });
    assert.equal(code, 1);
    // 少写一对引号的 self 是最常见的 CSP 笔误，它会被当成主机名
    assert.match(out, /可疑来源 "self"/);
  });

  test('合法来源形式全部接受', () => {
    const sources = [
      "'self'", "'none'", "'unsafe-inline'", 'data:', 'blob:', 'https:',
      'https://cdn.example.com', "'sha256-abc123='", '*',
    ].join(' ');
    const { code, out } = check({
      _headers: GOOD_HEADERS.replace("default-src 'self'", `default-src ${sources}`),
    });
    assert.equal(code, 0, out);
  });

  test('Report-Only 的 CSP 一样检查', () => {
    const { code, out } = check({
      _headers: `${GOOD_HEADERS}  Content-Security-Policy-Report-Only: bogus-src 'self'\n`,
    });
    assert.equal(code, 1);
    assert.match(out, /Content-Security-Policy-Report-Only: 未知指令 "bogus-src"/);
  });
});

describe('内联 SDK 标记', () => {
  test('未知的内联包会报（不联网）', () => {
    const { code, out } = check({
      'js/vendor.js': '// @sekai-vendor @someone/not-ours@v1 dist/x.js\nvoid 0;\n',
    });
    assert.equal(code, 1);
    assert.match(out, /未知的内联包 @someone\/not-ours/);
  });

  test('CSS 里的块注释标记同样被识别', () => {
    // 各前端开始 vendored sekai-design 的 token 之后，
    // "复制粘贴之后没人知道什么时候开始不一样了"会原样搬到样式上
    const { code, out } = check({
      'css/sekai/contract.css': '/* @sekai-vendor @someone/not-ours@v1 tokens/contract.css */\n:root{}\n',
    });
    assert.equal(code, 1);
    assert.match(out, /未知的内联包 @someone\/not-ours/);
  });

  test('sekai-design 在已知包列表里', () => {
    // 不在的话，等各仓加上标记那天，四个用了这个 reusable workflow 的仓
    // 会一起报"未知的内联包"—— 加标记的人多半不会想到要先改这里
    const { out } = check({
      'css/x.css': '/* @sekai-vendor @25-ji-code-de/sekai-design@v0.0.0-nonexistent tokens/contract.css */\n:root{}\n',
    });
    assert.doesNotMatch(out, /未知的内联包/, 'sekai-design 应当是已知包');
    // tag 不存在 → 拉取失败，这说明它确实走到了联网比对那一步
    assert.match(out, /无法拉取/);
  });

  test('没有标记的 CSS 不受影响', () => {
    // 绝大多数 CSS 是本仓自己写的，不该因为扩到 .css 就被卷进来
    const { code, out } = check({
      'css/app.css': ':root { --x: 1px; }\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0);
    assert.match(out, /checked 0 vendored file\(s\)/);
  });

  test('CSS 标记必须独占一行 —— 行尾的注释不算', () => {
    /*
     * 关键在于正则的行锚点。写在规则行尾的注释不该把整个文件
     * 变成"vendored 文件"—— 那会让本仓自己写的样式被拿去和上游比对。
     *
     * fixture 必须真的碰到锚点：`/*` 前面有内容、但紧跟着就是
     * `@sekai-vendor`。第一版写的是 `/* 见 @sekai-vendor …`，
     * 那个 `见` 字本身就让正则匹配不上，锚点根本没被测到 ——
     * 去掉锚点测试照样全绿，是反向验证抓出来的。
     */
    const { code, out } = check({
      'css/app.css':
        ':root{} /* @sekai-vendor @25-ji-code-de/sekai-design@v1 tokens/contract.css */\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
    assert.match(out, /checked 0 vendored file\(s\)/);
  });

  test('文档性注释里提到 @sekai-vendor 也不算', () => {
    const { code, out } = check({
      'css/app.css': '/* 见 @sekai-vendor 机制的说明 */\n:root{}\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
    assert.match(out, /checked 0 vendored file\(s\)/);
  });
});
