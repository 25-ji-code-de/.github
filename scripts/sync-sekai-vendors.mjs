/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';

const checkoutRoot = resolve(argv[2] || '..');
const checkOnly = argv.includes('--check');

const packages = [
  {
    name: '@25-ji-code-de/sekai-auth',
    repository: '25-ji-code-de/sekai-auth',
    tag: 'v0.2.0',
    files: [
      {
        source: 'dist/sekai-auth.mjs',
        targets: ['hub/assets/js/vendor/sekai-auth.js'],
      },
      {
        source: 'dist/sekai-auth.global.js',
        targets: [
          '25ji-sagyo/js/vendor/sekai-auth.global.js',
          'nightcord/vendor/sekai-auth.global.js',
        ],
      },
    ],
  },
  {
    name: '@sekai/design',
    repository: '25-ji-code-de/sekai-design',
    tag: 'v0.1.0',
    files: [
      ...['primitives', 'contract', 'world-system', 'world-night'].map((layer) => ({
        source: `tokens/${layer}.css`,
        targets: [
          `hub/assets/css/sekai/${layer}.css`,
          `sekai-pass/public/css/sekai/${layer}.css`,
          `nightcord/vendor/sekai-design/${layer}.css`,
          `stickers/vendor/sekai-design/${layer}.css`,
          `25ji-sagyo/css/vendor/sekai-design/${layer}.css`,
        ],
      })),
      { source: 'css/signatures.css', targets: ['sekai-pass/public/css/sekai/signatures.css'] },
      { source: 'css/layout/auth.css', targets: ['sekai-pass/public/css/sekai/auth.css'] },
      { source: 'css/layout/page.css', targets: ['hub/assets/css/sekai/page.css'] },
      { source: 'css/layout/chat.css', targets: ['nightcord/vendor/sekai-design/chat.css'] },
      { source: 'css/components/modal.css', targets: ['nightcord/vendor/sekai-design/modal.css'] },
    ],
  },
];

function marker(pkg, source) {
  const value = `@sekai-vendor ${pkg.name}@${pkg.tag} ${source}`;
  return source.endsWith('.css') ? `/* ${value} */\n` : `// ${value}\n`;
}

let drift = 0;
for (const pkg of packages) {
  for (const file of pkg.files) {
    const url = `https://raw.githubusercontent.com/${pkg.repository}/${pkg.tag}/${file.source}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const expected = marker(pkg, file.source) + (await response.text());

    for (const relativeTarget of file.targets) {
      const target = join(checkoutRoot, relativeTarget);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current?.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n')) {
        console.log(`ok      ${relativeTarget}`);
        continue;
      }

      drift += 1;
      if (checkOnly) {
        console.error(`outdated ${relativeTarget}`);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, expected, 'utf8');
        console.log(`updated ${relativeTarget}`);
      }
    }
  }
}

if (checkOnly && drift) {
  console.error(`${drift} vendored file(s) are missing or outdated`);
  process.exitCode = 1;
} else {
  console.log(`${checkOnly ? 'checked' : 'synchronized'} SEKAI vendor files`);
}
