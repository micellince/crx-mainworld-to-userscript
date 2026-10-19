#!/usr/bin/env node
import { resolve } from 'node:path';
import { convertExtensionToUserscript, verifyUserscript, GENERATOR } from './index.mjs';

const HELP = `
crx-mainworld-to-userscript (crx2user) ${GENERATOR.split('@')[1]}
Convert any Manifest V3 Chrome Extension that uses the Page-World (MAIN world)
+ background CORS bridge architecture into a standalone Tampermonkey /
Violentmonkey userscript, with a generic 4-stage automated verifier.

Usage:
  crx2user convert <extension-dir> [-o <output.user.js>] [options]
  crx2user convert --input <extension-dir> [options]
  crx2user verify <file.user.js> [--source <extension-dir>] [--json]

Options:
  -i, --input <dir>        Unpacked MV3 extension directory (same as positional arg)
  -o, --output <file>      Output userscript path (default: dist/converted.user.js)
  -s, --source <dir>       Source extension directory for "verify"
      --verify             Run the 4-stage verifier after conversion (default)
      --no-verify          Skip verification
      --match <pattern>    Extra @match pattern (repeatable)
      --url <url>          Page URL used by the sandbox smoke test
      --name <name>        Override the userscript @name
      --namespace <value>  Override the userscript @namespace
      --update-url <url>   @updateURL for self-updating userscripts
      --download-url <url> @downloadURL for self-updating userscripts
      --json               Print the result as machine-readable JSON
  -h, --help               Show this help

Examples:
  crx2user convert ./unpacked-extension -o dist/companion.user.js --verify
  crx2user verify dist/companion.user.js --source ./unpacked-extension
`;

class UsageError extends Error {}

function parseArgv(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};

  const takeValue = (flagName, index) => {
    const value = args[index];
    if (value === undefined || value.startsWith('-')) {
      throw new UsageError(`Option ${flagName} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (argument.startsWith('--')) {
      const equalsIndex = argument.indexOf('=');
      const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
      const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null;
      const nextValue = () => (inlineValue !== null ? inlineValue : takeValue(name, ++index));
      switch (name) {
        case '--help':
          flags.help = true;
          break;
        case '--verify':
          flags.verify = true;
          break;
        case '--no-verify':
          flags.verify = false;
          break;
        case '--json':
          flags.json = true;
          break;
        case '--input':
          flags.input = nextValue();
          break;
        case '--output':
          flags.output = nextValue();
          break;
        case '--source':
          flags.source = nextValue();
          break;
        case '--update-url':
          flags.updateUrl = nextValue();
          break;
        case '--download-url':
          flags.downloadUrl = nextValue();
          break;
        case '--name':
          flags.name = nextValue();
          break;
        case '--namespace':
          flags.namespace = nextValue();
          break;
        case '--match':
          if (!flags.matches) flags.matches = [];
          flags.matches.push(nextValue());
          break;
        case '--url':
          flags.url = nextValue();
          break;
        default:
          throw new UsageError(`Unknown option: ${name}`);
      }
      continue;
    }
    if (argument.startsWith('-') && argument !== '-') {
      switch (argument) {
        case '-h':
          flags.help = true;
          break;
        case '-i':
          flags.input = takeValue(argument, ++index);
          break;
        case '-o':
          flags.output = takeValue(argument, ++index);
          break;
        case '-s':
          flags.source = takeValue(argument, ++index);
          break;
        default:
          throw new UsageError(`Unknown option: ${argument}`);
      }
      continue;
    }
    positional.push(argument);
  }

  let command = 'convert';
  if (positional.length > 0 && (positional[0] === 'convert' || positional[0] === 'verify')) {
    command = positional.shift();
  }
  return { command, positional, flags };
}

function printWarnings(warnings) {
  for (const warning of warnings || []) console.log(`   ⚠ ${warning}`);
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(`     ${check.passed ? '✓' : '✗'} [${check.name}] ${check.details}`);
  }
}

async function runConvert(flags, positional) {
  const source = flags.input || positional[0];
  if (!source) {
    throw new UsageError('convert requires an extension directory (pass it positionally or with --input <dir>)');
  }
  const output = flags.output || 'dist/converted.user.js';
  const result = await convertExtensionToUserscript(resolve(source), {
    outputPath: resolve(output),
    updateUrl: flags.updateUrl,
    downloadUrl: flags.downloadUrl,
    name: flags.name,
    namespace: flags.namespace,
    matches: flags.matches,
    url: flags.url,
    verify: flags.verify !== false
  });

  if (flags.json) {
    console.log(JSON.stringify({
      ok: true,
      generator: GENERATOR,
      source: { name: result.bundle.name, version: result.bundle.version },
      output: resolve(output),
      sizeBytes: Buffer.byteLength(result.compiled.code, 'utf8'),
      sha256: result.compiled.sha256,
      warnings: result.warnings,
      verification: result.verification
    }, null, 2));
    return 0;
  }

  console.log('✅ Converted Chrome MV3 Extension -> Userscript');
  console.log(`   • Extension : ${result.bundle.name} (v${result.bundle.version})`);
  console.log(`   • Output    : ${resolve(output)}`);
  console.log(`   • Size      : ${(Buffer.byteLength(result.compiled.code, 'utf8') / 1024 / 1024).toFixed(2)} MB (sha256: ${result.compiled.sha256.slice(0, 16)}…)`);
  printWarnings(result.warnings);
  if (result.verification) {
    console.log(`   • Verified  : ${result.verification.passed ? 'PASSED' : 'FAILED'} (${result.verification.checks.filter(check => check.passed).length}/${result.verification.checks.length} checks)`);
    printChecks(result.verification.checks);
  }
  return 0;
}

async function runVerify(flags, positional) {
  const target = positional[0] || flags.input;
  if (!target) throw new UsageError('verify requires a .user.js file');
  const report = await verifyUserscript(resolve(target), {
    sourceDir: flags.source ? resolve(flags.source) : null,
    url: flags.url
  });

  if (flags.json) {
    console.log(JSON.stringify({ ok: report.passed, target: resolve(target), ...report }, null, 2));
  } else {
    console.log(`${report.passed ? '✅ VERIFICATION PASSED' : '❌ VERIFICATION FAILED'} — ${resolve(target)} (v${report.version})`);
    printChecks(report.checks);
  }
  return report.passed ? 0 : 1;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}\n${HELP}`);
      return 2;
    }
    throw error;
  }

  const { command, positional, flags } = parsed;
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  try {
    if (command === 'verify') return await runVerify(flags, positional);
    return await runConvert(flags, positional);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}\n${HELP}`);
      return 2;
    }
    console.error(`❌ Error: ${error.message}`);
    return 1;
  }
}

main().then(
  code => process.exit(code),
  error => {
    console.error(`❌ Unexpected error: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  }
);
