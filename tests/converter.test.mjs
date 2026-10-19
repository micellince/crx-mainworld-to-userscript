import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  extractConnectDomains,
  parseExtensionDir,
  compileUserscript,
  verifyUserscript,
  convertExtensionToUserscript
} from '../src/index.mjs';

const SAMPLE_EXT_DIR = resolve(import.meta.dirname, './fixtures/sample-mv3-ext');
const V0165_EXT_DIR = resolve(import.meta.dirname, '../../backups/v0.16.5/fc27-enhancer-ext');
const OUTPUT_USER_JS = resolve(import.meta.dirname, '../dist/futmarket-app-v0.16.5.user.js');

test('extractConnectDomains extracts hostnames from MV3 host_permissions', () => {
  const domains = extractConnectDomains([
    'https://enhancer-api.futnext.com/*',
    'https://www.futbin.org/*',
    '*://*.ea.com/*'
  ]);
  assert.deepEqual(domains, ['enhancer-api.futnext.com', 'www.futbin.org', 'ea.com']);
});

test('convertExtensionToUserscript converts and verifies self-contained sample MV3 extension fixture', async () => {
  const { bundle, compiled, verification } = await convertExtensionToUserscript(SAMPLE_EXT_DIR, {
    verify: true
  });
  assert.equal(bundle.version, '1.0.0');
  assert.ok(compiled.code.includes('// ==UserScript=='));
  assert.equal(verification.passed, true);
  assert.equal(verification.checks.length, 4);
});

test('convertExtensionToUserscript builds and verifies futmarket-app-v0.16.5.user.js end-to-end', { skip: !existsSync(V0165_EXT_DIR) }, async () => {
  const { bundle, compiled, verification } = await convertExtensionToUserscript(V0165_EXT_DIR, {
    outputPath: OUTPUT_USER_JS,
    updateUrl: 'https://futmarket.app/releases/futmarket-app.user.js',
    downloadUrl: 'https://futmarket.app/releases/futmarket-app.user.js',
    verify: true
  });

  assert.equal(bundle.version, '0.16.5');
  assert.ok(existsSync(OUTPUT_USER_JS));
  assert.ok(compiled.code.includes('// ==UserScript=='));
  assert.ok(compiled.code.includes('// @connect      enhancer-api.futnext.com'));
  assert.ok(compiled.code.includes('// @connect      www.futbin.org'));
  assert.equal(verification.passed, true);
  assert.equal(verification.checks.length, 4);
  for (const check of verification.checks) {
    assert.equal(check.passed, true, `Check ${check.name} failed: ${check.details}`);
  }
});

test('verifyUserscript detects tampered metadata or broken syntax', async () => {
  const bundle = await parseExtensionDir(SAMPLE_EXT_DIR);
  const compiled = compileUserscript(bundle);
  const brokenVersion = compiled.code.replace('// @version      1.0.0', '// @version      9.9.9');
  const report = await verifyUserscript(brokenVersion, { sourceBundle: bundle });
  assert.equal(report.passed, false);
  const metaCheck = report.checks.find(c => c.name === 'metadata_contract');
  assert.equal(metaCheck?.passed, false);
});
