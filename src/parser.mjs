import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Extracts hostname patterns for @connect from MV3 host_permissions.
 */
export function extractConnectDomains(hostPermissions = []) {
  const domains = new Set();
  for (const pattern of hostPermissions) {
    if (typeof pattern !== 'string') continue;
    const trimmed = pattern.trim();
    if (trimmed === '<all_urls>' || trimmed === '*://*/*') {
      domains.add('*');
      continue;
    }
    const m = trimmed.match(/^(?:https?|wss?|\*):\/\/([^/]+)/i);
    if (m && m[1]) {
      const host = m[1].replace(/^\*\./, '');
      if (host) domains.add(host);
    }
  }
  return [...domains];
}

/**
 * Parses an unpacked Chrome MV3 extension directory into a structured bundle
 * ready for Userscript compilation and verification.
 */
export async function parseExtensionDir(extDir) {
  const root = resolve(extDir);
  const manifestPath = join(root, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected Manifest V3 (manifest_version: 3), got: ${manifest.manifest_version}`);
  }

  // 1. Extract content_scripts matches & run_at
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const matches = [];
  const contentScriptFiles = [];
  let runAt = 'document-idle';

  for (const cs of contentScripts) {
    if (Array.isArray(cs.matches)) {
      for (const m of cs.matches) {
        if (!matches.includes(m)) matches.push(m);
      }
    }
    if (Array.isArray(cs.js)) {
      for (const jsFile of cs.js) {
        if (!contentScriptFiles.includes(jsFile)) contentScriptFiles.push(jsFile);
      }
    }
    if (cs.run_at) {
      runAt = cs.run_at.replace('_', '-');
    }
  }

  // 2. Extract @connect domains from host_permissions
  const connectDomains = extractConnectDomains(manifest.host_permissions || []);

  // 3. Read icon and encode as Base64 data URI
  let iconDataUri = null;
  const icons = manifest.icons || {};
  const preferredIconRel = icons['48'] || icons['128'] || icons['32'] || icons['16'];
  if (preferredIconRel) {
    try {
      const iconBuf = await readFile(join(root, preferredIconRel));
      iconDataUri = `data:image/png;base64,${iconBuf.toString('base64')}`;
    } catch {}
  }

  // 4. Read background service worker if present
  let backgroundCode = '';
  const bgWorkerRel = manifest.background?.service_worker;
  if (bgWorkerRel) {
    backgroundCode = await readFile(join(root, bgWorkerRel), 'utf8');
  }

  // 5. Read content_scripts JS files
  const contentScriptsLoaded = [];
  for (const rel of contentScriptFiles) {
    const code = await readFile(join(root, rel), 'utf8');
    contentScriptsLoaded.push({ path: rel, code, sha256: sha256(code) });
  }

  // 6. Inspect web_accessible_resources & content_scripts to locate CSS and Page-World JS
  const warList = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources.flatMap(entry => entry.resources || [])
    : [];

  const cssAssets = [];
  const pageScripts = [];

  for (const rel of warList) {
    const fullPath = join(root, rel);
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      if (rel.endsWith('.css')) {
        const css = await readFile(fullPath, 'utf8');
        cssAssets.push({ path: rel, content: css, sha256: sha256(css) });
      } else if (rel.endsWith('.js')) {
        const code = await readFile(fullPath, 'utf8');
        pageScripts.push({ path: rel, content: code, sha256: sha256(code) });
      }
    } catch {}
  }

  return {
    root,
    manifest,
    name: manifest.name || 'Converted Userscript',
    shortName: manifest.short_name || manifest.name || 'Userscript',
    version: manifest.version || '1.0.0',
    description: manifest.description || '',
    homepageUrl: manifest.homepage_url || '',
    matches,
    runAt,
    connectDomains,
    iconDataUri,
    background: bgWorkerRel
      ? { path: bgWorkerRel, content: backgroundCode, sha256: sha256(backgroundCode) }
      : null,
    contentScripts: contentScriptsLoaded,
    cssAssets,
    pageScripts
  };
}
