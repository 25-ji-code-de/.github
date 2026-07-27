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

import { execFileSync } from 'node:child_process';
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
    assert.match(out, /validated 1 JSON file\(s\)/);
  });

  test('非法 JSON 被抓', () => {
    const { code, out } = check({ 'data/x.json': '{ not json }' });
    assert.equal(code, 1);
    assert.match(out, /x\.json/);
  });

  test('普通 .json 里的注释仍然算错', () => {
    // 只有官方允许注释的那几类才放行
    const { code, out } = check({ 'data/x.json': '{\n  // 注释\n  "a": 1\n}' });
    assert.equal(code, 1);
    assert.match(out, /x\.json/);
  });
});

describe('JSONC —— 官方允许注释的那几类', () => {
  /*
   * tsconfig.json / jsconfig.json / *.jsonc / .vscode/*.json 都是 JSONC。
   * 直接 JSON.parse 会把合法文件判成语法错误。nako 与 sekai-pass 的
   * tsconfig 里就有注释（解释了为什么开 allowImportingTsExtensions）。
   */
  const WITH_COMMENTS = [
    'tsconfig.json',
    'tsconfig.build.json',
    'jsconfig.json',
    'config/settings.jsonc',
    '.vscode/settings.json',
  ];

  for (const path of WITH_COMMENTS) {
    test(`${path} 允许注释`, () => {
      const { code, out } = check({
        [path]: '{\n  // 行注释\n  /* 块注释 */\n  "a": 1,\n}',
        _headers: GOOD_HEADERS,
      });
      assert.equal(code, 0, out);
    });
  }

  test('允许尾逗号', () => {
    const { code, out } = check({
      'tsconfig.json': '{\n  "a": 1,\n  "b": [1, 2,],\n}',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('字符串里的 // 不当作注释 —— JSON 里到处是 URL', () => {
    /*
     * 用正则粗暴去注释会把 "https://…" 从冒号后截断，
     * 于是一个完全合法的文件被判成语法错误。
     */
    const { code, out } = check({
      'tsconfig.json': '{\n  "url": "https://example.com/a//b",\n  "x": "/* 不是注释 */"\n}',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('转义引号不会让字符串状态错乱', () => {
    const { code, out } = check({
      'tsconfig.json': '{\n  "a": "他说 \\"//\\" 不是注释"\n}',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('JSONC 里真正的语法错误还是要报', () => {
    // 放行注释不等于放行一切
    const { code, out } = check({ 'tsconfig.json': '{\n  // 注释\n  "a": ,\n}' });
    assert.equal(code, 1);
    assert.match(out, /tsconfig\.json/);
  });

  test('日志里报出按 JSONC 处理的数量', () => {
    const { out } = check({
      'tsconfig.json': '{ "a": 1 }',
      'data/plain.json': '{ "b": 2 }',
      _headers: GOOD_HEADERS,
    });
    assert.match(out, /其中 1 个按 JSONC 处理/);
  });
});

describe('源码里的裸控制字符', () => {
  /*
   * 这类字符在源码里永远是错的或恶意的。真实案例：storage-worker 的测试
   * 文件里有两个裸 NUL（我自己写进去的），后果不是行为错，是
   * `grep sanitize` 直接回 "Binary file matches" —— 工具链全废。
   *
   * 需要它们作为数据时写 \u 转义。
   */
  const NUL = String.fromCharCode(0x00);
  const ESC = String.fromCharCode(0x1b);
  const DEL = String.fromCharCode(0x7f);
  const BOM = String.fromCharCode(0xfeff);
  const RLO = String.fromCharCode(0x202e);

  test('干净的源码通过', () => {
    const { code, out } = check({ 'js/a.js': "const s = '\\u0000';\n", _headers: GOOD_HEADERS });
    assert.equal(code, 0, out);
    assert.match(out, /scanned \d+ source file\(s\) for control chars, 0 found/);
  });

  test('裸 NUL 被抓，并给出行列', () => {
    const { code, out } = check({ 'js/a.js': `const s = 'a${NUL}b';\n` });
    assert.equal(code, 1);
    assert.match(out, /js[\\/]a\.js:1:\d+: 源码里有裸 NUL（U\+0000）/);
  });

  test('ESC 与 DEL 也被抓', () => {
    for (const [ch, name] of [[ESC, 'ESC'], [DEL, 'DEL']]) {
      const { code, out } = check({ 'js/a.js': `const s = 'x${ch}y';\n` });
      assert.equal(code, 1, name);
      assert.match(out, new RegExp(`裸 ${name}`));
    }
  });

  test('双向覆盖符被抓 —— 它能让显示顺序与执行顺序不一致', () => {
    const { code, out } = check({ 'js/a.js': `// ${RLO}nimda si resu fi\n` });
    assert.equal(code, 1);
    assert.match(out, /裸 RLO/);
  });

  test('文件中间的 BOM 被抓', () => {
    const { code, out } = check({ 'js/a.js': `const a = 1;\nconst b${BOM} = 2;\n` });
    assert.equal(code, 1);
    assert.match(out, /裸 BOM/);
  });

  test('文件首字节的 BOM 不在这里报 —— 那是 _headers 那一节的事', () => {
    const { code, out } = check({ 'js/a.js': `${BOM}const a = 1;\n`, _headers: GOOD_HEADERS });
    assert.equal(code, 0, out);
  });

  test('制表符与换行不算 —— 它们是正常排版', () => {
    const { code, out } = check({ 'js/a.js': 'const a = {\n\tb: 1,\n};\n', _headers: GOOD_HEADERS });
    assert.equal(code, 0, out);
  });

  test('NBSP 与全角空格不报 —— 它们有正当用途', () => {
    /*
     * 25ji 的 search.js 有 /　/g（匹配全角空格），
     * puzzle-sekai 的字体子集脚本里有 NBSP。报了只会逼人加豁免。
     * 可读性问题另说，但那不该由 CI 来拦。
     */
    const NBSP = String.fromCharCode(0x00a0);
    const IDEO = String.fromCharCode(0x3000);
    const { code, out } = check({
      'js/a.js': `const re = /${IDEO}/g;\nconst s = '${NBSP}';\n`,
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('多种扩展名都扫', () => {
    for (const path of ['a.js', 'a.css', 'a.md', 'a.yml', 'a.html']) {
      const { code } = check({ [path]: `x${NUL}y\n` });
      assert.equal(code, 1, path);
    }
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
    // 写 \ufeff 转义而不是字面 BOM —— 字面量在编辑器里完全不可见，
    // 读的人会以为这个 fixture 和普通的没区别
    const { code, out } = check({ _headers: `\ufeff${GOOD_HEADERS}` });
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

describe('有测试就得在 CI 里跑', () => {
  /*
   * 缘起：hub 与 25ji-sagyo 的 ci.yml 只调了共享的 static-check 工作流，
   * 而那个查的是跨仓一致性，不是本仓的测试。于是它们各自的测试文件一次都
   * 没在 CI 里跑过 —— 测试不跑就是装饰，而且是**看起来有保障**的装饰。
   *
   * 我手工查过一轮全生态，但那次犯了两个错：模式里漏了 `yarn test`
   * 导致误报 puzzle-sekai；以及读「当前检出的分支」而不是 main，
   * 导致误判。做成 per-repo 的 CI 检查之后这两个问题都不存在了 ——
   * 它跑在被检查的那个仓的那次 checkout 上。
   */
  const WF = '.github/workflows/ci.yml';

  test('没有测试文件 —— 跳过', () => {
    const { code, out } = check({ 'src/a.js': 'export const a = 1;\n', _headers: GOOD_HEADERS });
    assert.equal(code, 0, out);
    assert.match(out, /no test files/);
  });

  test('有测试但没有 workflows 目录 —— 报错', () => {
    const { code, out } = check({
      'test/a.test.mjs': 'export const t = 1;\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1);
    assert.match(out, /没有任何作业在跑它们/);
  });

  test('有测试、workflow 存在但不跑测试 —— 报错', () => {
    const { code, out } = check({
      'test/a.test.mjs': 'export const t = 1;\n',
      [WF]: 'name: CI\njobs:\n  check:\n    uses: org/.github/.github/workflows/static-check.yml@main\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1);
    assert.match(out, /1 个测试文件/);
  });

  for (const cmd of [
    'npm test',
    'npm run test',
    'yarn test',
    'pnpm test',
    'bun test',
    'node --test "test/*.test.mjs"',
    'npx vitest run',
    'npx jest',
    'cargo test',
    'deno test',
  ]) {
    test(`workflow 里写 \`${cmd}\` —— 通过`, () => {
      const { code, out } = check({
        'test/a.test.mjs': 'export const t = 1;\n',
        [WF]: `name: CI\njobs:\n  test:\n    steps:\n      - run: ${cmd}\n`,
        _headers: GOOD_HEADERS,
      });
      assert.equal(code, 0, out);
      assert.match(out, /CI 有跑/);
    });
  }

  test('像跑测试但不是的命令 —— 不算', () => {
    /*
     * `test\b` 里那个词边界是有意的：`npm run test-e2e` 算跑测试，
     * `npm run testfoo`、`npm run pretest` 不算。
     *
     * 这条是反向验证补出来的 —— 把 `test\b` 放宽成 `test` 之后，
     * 原有用例一条都没红，说明这个边界根本没被覆盖。
     */
    for (const cmd of ['npm run testfoo', 'npm run pretest', 'npm run latest']) {
      const { code, out } = check({
        'test/a.test.mjs': 'export const t = 1;\n',
        [WF]: `name: CI\njobs:\n  x:\n    steps:\n      - run: ${cmd}\n`,
        _headers: GOOD_HEADERS,
      });
      assert.equal(code, 1, `"${cmd}" 被当成了跑测试：${out}`);
    }
  });

  test('npm run test-e2e 这种带后缀的算跑测试', () => {
    const { code, out } = check({
      'test/a.test.mjs': 'export const t = 1;\n',
      [WF]: 'name: CI\njobs:\n  x:\n    steps:\n      - run: npm run test-e2e\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('测试文件按目录识别（test/ 下的任意 js）', () => {
    const { code } = check({
      'test/helpers.mjs': 'export const h = 1;\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1, 'test/ 目录下的文件应当算测试文件');
  });

  test('测试文件按后缀识别（src 里的 *.test.ts）', () => {
    const { code } = check({
      'src/a.test.ts': 'export const t = 1;\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1);
  });

  test('名字里带 test 但不是测试文件 —— 不算', () => {
    // `latest.js`、`contest.ts` 这种不该触发
    const { code, out } = check({
      'src/latest.js': 'export const v = 1;\n',
      'src/contest.ts': 'export const c = 1;\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
    assert.match(out, /no test files/);
  });

  test('.yaml 后缀的 workflow 也认', () => {
    const { code, out } = check({
      'test/a.test.mjs': 'export const t = 1;\n',
      '.github/workflows/ci.yaml': 'jobs:\n  test:\n    steps:\n      - run: npm test\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('多个 workflow 里只要有一个跑测试就算', () => {
    const { code, out } = check({
      'test/a.test.mjs': 'export const t = 1;\n',
      '.github/workflows/lint.yml': 'jobs:\n  lint:\n    steps:\n      - run: npm run lint\n',
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm test\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });
});

describe('D1 的 run() 结果：success 不是「改到了几行」', () => {
  /*
   * 缘起：sekai-pass 里同一个混淆出现了**三次**，后果一次比一次实在。
   *
   * `db.prepare(...).run()` 返回的 `success` 表示语句执行成功，
   * 删/改了 0 行也是 true。最狠的一处是 revokeRefreshToken 恒返回 true，
   * 导致 /oauth/revoke 里「撤 access token」那段在没有 hint 时**不可达**：
   * 不带 hint 撤一个 access token，服务器返回 200，而 token 一直有效到过期。
   *
   * 做成检查是因为**这个形状在源码里长得完全正常** —— 三个人看过都没发现，
   * 是写真 SQL 的测试时才炸出来的。
   */
  const D1_SRC = (body) =>
    `export async function revoke(db, token) {\n${body}\n}\n`;

  test('用 .run() 结果的 success 当判据 —— 报错', () => {
    const { code, out } = check({
      'src/tokens.js': D1_SRC(
        '  const result = await db.prepare("DELETE FROM t WHERE token = ?").bind(token).run();\n' +
          '  return result.success;',
      ),
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1, out);
    assert.match(out, /meta\.changes/);
  });

  test('改成 meta.changes —— 通过', () => {
    const { code, out } = check({
      'src/tokens.js': D1_SRC(
        '  const result = await db.prepare("DELETE FROM t WHERE token = ?").bind(token).run();\n' +
          '  return (result.meta?.changes ?? 0) > 0;',
      ),
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('if (!x.success) 形式也报', () => {
    const { code } = check({
      'src/a.js': D1_SRC(
        '  const r = await db.prepare("UPDATE t SET a = 1").run();\n' +
          '  if (!r.success) { throw new Error("x"); }\n  return true;',
      ),
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1);
  });

  test('外部 API 响应里的 success 不误报', () => {
    /*
     * Turnstile 的 siteverify 就返回 `{ success: boolean }`，那是合法的。
     * 判据是「这个变量来自 .run()」而不是「出现了 .success」——
     * 后者会把 sekai-pass 的 turnstile.ts 与 api.ts 全部误报进来。
     */
    const { code, out } = check({
      'src/turnstile.js':
        'export async function verify(token) {\n' +
        '  const data = await (await fetch("https://x/siteverify")).json();\n' +
        '  if (!data.success) { return false; }\n  return true;\n}\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('同名变量但不是 run() 的结果，不误报', () => {
    // 只看变量名会把这种也算上
    const { code, out } = check({
      'src/a.js':
        'export function f(result) {\n  return result.success;\n}\n' +
        'export async function g(db) { await db.prepare("SELECT 1").run(); }\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });

  test('测试文件里不检查', () => {
    // 测试里为了构造场景写什么都行
    const { code, out } = check({
      'test/a.test.mjs': D1_SRC(
        '  const result = await db.prepare("DELETE FROM t").run();\n  return result.success;',
      ),
      '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 0, out);
  });
});

describe('git 检出里只看跟踪的文件', () => {
  /*
   * 缘起：这个脚本原本遍历整个工作区。CI 里没问题（干净检出，
   * 工作区 == 跟踪的文件），但在开发者机器上：
   *
   *   docs          docs/.vitepress/dist/  → 2 处误报
   *   puzzle-sekai  src-tauri/target/      → **170490 处**误报
   *   三个 Worker 仓 .wrangler/            → 每处形状翻倍
   *
   * 全是 gitignore 掉的构建产物。后果不是「多打几行」，是**这个检查在
   * 本地完全没法用** —— 而没法用的检查等于没有，还会训练人跳过输出。
   *
   * 下面这几条覆盖的是**新加的那条路径**：fixture 默认不是 git 仓库，
   * 走的是回退分支，所以不 git init 的话这条路径一行都没被跑到。
   */
  const git = (root, ...args) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });

  /** 建一个 git 仓库 fixture，只把 `tracked` 列出的文件加进索引。 */
  function gitFixture(files, tracked) {
    const root = fixture(files);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@example.test');
    git(root, 'config', 'user.name', 'test');
    for (const f of tracked) git(root, 'add', '--', f);
    git(root, 'commit', '-q', '-m', 'init');
    return root;
  }

  test('未跟踪的坏文件被跳过', () => {
    const root = gitFixture(
      {
        'src/good.js': 'export const a = 1;\n',
        'dist/bundle.js': 'this is ( not valid javascript\n',
        _headers: GOOD_HEADERS,
      },
      ['src/good.js', '_headers'],
    );
    try {
      const { code, out } = run('static-check.mjs', [root]);
      assert.equal(code, 0, out);
      assert.ok(!out.includes('bundle.js'), '扫到了未跟踪的构建产物');
    } finally {
      cleanup(root);
    }
  });

  test('跟踪的坏文件照样报', () => {
    // 反过来钉：不能因为「按跟踪文件走」就把该报的也漏掉
    const root = gitFixture(
      {
        'src/bad.js': 'this is ( not valid javascript\n',
        _headers: GOOD_HEADERS,
      },
      ['src/bad.js', '_headers'],
    );
    try {
      const { code, out } = run('static-check.mjs', [root]);
      assert.equal(code, 1, out);
      assert.match(out, /bad\.js/);
    } finally {
      cleanup(root);
    }
  });

  test('不在 git 检出里时退回遍历工作区', () => {
    /*
     * 这条钉的是回退分支本身。没有它的话，把 trackedFiles() 改成
     * 「永远返回空集合」会让所有检查静默地什么都不扫 —— 而测试全绿，
     * 因为大部分 fixture 本来就期望「通过」。
     */
    const { code, out } = check({
      'src/bad.js': 'this is ( not valid javascript\n',
      _headers: GOOD_HEADERS,
    });
    assert.equal(code, 1, out);
    assert.match(out, /bad\.js/);
  });
});
