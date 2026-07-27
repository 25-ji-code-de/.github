/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `check-production.mjs` 自己的测试。
 *
 * ── 为什么必须用假的 fetch ──────────────────────────────────────
 *
 * 这个脚本是拿真实 HTTP 响应去核对契约的。要验它**自己**写得对不对，
 * 只能喂给它构造好的响应 —— 靠"真的去请求线上"验有两个致命问题：
 *
 *   1. 线上恰好是好的时候，检查器怎么写都绿（包括写成 `return true`）
 *   2. 线上坏了的时候，分不清是线上坏了还是检查器坏了
 *
 * 今天在生态里已经因为「假 db 看不见 WHERE」栽过一次
 * （sekai-worker-kit：JOIN 与整条 WHERE 删掉，旧测试 0 红）。
 * 这里反过来：**要验的是检查逻辑，所以外部世界必须是可控的。**
 *
 * 每一条测试都对应一个**真实发生过**的线上故障（2026-07-27 实测）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runChecks } from '../scripts/check-production.mjs';

/** 只放一个主机，让「主机可达」那组的结果可数。 */
const HOSTS = { pass: 'https://pass.test' };

/** 一份各项都达标的世界，测试按需覆盖其中某一条。 */
function goodWorld(overrides = {}) {
  const discovery = {
    issuer: 'https://pass.test',
    jwks_uri: 'https://pass.test/.well-known/jwks.json',
    scopes_supported: ['openid', 'profile'],
    id_token_signing_alg_values_supported: ['ES256'],
    ...(overrides.discovery ?? {}),
  };
  const asMeta = {
    issuer: 'https://pass.test',
    scopes_supported: ['openid', 'profile'],
    ...(overrides.asMeta ?? {}),
  };
  const jwks = overrides.jwks ?? { keys: [{ kid: 'a', alg: 'ES256', kty: 'EC' }] };

  const routes = {
    'https://pass.test/': { status: 200, headers: { 'x-frame-options': 'DENY' } },
    'https://pass.test/.well-known/openid-configuration': { status: 200, json: discovery },
    'https://pass.test/.well-known/oauth-authorization-server': { status: 200, json: asMeta },
    'https://pass.test/.well-known/jwks.json': { status: 200, json: jwks },
    'https://pass.test/oauth/userinfo': {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer',
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
      },
    },
    ...(overrides.routes ?? {}),
  };

  return async function get(url) {
    const r = routes[url];
    // 没配的路由一律当成连不上 —— 比默默返回 200 安全
    if (!r) return { ok: false, error: `未配置的路由 ${url}` };
    if (r.offline) return { ok: false, error: r.offline };
    return {
      ok: true,
      status: r.status,
      headers: r.headers ?? {},
      text: r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''),
    };
  };
}

const find = (results, needle) => results.find((r) => r.name.includes(needle));

describe('前置：一个各项达标的世界应当全绿', () => {
  test('没有任何失败项（否则下面每条测试都测不出东西）', async () => {
    const results = await runChecks({ get: goodWorld(), hosts: HOSTS });
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(
      failed.map((f) => `${f.name}: ${f.detail}`),
      [],
      '基线世界里就有失败项，说明假数据搭得不对，下面的测试全不可信',
    );
    assert.ok(results.length >= 8, `只跑了 ${results.length} 项检查，太少`);
  });
});

describe('主机可达', () => {
  test('525 算失败，并说清多半是自定义域名没接上', async () => {
    // 真实故障：hub.nightcord.de5.net 整站 525，而构建一直是好的
    const get = goodWorld({ routes: { 'https://pass.test/': { status: 525, headers: {} } } });
    const r = find(await runChecks({ get, hosts: HOSTS }), 'pass 可达');
    assert.equal(r.ok, false);
    assert.match(r.detail, /525/);
    assert.match(r.detail, /自定义域名/);
  });

  test('4xx 不算失败 —— API 主机的根路径本来就没内容', async () => {
    const get = goodWorld({ routes: { 'https://pass.test/': { status: 404, headers: {} } } });
    assert.equal(find(await runChecks({ get, hosts: HOSTS }), 'pass 可达').ok, true);
  });

  test('连不上算失败，且不会让整份报告消失', async () => {
    const get = goodWorld({ routes: { 'https://pass.test/': { offline: 'ETIMEDOUT' } } });
    const results = await runChecks({ get, hosts: HOSTS });
    assert.equal(find(results, 'pass 可达').ok, false);
    assert.ok(results.length > 1, '一个主机连不上就没有后续检查了');
  });
});

describe('discovery 的自洽', () => {
  test('列表字段里的重复值会被抓到', async () => {
    // 真实故障：scopes_supported 里 openid 出现两次
    const get = goodWorld({ discovery: { scopes_supported: ['openid', 'openid', 'profile'] } });
    const r = find(await runChecks({ get, hosts: HOSTS }), '列表字段无重复值');
    assert.equal(r.ok, false);
    assert.match(r.detail, /openid/);
  });

  test('两份 discovery 对同一字段说法不同会被抓到', async () => {
    // 真实故障：两份手工维护的字面量，5 个字段互相矛盾
    const get = goodWorld({ asMeta: { scopes_supported: ['profile'] } });
    const r = find(await runChecks({ get, hosts: HOSTS }), '共有字段一致');
    assert.equal(r.ok, false);
    assert.match(r.detail, /scopes_supported/);
  });

  test('只在一份里出现的字段不算冲突', async () => {
    // OIDC 那份本来就是 RFC 8414 的超集，多出来的字段不该报错
    const get = goodWorld({ discovery: { claims_supported: ['sub'] } });
    assert.equal(find(await runChecks({ get, hosts: HOSTS }), '共有字段一致').ok, true);
  });
});

describe('JWKS 与声明的签名算法对得上', () => {
  test('声明了签名算法但 JWKS 是空的 —— 抓到', async () => {
    /*
     * 这条对应今天最要紧的那个线上故障：
     *   $ curl -s https://id.nightcord.de5.net/.well-known/jwks.json
     *   {"keys":[]}
     * 而 discovery 里写着 ["ES256","RS256"]。
     */
    const get = goodWorld({ jwks: { keys: [] } });
    const r = find(await runChecks({ get, hosts: HOSTS }), 'JWKS 里有可用的公钥');
    assert.equal(r.ok, false);
    assert.match(r.detail, /空/);
  });

  test('没声明签名算法时，空 JWKS 不算失败', async () => {
    // 纯 OAuth（不发 ID Token）的服务器没有公钥是正常的，不该逼它有
    const get = goodWorld({
      discovery: { id_token_signing_alg_values_supported: [] },
      jwks: { keys: [] },
    });
    assert.equal(find(await runChecks({ get, hosts: HOSTS }), 'JWKS 里有可用的公钥').ok, true);
  });

  test('JWKS 里一种声明的算法都没有 —— 抓到', async () => {
    const get = goodWorld({
      discovery: { id_token_signing_alg_values_supported: ['ES256'] },
      jwks: { keys: [{ kid: 'a', alg: 'RS256', kty: 'RSA' }] },
    });
    const r = find(await runChecks({ get, hosts: HOSTS }), '覆盖了至少一种');
    assert.equal(r.ok, false);
    assert.match(r.detail, /ES256/);
  });

  test('discovery 不给 jwks_uri —— 抓到', async () => {
    const get = goodWorld({ discovery: { jwks_uri: undefined } });
    assert.equal(find(await runChecks({ get, hosts: HOSTS }), '给出了 jwks_uri').ok, false);
  });
});

describe('401 的挑战头', () => {
  test('401 不带 WWW-Authenticate —— 抓到', async () => {
    const get = goodWorld({
      routes: { 'https://pass.test/oauth/userinfo': { status: 401, headers: {} } },
    });
    const r = find(await runChecks({ get, hosts: HOSTS }), 'userinfo 的 401 带');
    assert.equal(r.ok, false);
    assert.match(r.detail, /RFC 6750/);
  });

  test('发了却不暴露 —— 也抓到（跨域客户端读到的是 null）', async () => {
    /*
     * 「发了但看不见」是最容易漏的一类：curl 看得见、DevTools 看得见，
     * 只有真正的调用方（浏览器脚本）读到 null。
     */
    const get = goodWorld({
      routes: {
        'https://pass.test/oauth/userinfo': {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        },
      },
    });
    const r = find(await runChecks({ get, hosts: HOSTS }), '挑战头浏览器读得到');
    assert.equal(r.ok, false);
    assert.match(r.detail, /null/);
  });

  test('响应头大小写不影响判定', async () => {
    // 真实响应里这些头的大小写五花八门
    const get = goodWorld({
      routes: {
        'https://pass.test/oauth/userinfo': {
          status: 401,
          headers: { 'www-authenticate': 'Bearer', 'ACCESS-CONTROL-EXPOSE-HEADERS': 'WWW-Authenticate' },
        },
      },
    });
    assert.equal(find(await runChecks({ get, hosts: HOSTS }), 'userinfo 的 401 带').ok, true);
  });

  test('端点不返回 401 时跳过，不误报', async () => {
    // 端点改成要求 POST、或者干脆挪走了，都不该被算成「缺挑战头」
    const get = goodWorld({
      routes: { 'https://pass.test/oauth/userinfo': { status: 405, headers: {} } },
    });
    const results = await runChecks({ get, hosts: HOSTS });
    assert.ok(!results.some((r) => !r.ok && r.name.includes('userinfo')));
  });
});

describe('静态站的防点击劫持头', () => {
  test('两条都没有 —— 抓到', async () => {
    const get = goodWorld({ routes: { 'https://pass.test/': { status: 200, headers: {} } } });
    // pass 不在静态站清单里，用一个在清单里的主机名来测
    const results = await runChecks({
      get: goodWorld({
        routes: {
          'https://pass.test/': { status: 200, headers: {} },
          'https://docs.test/': { status: 200, headers: {} },
        },
      }),
      hosts: { pass: 'https://pass.test', docs: 'https://docs.test' },
    });
    const r = find(results, 'docs 有防点击劫持');
    assert.equal(r.ok, false);
    void get;
  });

  test('只有 CSP 的 frame-ancestors 也算过', async () => {
    const results = await runChecks({
      get: goodWorld({
        routes: {
          'https://pass.test/': { status: 200, headers: {} },
          'https://docs.test/': {
            status: 200,
            headers: { 'content-security-policy': "frame-ancestors 'none'" },
          },
        },
      }),
      hosts: { pass: 'https://pass.test', docs: 'https://docs.test' },
    });
    assert.equal(find(results, 'docs 有防点击劫持').ok, true);
  });

  test('站点 5xx 时跳过这一组 —— 否则会把 Cloudflare 错误页当成站点', async () => {
    /*
     * ⚠️ 这条防的是我第一版真的犯过的错。
     *
     * Cloudflare 的 5xx 错误页**自带** X-Frame-Options 与 Referrer-Policy。
     * 不先排除 5xx 的话，hub 明明整站 525，安全头那一列却显示各项齐全 ——
     * 一个挂掉的站点被报成配置正确。
     */
    const results = await runChecks({
      get: goodWorld({
        routes: {
          'https://pass.test/': { status: 200, headers: {} },
          'https://docs.test/': {
            status: 525,
            headers: { 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin' },
          },
        },
      }),
      hosts: { pass: 'https://pass.test', docs: 'https://docs.test' },
    });
    // 可达那条必须红
    assert.equal(find(results, 'docs 可达').ok, false);
    // 而安全头那条根本不该出现 —— 出现就意味着拿错误页的头当了站点的头
    assert.equal(
      results.find((r) => r.name.includes('docs 有防点击劫持')),
      undefined,
      '站点 5xx 时仍然评了它的安全头 —— 那评的是 Cloudflare 错误页',
    );
  });
});
