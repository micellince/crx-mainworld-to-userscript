#!/usr/bin/env node
import { resolve } from 'node:path';
import { convertExtensionToUserscript, verifyUserscript } from './index.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'convert';
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') {
      flags.output = args[++i];
    } else if (a === '-s' || a === '--source') {
      flags.source = args[++i];
    } else if (a === '--update-url') {
      flags.updateUrl = args[++i];
    } else if (a === '--download-url') {
      flags.downloadUrl = args[++i];
    } else if (a === '--name') {
      flags.name = args[++i];
    } else if (a === '--namespace') {
      flags.namespace = args[++i];
    } else if (a === '--verify') {
      flags.verify = true;
    } else if (a === '--no-verify') {
      flags.verify = false;
    } else if (a === '-h' || a === '--help') {
      flags.help = true;
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

function printHelp() {
  console.log(`
crx-mainworld-to-userscript (crx2user) v1.0.0
Convert Manifest V3 Chrome Extensions (Page-World + Background CORS Bridge) into standalone Userscripts (.user.js) with automated E2E verification.

Usage:
  crx2user convert <ext-dir> -o <output.user.js> [--verify] [--update-url <url>] [--download-url <url>]
  crx2user verify <file.user.js> [--source <ext-dir>]
`);
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv);
  if (flags.help || positional.length === 0) {
    printHelp();
    process.exit(flags.help ? 0 : 1);
  }

  if (cmd === 'convert') {
    const sourceDir = resolve(positional[0]);
    const outputPath = flags.output
      ? resolve(flags.output)
      : resolve(`dist/converted.user.js`);

    const { bundle, compiled, verification } = await convertExtensionToUserscript(sourceDir, {
      outputPath,
      updateUrl: flags.updateUrl,
      downloadUrl: flags.downloadUrl,
      name: flags.name,
      namespace: flags.namespace,
      verify: flags.verify !== false
    });

    console.log(`✅ Converted Chrome MV3 Extension -> Userscript`);
    console.log(`   • Extension : ${bundle.name} (v${bundle.version})`);
    console.log(`   • Output    : ${outputPath}`);
    console.log(`   • Size      : ${(Buffer.byteLength(compiled.code, 'utf8') / 1024 / 1024).toFixed(2)} MB (SHA-256: ${compiled.sha256.slice(0, 16)}…)`);
    if (verification) {
      console.log(`   • Verified  : PASSED (${verification.checks.length}/${verification.checks.length} automated checks)`);
      for (const c of verification.checks) {
        console.log(`     ✓ [${c.name}] ${c.details}`);
      }
    }
    return;
  }

  if (cmd === 'verify') {
    const targetFile = resolve(positional[0]);
    const sourceDir = flags.source ? resolve(flags.source) : null;
    const report = await verifyUserscript(targetFile, { sourceDir });

    console.log(`${report.passed ? '✅ VERIFICATION PASSED' : '❌ VERIFICATION FAILED'} — ${targetFile} (v${report.version})`);
    for (const c of report.checks) {
      console.log(`   ${c.passed ? '✓' : '✗'} [${c.name}] ${c.details}`);
    }
    if (!report.passed) process.exit(1);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
