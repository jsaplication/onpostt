'use strict';

/**
 * Gera `public/onpostt.min.js` concatenando o bundle do elliptic com a
 * biblioteca `public/onpostt.js` minificada.
 *
 * O elliptic já é distribuído minificado em `public/vendor/elliptic.min.js`.
 */

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const vendorPath = path.join(root, 'public', 'vendor', 'elliptic.min.js');
const sourcePath = path.join(root, 'public', 'onpostt.js');
const outputPath = path.join(root, 'public', 'onpostt.min.js');

async function main() {
  const vendor = fs.readFileSync(vendorPath, 'utf8').trim();
  const source = fs.readFileSync(sourcePath, 'utf8');

  const transformed = await esbuild.transform(source, {
    loader: 'js',
    minify: true,
    target: ['es2020'],
    legalComments: 'none',
  });

  const banner = [
    '/*!',
    ' * onpostt — cliente oficial',
    ' * elliptic (MIT) embutido em public/vendor/elliptic.min.js',
    ' * Não coloque chaves privadas neste arquivo.',
    ' */',
    '',
  ].join('\n');

  const output = `${banner}${vendor};\n${transformed.code}\n`;
  fs.writeFileSync(outputPath, output, 'utf8');

  const size = fs.statSync(outputPath).size;
  process.stdout.write(
    `[build-lib] public/onpostt.min.js gerado (${(size / 1024).toFixed(1)} KiB)\n`
  );
}

main().catch((error) => {
  process.stderr.write(`[build-lib] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
