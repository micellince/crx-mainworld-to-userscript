import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseExtensionDir, extractConnectDomains, sha256 } from './parser.mjs';
import { compileUserscript, buildUserscriptHeader } from './compiler.mjs';
import { verifyUserscript, parseUserscriptHeader, parseEmbeddedAudit } from './verifier.mjs';

export {
  parseExtensionDir,
  extractConnectDomains,
  sha256,
  compileUserscript,
  buildUserscriptHeader,
  verifyUserscript,
  parseUserscriptHeader,
  parseEmbeddedAudit
};

/**
 * High-level API: converts a Chrome MV3 extension directory into a .user.js file
 * and optionally runs full automated verification.
 */
export async function convertExtensionToUserscript(sourceDir, options = {}) {
  const bundle = await parseExtensionDir(sourceDir);
  const compiled = compileUserscript(bundle, options);

  if (options.outputPath) {
    const outAbs = resolve(options.outputPath);
    await mkdir(dirname(outAbs), { recursive: true });
    await writeFile(outAbs, compiled.code, 'utf8');
  }

  let verification = null;
  if (options.verify !== false) {
    verification = await verifyUserscript(compiled.code, { sourceBundle: bundle });
    if (!verification.passed) {
      const failedNames = verification.checks.filter(c => !c.passed).map(c => `${c.name} (${c.details})`).join('; ');
      throw new Error(`Userscript verification failed: ${failedNames}`);
    }
  }

  return {
    bundle,
    compiled,
    verification
  };
}
