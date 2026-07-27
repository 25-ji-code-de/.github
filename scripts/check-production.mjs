/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 线上契约检查：把生态对外承诺的东西，逐条拿真实的 HTTP 响应去核。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 仓库里的测试只能验「代码是这么写的」。它验不了：
 *
 *   - 部署有没有真的发生（`Workers Builds` 从 2026-02 起一次没绿过，
 *     而没人发现，因为服务还活着）
 *   - 自定义域名有没有接上（`hub.nightcord.de5.net` 整站 525，
 *     构建却好好的，`sekai-hub.pages.dev` 一直 200）
 *   - 定时任务有没有真的触发（签名密钥轮换的 cron 字符串对不上，
 *     结果线上 JWKS 是空的 —— **discovery 里同时声明着签名算法**）
 *
 * 上面三条都是 2026-07-27 一天之内查出来的，每一条都在线上躺了很久。
 * 它们的共同点：**代码是对的，测试是绿的，线上是坏的。**
 *
 * ── 判据 ────────────────────────────────────────────────────────
 *
 * 只检查「服务自己对外宣称过的东西」，不引入新的期望。
 * 比如不检查响应快不快，但检查「discovery 说有 jwks_uri，那 JWKS 就得有 key」。
 *
 * 用法：
 *   node check-production.mjs            # 检查所有
 *   node check-production.mjs --quiet    # 只输出失败项
 */

import { argv } from 'node:process';

/** 生态里对外提供服务的主机。名字是实测过的 —— 别按仓名猜。 */
export const HOSTS = Object.freeze({
  pass: 'https://id.nightcord.de5.net',
  gateway: 'https://api.nightcord.de5.net',
  nako: 'https://nako.nightcord.de5.net',
  storage: 'https://storage.nightcord.de5.net',
  docs: 'https://docs.nightcord.de5.net',
  hub: 'https://hub.nightcord.de5.net',
  nightcord: 'https://nightcord.de5.net',
  '25ji': 'https://25ji.nightcord.de5.net',
  // 单数。复数的 stickers.nightcord.de5.net 是没人引用的悬空主机名
  sticker: 'https://sticker.nightcord.de5.net',
});

/** 带超时的 fetch，失败不抛 —— 一个主机挂了不该让整份报告消失。 */
export async function httpGet(url, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    return { ok: true, status: res.status, headers: res.headers, text };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const parse = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
};

/** 取响应头，大小写不敏感；支持 Headers 与普通对象两种形态（测试用后者）。 */
const header = (r, name) => {
  const h = r.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? h[hit] : null;
};

/**
 * 跑全部检查。
 *
 * `get` 是注入的 —— 测试用假的，CLI 用真的 fetch。
 * 不注入的话这个脚本只能靠"真的去请求线上"来验，那样测试既慢又不可复现，
 * 而且**改坏了也发现不了**（线上恰好是好的时候，怎么写都绿）。
 *
 * @param {{ get?: typeof httpGet, hosts?: Record<string,string> }} [deps]
 * @returns {Promise<{ok: boolean, name: string, detail: string}[]>}
 */
export async function runChecks({ get = httpGet, hosts = HOSTS } = {}) {
  const results = [];
  const record = (ok, name, detail = '') => results.push({ ok, name, detail });

  // ── 1. 每个主机都活着 ──────────────────────────────────────────
  for (const [name, base] of Object.entries(hosts)) {
    const r = await get(`${base}/`);
    if (!r.ok) {
      record(false, `${name} 可达`, `连不上：${r.error}`);
      continue;
    }
    /*
     * 5xx 一律算失败。4xx 不算 —— API 主机的根路径本来就没有内容
     * （api 返回 404、nako 返回 401 都是正常的）。
     *
     * 特别地，**525 是 Cloudflare 回源 TLS 握手失败**：站点构建可能好好的，
     * 只是自定义域名没接上。hub 就是这么挂了很久没人发现的。
     */
    if (r.status >= 500) {
      const hint =
        r.status === 525
          ? ' —— Cloudflare 回源 TLS 握手失败，多半是自定义域名没接上（构建可能是好的）'
          : '';
      record(false, `${name} 可达`, `HTTP ${r.status}${hint}`);
    } else {
      record(true, `${name} 可达`, `HTTP ${r.status}`);
    }
  }

  // ── 2. discovery 说得出口的，就得兑现 ─────────────────────────
  const oidcRes = await get(`${hosts.pass}/.well-known/openid-configuration`);
  const oidc = oidcRes.ok ? parse(oidcRes) : null;
  if (!oidc) {
    record(false, 'openid-configuration 取得到', oidcRes.error ?? `HTTP ${oidcRes.status}`);
  } else {
    record(true, 'openid-configuration 取得到');

    // 列表字段里不该有重复值 —— scopes_supported 曾经有两个 openid
    const dupFields = [];
    for (const [k, v] of Object.entries(oidc)) {
      if (!Array.isArray(v)) continue;
      const dupes = [...new Set(v.filter((x, i) => v.indexOf(x) !== i))];
      if (dupes.length) dupFields.push(`${k}（${dupes.join(', ')}）`);
    }
    record(
      dupFields.length === 0,
      'discovery 的列表字段无重复值',
      dupFields.length ? `有重复：${dupFields.join('；')}` : '',
    );

    // 两份 discovery 描述的是同一台服务器，共有字段必须一致
    const asRes = await get(`${hosts.pass}/.well-known/oauth-authorization-server`);
    const as = asRes.ok ? parse(asRes) : null;
    if (!as) {
      record(false, 'oauth-authorization-server 取得到', asRes.error ?? `HTTP ${asRes.status}`);
    } else {
      const differing = Object.keys(as).filter(
        (k) => k in oidc && JSON.stringify(as[k]) !== JSON.stringify(oidc[k]),
      );
      record(
        differing.length === 0,
        '两份 discovery 的共有字段一致',
        differing.length ? `不一致：${differing.join(', ')}` : '',
      );
    }

    /*
     * 最要紧的一条：**声明了签名算法，就必须发得出验签公钥。**
     *
     * 2026-07-27 实测到的正是这个 —— JWKS 返回 {"keys":[]}，
     * 而 discovery 里 id_token_signing_alg_values_supported 写着 ES256/RS256。
     * 任何按 OIDC 规范验 ID Token 签名的客户端都验不过。
     *
     * 根因是密钥轮换的 cron 从来没触发过（见 sekai-pass#28）。
     */
    const declaredAlgs = Array.isArray(oidc.id_token_signing_alg_values_supported)
      ? oidc.id_token_signing_alg_values_supported
      : [];
    const jwksUri = typeof oidc.jwks_uri === 'string' ? oidc.jwks_uri : null;
    record(Boolean(jwksUri), 'discovery 给出了 jwks_uri');

    if (jwksUri) {
      const jwksRes = await get(jwksUri);
      const jwks = jwksRes.ok ? parse(jwksRes) : null;
      if (!jwks) {
        record(false, 'JWKS 取得到', jwksRes.error ?? `HTTP ${jwksRes.status}`);
      } else {
        const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
        record(
          declaredAlgs.length === 0 || keys.length > 0,
          'JWKS 里有可用的公钥',
          keys.length > 0
            ? `${keys.length} 把`
            : `JWKS 是空的，而 discovery 声明了 ${JSON.stringify(declaredAlgs)}` +
              ' —— 按规范验 ID Token 签名的客户端一个都验不过',
        );

        if (keys.length > 0 && declaredAlgs.length > 0) {
          const algs = new Set(keys.map((k) => k.alg).filter(Boolean));
          const missing = declaredAlgs.filter((a) => !algs.has(a));
          record(
            missing.length < declaredAlgs.length,
            'JWKS 覆盖了至少一种声明的签名算法',
            missing.length ? `JWKS 里没有：${missing.join(', ')}` : '',
          );
        }
      }
    }
  }

  // ── 3. 401 要告诉客户端怎么认证（RFC 6750 §3）────────────────
  const bearerTargets = [
    ['pass userinfo', 'pass', '/oauth/userinfo'],
    ['gateway user', 'gateway', '/user/stats'],
    ['nako chat', 'nako', '/api/chat'],
  ];
  for (const [name, hostKey, path] of bearerTargets) {
    // hosts 里没配这个主机就跳过 —— 别去请求 `undefined/user/stats`
    if (!hosts[hostKey]) continue;
    const url = `${hosts[hostKey]}${path}`;
    const r = await get(url);
    if (!r.ok) {
      record(false, `${name} 的 401 带 WWW-Authenticate`, `连不上：${r.error}`);
      continue;
    }
    if (r.status !== 401) {
      // 不是 401 就没什么可查的（比如端点改了、或者要求 POST）
      record(true, `${name} 无凭据时返回 ${r.status}`, '不是 401，跳过挑战头检查');
      continue;
    }
    const challenge = header(r, 'www-authenticate');
    record(
      Boolean(challenge),
      `${name} 的 401 带 WWW-Authenticate`,
      challenge || 'RFC 6750 §3 要求必须有 —— 客户端唯一能机器读取的认证提示',
    );

    /*
     * 光发还不够：浏览器默认只让脚本读到 CORS 安全清单里那几个头。
     * 不暴露的话，服务端发了、DevTools 里也看得见，
     * 而客户端 res.headers.get() 返回 null —— 等于白发。
     */
    if (challenge) {
      const expose = header(r, 'access-control-expose-headers') ?? '';
      record(
        /www-authenticate/i.test(expose),
        `${name} 的挑战头浏览器读得到`,
        /www-authenticate/i.test(expose)
          ? ''
          : `Access-Control-Expose-Headers = ${expose || '（无）'} —— 跨域客户端读到的是 null`,
      );
    }
  }

  // ── 4. 静态站的防点击劫持响应头 ───────────────────────────────
  for (const name of ['nightcord', '25ji', 'sticker', 'docs', 'hub']) {
    if (!hosts[name]) continue;
    const r = await get(`${hosts[name]}/`);
    if (!r.ok || r.status >= 500) continue; // 站点本身挂了，上面那组已经报过

    /*
     * 只看这两条：零破坏风险，且防的是点击劫持这类实打实的问题。
     *
     * ⚠️ 这一组有个坑：**Cloudflare 的错误页自带 X-Frame-Options 与
     * Referrer-Policy**。只统计「有没有这个头」会把错误页当成配置正确的
     * 站点 —— 我第一版就是这么误报的，hub 明明 525 却显示各项齐全。
     * 上面那句 `r.status >= 500 → continue` 就是防这个。
     */
    const csp = header(r, 'content-security-policy');
    const xfo = header(r, 'x-frame-options');
    record(
      Boolean(csp && /frame-ancestors/.test(csp)) || xfo === 'DENY',
      `${name} 有防点击劫持的响应头`,
      csp || xfo ? '' : '既没有 frame-ancestors 也没有 X-Frame-Options: DENY',
    );
  }

  return results;
}

/** 命令行入口。被 import 时不执行。 */
export function report(results, { quiet = false } = {}) {
  for (const r of results) {
    if (r.ok && quiet) continue;
    console.log(`${r.ok ? 'OK' : '!!'} ${r.name}${r.detail ? `\n     ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length
      ? `\n${failed.length} 项不达标（共 ${results.length} 项）`
      : `\n${results.length} 项线上契约全部达标`,
  );
  return failed.length;
}

if (import.meta.url === `file://${process.argv[1]}` || argv[1]?.endsWith('check-production.mjs')) {
  const results = await runChecks();
  process.exit(report(results, { quiet: argv.includes('--quiet') }) ? 1 : 0);
}
