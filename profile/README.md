# 25時、コードで。

> **SEKAI 生态** — 统一身份、API、实时协作与创作工具

## 用户应用

| 项目 | 说明 | 站点 |
|------|------|------|
| [Nightcord](https://github.com/25-ji-code-de/nightcord) | 实时协作聊天 | [nightcord.de5.net](https://nightcord.de5.net) |
| [25ji-sagyo](https://github.com/25-ji-code-de/25ji-sagyo) | 专注陪伴（番茄钟 / 同步 / 成就） | [25ji.nightcord.de5.net](https://25ji.nightcord.de5.net) |
| [Hub](https://github.com/25-ji-code-de/hub) | 生态门户与仪表盘 | [hub.nightcord.de5.net](https://hub.nightcord.de5.net) |
| [Stickers](https://github.com/25-ji-code-de/stickers) | 贴纸画廊 | [sticker.nightcord.de5.net](https://sticker.nightcord.de5.net) |
| [Stickers Maker](https://github.com/25-ji-code-de/stickers-maker) | 贴纸生成器 | [st.nightcord.de5.net](https://st.nightcord.de5.net) |
| [Puzzle SEKAI](https://github.com/25-ji-code-de/puzzle-sekai) | Project SEKAI 主题方块消除（Puyo 系） | [pico.nightcord.de5.net](https://pico.nightcord.de5.net/) |

## 基础服务

| 项目 | 说明 | 站点 |
|------|------|------|
| [SEKAI Pass](https://github.com/25-ji-code-de/sekai-pass) | 统一身份认证（OAuth 2.1 / OIDC） | [id.nightcord.de5.net](https://id.nightcord.de5.net) |
| [Gateway](https://github.com/25-ji-code-de/gateway) | 统一 API（同步 / 统计 / 音乐 / 贴纸代理） | [api.nightcord.de5.net](https://api.nightcord.de5.net) |
| [Nako](https://github.com/25-ji-code-de/nako) | AI 对话与贴纸推荐 | [nako.nightcord.de5.net](https://nako.nightcord.de5.net) |

## 文档

- **[docs](https://github.com/25-ji-code-de/docs)** — 架构、API 与客户端约定 | [docs.nightcord.de5.net](https://docs.nightcord.de5.net)

## 协作关系（简图）

```text
Frontends (Hub / 25ji / Nightcord / Stickers Maker)
    │  PKCE
    ▼
SEKAI Pass ──AUTH_DB──► Gateway / Nako
    │                      │
    │                      ├── user sync / stats / events
    │                      ├── music & stickers proxy
    │                      └── AI chat / recommend
    ▼
Storage (OSS / R2) ◄── Nightcord uploads
```

## 技术栈

- **平台:** Cloudflare Workers · Pages · D1 · KV · R2 · Vectorize
- **语言:** TypeScript · JavaScript
- **许可证:** 各仓库独立（MIT / Apache-2.0 / AGPL-3.0 / CC-BY-4.0 等）

## 贡献

欢迎贡献。请查看目标仓库的 `CONTRIBUTING.md`，并优先阅读 [docs](https://docs.nightcord.de5.net) 中的架构与客户端约定。

## 版权声明

部分项目使用了 *Project SEKAI: Colorful Stage!* 的游戏素材（音乐数据、贴纸等）。

Project SEKAI: Colorful Stage! is © SEGA / © Colorful Palette Inc. / © Crypton Future Media, INC.

本组织项目与 SEGA、Colorful Palette、Crypton Future Media 无关联。

---

<div align="center">

Made with 💜 by the [25-ji-code-de](https://github.com/25-ji-code-de) team

**25時、コードで。** — Coding at 25 o'clock

</div>
