import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  parseExtensionDir,
  compileUserscript,
  verifyUserscript,
  convertExtensionToUserscript,
  extractConnectDomains,
  matchesPattern,
  matchesAnyPattern,
  patternToSampleUrl,
  normalizeVersion,
  sanitizeHeaderValue,
  parseEmbeddedPayloads
} from '../src/index.mjs';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const GENERIC_EXT_DIR = resolve(import.meta.dirname, './fixtures/generic-mv3-ext');
const CLI_PATH = resolve(PROJECT_ROOT, 'src/cli.mjs');

async function createTempExtension(files) {
  const root = await mkdtemp(join(tmpdir(), 'crx2user-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test('matchesPattern implements generic Chrome match-pattern semantics', () => {
  assert.equal(matchesPattern('https://www.ea.com/foo', 'https://www.ea.com/*'), true);
  assert.equal(matchesPattern('https://www.ea.com/foo', 'https://futbin.com/*'), false);
  assert.equal(matchesPattern('https://sub.example.com/x', '*://*.example.com/*'), true);
  assert.equal(matchesPattern('https://example.com/x', '*://*.example.com/*'), true);
  assert.equal(matchesPattern('http://sub.example.com/x', 'https://*.example.com/*'), false);
  assert.equal(matchesPattern('https://example.com/a/b', 'https://example.com/a/*'), true);
  assert.equal(matchesPattern('https://example.com/b', 'https://example.com/a/*'), false);
  assert.equal(matchesPattern('https://anything.example/x', '<all_urls>'), true);
  assert.equal(matchesPattern('ftp://example.com/x', '<all_urls>'), true);
  assert.equal(matchesPattern('wss://example.com/x', '<all_urls>'), false);
  assert.equal(matchesAnyPattern('https://docs.example.com/x', ['https://app.example.com/*', 'https://docs.example.com/*']), true);
  assert.equal(matchesAnyPattern('https://other.example.com/x', []), true);
});

test('patternToSampleUrl always produces a URL matching the source pattern', () => {
  const patterns = [
    'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*',
    'https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*',
    '*://*.example.com/dashboard/*',
    '*://*/*',
    '<all_urls>'
  ];
  for (const pattern of patterns) {
    const sampleUrl = patternToSampleUrl(pattern);
    assert.ok(sampleUrl, `no sample URL generated for ${pattern}`);
    assert.equal(matchesPattern(sampleUrl, pattern), true, `${sampleUrl} should match ${pattern}`);
  }
});

test('extractConnectDomains handles ports, wildcard hosts and permissions fallback', () => {
  assert.deepEqual(
    extractConnectDomains(['https://enhancer-api.futnext.com/*', 'https://www.futbin.org/*', '*://*.ea.com/*']),
    ['enhancer-api.futnext.com', 'www.futbin.org', 'ea.com']
  );
  assert.deepEqual(
    extractConnectDomains(['http://localhost:3000/*', '<all_urls>']),
    ['localhost', '*']
  );
  assert.deepEqual(
    extractConnectDomains({ host_permissions: ['https://api.example.com/*'], permissions: ['https://cdn.example.net/*'] }),
    ['api.example.com', 'cdn.example.net']
  );
});

test('normalizeVersion and sanitizeHeaderValue keep generated metadata safe', () => {
  assert.equal(normalizeVersion('2.4.1'), '2.4.1');
  assert.equal(normalizeVersion('2026.10-beta'), '2026.10');
  assert.equal(normalizeVersion('nonsense'), '1.0.0');
  assert.equal(sanitizeHeaderValue('line one\nline two'), 'line one line two');
  assert.equal(sanitizeHeaderValue('evil // ==/UserScript== tail'), 'evil // tail');
  assert.ok(!sanitizeHeaderValue('a\n==/UserScript==\nb').includes('==/UserScript=='));
});

test('parser understands recursive importScripts, multiple content script groups and MAIN world scripts', async () => {
  const bundle = await parseExtensionDir(GENERIC_EXT_DIR);
  assert.equal(bundle.version, '2.4.1');
  assert.equal(bundle.runAt, 'document-start');
  assert.equal(bundle.noframes, false);
  assert.equal(bundle.usesStorage, true);
  assert.deepEqual(bundle.matches, ['https://app.example.com/*', 'https://docs.example.com/*']);
  assert.deepEqual(bundle.connectDomains, ['api.example.com', 'data.example.net', 'localhost']);
  assert.deepEqual(bundle.background.imports.map(asset => asset.path), ['lib/nested/token.js', 'lib/helpers.js']);
  assert.equal(bundle.background.hasDynamicImports, false);
  assert.equal(bundle.contentScripts.length, 3);
  assert.equal(bundle.contentScripts[1].runAt, 'document-start');
  assert.deepEqual(bundle.contentScripts[1].gate.excludeMatches, ['https://docs.example.com/private/*']);
  assert.equal(bundle.contentScripts[2].world, 'MAIN');
  assert.deepEqual(bundle.pageScripts.map(asset => asset.path), ['page/main.js', 'page/main-world.js']);
  assert.deepEqual(bundle.cssAssets.map(asset => asset.path), ['content/theme.css', 'page/main.css']);
  assert.equal(bundle.pageScripts[1].runAt, 'document-idle');
  assert.equal(bundle.pageScripts[0].allFrames, false);
  assert.equal(bundle.pageScripts[1].allFrames, true);
  assert.equal(bundle.cssAssets[0].runAt, 'document-idle');
  assert.deepEqual(bundle.binaryAssets.map(asset => asset.path), ['assets/logo.png']);
  assert.ok(bundle.iconDataUri.startsWith('data:image/png;base64,'));
});

test('generic fixture converts and verifies with per-entry gating and exclusions', async () => {
  const bundle = await parseExtensionDir(GENERIC_EXT_DIR);
  const compiled = compileUserscript(bundle);

  assert.ok(compiled.code.includes('// @match        https://app.example.com/*'));
  assert.ok(compiled.code.includes('// @match        https://docs.example.com/*'));
  assert.ok(compiled.code.includes('// @connect      api.example.com'));
  assert.ok(compiled.code.includes('// @connect      data.example.net'));
  assert.ok(compiled.code.includes('// @connect      localhost'));
  assert.ok(compiled.code.includes('data:image/png;base64,'));
  assert.ok(!compiled.code.includes('// @noframes'));
  assert.ok(compiled.code.includes('// @grant        GM_getValue'));
  assert.ok(compiled.code.includes('// @grant        GM_setValue'));
  const payloads = parseEmbeddedPayloads(compiled.code);
  assert.ok(payloads, 'embedded payload block must be extractable');
  assert.ok(compiled.code.includes('"imports":["lib/nested/token.js","lib/helpers.js"]'));

  const appReport = await verifyUserscript(compiled.code, { sourceBundle: bundle, url: 'https://app.example.com/dashboard' });
  assert.equal(appReport.passed, true, JSON.stringify(appReport.checks, null, 2));
  assert.equal(appReport.checks.length, 4);
  const appSmoke = appReport.checks.find(check => check.name === 'sandbox_e2e_smoke_test');
  assert.match(appSmoke.details, /contentScripts=1\/1/);
  assert.match(appSmoke.details, /pageScripts=2\/2/);
  assert.match(appSmoke.details, /css=2\/2/);

  const docsReport = await verifyUserscript(compiled.code, { sourceBundle: bundle, url: 'https://docs.example.com/guide' });
  assert.equal(docsReport.passed, true, JSON.stringify(docsReport.checks, null, 2));
  const docsSmoke = docsReport.checks.find(check => check.name === 'sandbox_e2e_smoke_test');
  assert.match(docsSmoke.details, /contentScripts=1\/1/);
  assert.match(docsSmoke.details, /pageScripts=0\/0/);
  assert.match(docsSmoke.details, /css=0\/0/);

  const excludedReport = await verifyUserscript(compiled.code, { sourceBundle: bundle, url: 'https://docs.example.com/private/secret' });
  assert.equal(excludedReport.passed, true, JSON.stringify(excludedReport.checks, null, 2));
  const excludedSmoke = excludedReport.checks.find(check => check.name === 'sandbox_e2e_smoke_test');
  assert.match(excludedSmoke.details, /contentScripts=0\/0/);
  assert.match(excludedSmoke.details, /pageScripts=0\/0/);
  assert.match(excludedSmoke.details, /css=0\/0/);
});

test('convertExtensionToUserscript writes an artifact and runs verification end to end', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'crx2user-out-'));
  try {
    const outputPath = join(outputDir, 'generic.user.js');
    const result = await convertExtensionToUserscript(GENERIC_EXT_DIR, { outputPath, verify: true });
    assert.equal(result.verification.passed, true);
    assert.equal(result.warnings.length, 0);
    const { readFile } = await import('node:fs/promises');
    const written = await readFile(outputPath, 'utf8');
    assert.equal(written, result.compiled.code);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('tampering with an embedded payload is detected by recomputed hashes', async () => {
  const bundle = await parseExtensionDir(GENERIC_EXT_DIR);
  const compiled = compileUserscript(bundle);
  const tampered = compiled.code.replace('fixture-token', 'evil-token');
  assert.notEqual(tampered, compiled.code);
  const tamperedPayloads = parseEmbeddedPayloads(tampered);
  assert.ok(tamperedPayloads.backgroundSource.includes('evil-token'));

  const report = await verifyUserscript(tampered, {
    sourceBundle: bundle,
    url: 'https://app.example.com/dashboard'
  });
  assert.equal(report.passed, false);
  const parity = report.checks.find(check => check.name === 'payload_sha256_parity');
  assert.equal(parity.passed, false);
  assert.match(parity.details, /backgroundSource|hash mismatch/);
});

test('symlinks escaping the extension root are rejected', async t => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires elevated privileges on Windows');
    return;
  }
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Symlink Fixture',
      version: '1.0.0',
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'content.js': "'use strict';\n"
  });
  const outsideDir = await mkdtemp(join(tmpdir(), 'crx2user-outside-'));
  const secretPath = join(outsideDir, 'secret.js');
  await writeFile(secretPath, "console.log('secret');\n");
  await symlink(secretPath, join(extensionDir, 'evil.js'));
  const manifestPath = join(extensionDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Symlink Fixture',
    version: '1.0.0',
    content_scripts: [{ matches: ['https://example.com/*'], js: ['evil.js'] }]
  }));
  try {
    await assert.rejects(() => parseExtensionDir(extensionDir), /symlink/);
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('content script files in one group share top-level globals', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Shared Globals Fixture',
      version: '1.0.0',
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['a.js', 'b.js'] }]
    }),
    'background.js': "'use strict';\nchrome.runtime.onMessage.addListener(() => false);\n",
    'a.js': "'use strict';\nvar SHARED_VALUE = 'shared';\n",
    'b.js': "'use strict';\nif (SHARED_VALUE !== 'shared') throw new Error('content script globals are not shared');\n"
  });
  try {
    const report = await convertExtensionToUserscript(extensionDir, { verify: true });
    assert.equal(report.verification.passed, true, JSON.stringify(report.verification.checks, null, 2));
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('importScripts keeps worker execution order when calls appear after statements', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Import Order Fixture',
      version: '1.0.0',
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'background.js': "'use strict';\nvar READY_STATE = 'ready';\nimportScripts('dep.js');\nchrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n  sendResponse({ ok: READY_STATE === 'ready' && DEP_STATE === 'ready-dep' });\n  return false;\n});\n",
    'dep.js': "'use strict';\nvar DEP_STATE = READY_STATE + '-dep';\n",
    'content.js': "'use strict';\n"
  });
  try {
    const bundle = await parseExtensionDir(extensionDir);
    const compiled = compileUserscript(bundle);
    const source = compiled.payloads.backgroundSource;
    const readyIndex = source.indexOf("var READY_STATE");
    const depIndex = source.indexOf("var DEP_STATE");
    const listenerIndex = source.indexOf('chrome.runtime.onMessage.addListener');
    assert.ok(readyIndex >= 0 && depIndex > readyIndex, 'dependency must be inlined after the preceding statement');
    assert.ok(listenerIndex > depIndex, 'statements after importScripts must run after the dependency');
    const report = await verifyUserscript(compiled.code, { sourceBundle: bundle, url: 'https://example.com/' });
    assert.equal(report.passed, true, JSON.stringify(report.checks, null, 2));
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('a throwing page-world script fails verification', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Broken Page Script Fixture',
      version: '1.0.0',
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
      web_accessible_resources: [{ resources: ['page/broken.js'], matches: ['https://example.com/*'] }]
    }),
    'background.js': "'use strict';\nchrome.runtime.onMessage.addListener(() => false);\n",
    'content.js': "'use strict';\nchrome.runtime.getURL('page/broken.js');\n",
    'page/broken.js': "throw new Error('page script boom');\n"
  });
  try {
    const bundle = await parseExtensionDir(extensionDir);
    const compiled = compileUserscript(bundle);
    const report = await verifyUserscript(compiled.code, { sourceBundle: bundle, url: 'https://example.com/' });
    assert.equal(report.passed, false);
    const smoke = report.checks.find(check => check.name === 'sandbox_e2e_smoke_test');
    assert.equal(smoke.passed, false);
    assert.match(smoke.details, /pageScriptErrors=/);
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('storage grants are only requested when the extension uses chrome.storage', async () => {
  const withStorage = await parseExtensionDir(GENERIC_EXT_DIR);
  const withStorageCode = compileUserscript(withStorage).code;
  assert.ok(withStorageCode.includes('// @grant        GM_getValue'));
  assert.ok(withStorageCode.includes('// @grant        GM_setValue'));
  assert.ok(withStorageCode.includes('storageNamespace'));

  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'No Storage Fixture',
      version: '1.0.0',
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'background.js': "'use strict';\nchrome.runtime.onMessage.addListener(() => false);\n",
    'content.js': "'use strict';\n"
  });
  try {
    const withoutStorage = await parseExtensionDir(extensionDir);
    assert.equal(withoutStorage.usesStorage, false);
    const code = compileUserscript(withoutStorage).code;
    assert.ok(!code.includes('// @grant        GM_getValue'));
    assert.ok(!code.includes('// @grant        GM_setValue'));
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('dynamic importScripts is reported as unsupported instead of failing silently', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Dynamic Worker Fixture',
      version: '1.0.0',
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'background.js': "'use strict';\nconst lazyFile = 'lazy.js';\nimportScripts(lazyFile);\nchrome.runtime.onMessage.addListener(() => false);\n",
    'content.js': "'use strict';\n"
  });
  try {
    const bundle = await parseExtensionDir(extensionDir);
    assert.equal(bundle.background.hasDynamicImports, true);
    assert.ok(bundle.warnings.some(warning => warning.includes('Non-literal importScripts')));
    const compiled = compileUserscript(bundle);
    assert.ok(compiled.code.includes('"hasDynamicImports":true'));
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('ES module service workers raise an actionable error', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'ESM Worker Fixture',
      version: '1.0.0',
      background: { service_worker: 'background.js', type: 'module' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'background.js': "export const ready = true;\n",
    'content.js': "'use strict';\n"
  });
  try {
    await assert.rejects(
      () => parseExtensionDir(extensionDir),
      /ES module service workers/
    );
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('CLI accepts --input/--output flags and emits machine-readable JSON', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'crx2user-cli-'));
  try {
    const outputPath = join(outputDir, 'cli.user.js');
    const convert = spawnSync(
      process.execPath,
      [CLI_PATH, 'convert', '--input', GENERIC_EXT_DIR, '--output', outputPath, '--verify', '--json'],
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    assert.equal(convert.status, 0, convert.stderr);
    const report = JSON.parse(convert.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.verification.passed, true);
    assert.equal(report.verification.checks.length, 4);

    const verify = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify', outputPath, '--source', GENERIC_EXT_DIR, '--json'],
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    assert.equal(verify.status, 0, verify.stderr);
    const verifyReport = JSON.parse(verify.stdout);
    assert.equal(verifyReport.ok, true);
    assert.equal(verifyReport.checks.length, 4);

    const usageError = spawnSync(process.execPath, [CLI_PATH, 'convert', '--definitely-not-a-flag'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8'
    });
    assert.equal(usageError.status, 2);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('manifest metadata cannot break out of or inject userscript header tags', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Evil ==/UserScript== Name',
      version: '1.2.3-beta',
      description: 'first line\n==/UserScript==\n// @grant none',
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'background.js': "'use strict';\n",
    'content.js': "'use strict';\n"
  });
  try {
    const bundle = await parseExtensionDir(extensionDir);
    assert.equal(bundle.version, '1.2.3');
    const compiled = compileUserscript(bundle);
    const occurrences = (compiled.code.match(/\/\/ ==\/UserScript==/g) || []).length;
    assert.equal(occurrences, 1, 'header block terminator must only appear once');
    const header = compiled.code.slice(0, compiled.code.indexOf('// ==/UserScript=='));
    assert.ok(!header.includes('@grant        none'), 'description must not inject header tags');
    assert.ok(header.includes('// @name         Evil Name'), 'name is sanitized onto one line');
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});

test('browser APIs that userscripts can never reproduce are reported as warnings', async () => {
  const extensionDir = await createTempExtension({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Privileged API Fixture',
      version: '1.0.0',
      permissions: ['webRequest'],
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'background.js': "'use strict';\nchrome.tabs.create({ url: 'https://example.com' });\nchrome.alarms.create('tick', { periodInMinutes: 1 });\n",
    'content.js': "'use strict';\n"
  });
  try {
    const bundle = await parseExtensionDir(extensionDir);
    assert.deepEqual(bundle.browserApis.unsupported, ['tabs', 'webRequest']);
    assert.deepEqual(bundle.browserApis.degraded, ['alarms']);
    assert.ok(bundle.warnings.some(warning => warning.includes('chrome.tabs') && warning.includes('cannot be converted 1:1')));
    assert.ok(bundle.warnings.some(warning => warning.includes('chrome.alarms')));
  } finally {
    await rm(extensionDir, { recursive: true, force: true });
  }
});
