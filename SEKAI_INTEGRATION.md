# SEKAI shared package integration

`@25-ji-code-de/sekai-auth` owns OAuth/OIDC protocol behavior. `@sekai/design`
owns visual tokens and reusable component styles. Applications may keep thin adapters and
product CSS, but must not fork either package's shared behavior or token values.

## Applications with a build step

Depend on immutable Git tags and commit the package-manager lockfile:

```json
{
  "dependencies": {
    "@25-ji-code-de/sekai-auth": "github:25-ji-code-de/sekai-auth#v0.2.0",
    "@sekai/design": "github:25-ji-code-de/sekai-design#v0.1.0"
  }
}
```

Import `@sekai/design/tokens` before application CSS. Import `@sekai/design/css` only when
the application intentionally adopts the complete reset and component layer.

## Static applications

Static applications vendor the tagged upstream artifacts. Do not edit vendored files.
From the checkout root, synchronize every static consumer with:

```bash
npm --prefix .github run sync-sekai-vendors
```

CI can use the read-only form:

```bash
npm --prefix .github run check-sekai-vendors
```

Load Design layers in this order: `primitives`, `contract`, `world-system`, `world-night`,
then application CSS. Set exactly one world on the root element:

- `world-system`: Pass, Hub, documentation and control surfaces.
- `world-night`: Nightcord, 25ji, Stickers and games.

## Adapter boundary

Auth adapters may map configuration, preserve historical storage keys, migrate stored data,
and retain an application's established return/error shape. PKCE, token refresh, revocation,
OIDC discovery and ID-token validation must remain in `@25-ji-code-de/sekai-auth`.

Application styles may define product-specific custom properties, but `--sekai-*` names and
values belong to `@sekai/design`. Dynamic themes may override semantic tokens at runtime as a
single theme boundary; components must continue to consume semantic names.
