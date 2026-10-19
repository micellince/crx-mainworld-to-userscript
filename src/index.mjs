import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  parseExtensionDir,
  extractConnectDomains,
  sha256,
  matchesPattern,
  matchesAnyPattern,
  patternToSampleUrl,
  normalizeUserscriptMatch,
  normalizeVersion,
  sanitizeHeaderValue
} from './parser.mjs';
import { compileUserscript, buildUserscriptHeader, GENERATOR } from './compiler.mjs';
import {
  verifyUserscript,
  parseUserscriptHeader,
  parseEmbeddedAudit
} from './verifier.mjs';

export {
  parseExtensionDir,
  extractConnectDomains,
  sha256,
  matchesPattern,
  matchesAnyPattern,
  patternToSampleUrl,
  normalizeUserscriptMatch,
  normalizeVersion,
  sanitizeHeaderValue,
  compileUserscript,
  buildUserscriptHeader,
  GENERATOR,
  verifyUserscript,
  parseUserscriptHeader,
  parseEmbeddedAudit
};

/**
 * High-level API: converts a Chrome MV3 extension directory into a .user.js
 * file and optionally runs the full automated verification suite.
 */
export async function convertExtensionToUserscript(sourceDir, options = {}) {
  const bundle = await parseExtensionDir(sourceDir);
  const compiled = compileUserscript(bundle, options);

  if (options.outputPath) {
    const outputAbsolutePath = resolve(options.outputPath);
    await mkdir(dirname(outputAbsolutePath), { recursive: true });
    await writeFile(outputAbsolutePath, compiled.code, 'utf8');
  }

  let verification = null;
  if (options.verify !== false) {
    verification = await verifyUserscript(compiled.code, { sourceBundle: bundle, url: options.url });
    if (!verification.passed) {
      const failed = verification.checks
        .filter(check => !check.passed)
        .map(check => `${check.name} (${check.details})`)
        .join('; ');
      throw new Error(`Userscript verification failed: ${failed}`);
    }
  }

  return {
    bundle,
    compiled,
    verification,
    warnings: bundle.warnings || []
  };
}

/**
 * Convenience alias for callers that always want conversion + verification.
 */
export function convertAndVerify(sourceDir, options = {}) {
  return convertExtensionToUserscript(sourceDir, { ...options, verify: true });
}
