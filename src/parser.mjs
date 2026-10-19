import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, join, posix, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_EMBEDDED_ASSET_BYTES = 4 * 1024 * 1024;
const RUN_AT_ORDER = ['document-start', 'document-end', 'document-idle'];

function earlierRunAt(left, right) {
  if (left === null || left === undefined) return right === undefined ? null : right;
  if (right === null || right === undefined) return left;
  return RUN_AT_ORDER.indexOf(left) <= RUN_AT_ORDER.indexOf(right) ? left : right;
}

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm'
};

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function mimeTypeForPath(filePath) {
  const lower = String(filePath).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return (dot >= 0 && MIME_TYPES[lower.slice(dot)]) || 'application/octet-stream';
}

/**
 * Normalizes a credential-free, Tampermonkey-compatible version string.
 * Chrome extension versions are dot-separated integers; userscript managers
 * reject arbitrary suffixes, so fall back to a safe numeric version.
 */
export function normalizeVersion(rawVersion) {
  const raw = String(rawVersion == null ? '' : rawVersion).trim();
  const match = raw.match(/^\d+(?:\.\d+){0,3}/);
  return match ? match[0] : '1.0.0';
}

/**
 * Sanitizes a single-line ==UserScript== metadata value. Prevents a manifest
 * field from injecting new header tags or terminating the header block.
 */
export function sanitizeHeaderValue(value, fallback = '') {
  return String(value == null ? fallback : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/==\/UserScript==/gi, '')
    .replace(/==UserScript==/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  const body = String(pattern)
    .split('*')
    .map(escapeRegExp)
    .join('[^]*');
  return new RegExp(`^${body}$`);
}

function parseMatchPattern(pattern) {
  if (pattern === '<all_urls>') return { allUrls: true };
  const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(String(pattern || ''));
  if (!match) return null;
  return { scheme: match[1], host: match[2], path: match[3] || '/*' };
}

/**
 * Chrome match-pattern matcher (content_scripts / web_accessible_resources).
 * Supports <all_urls>, "*" scheme, "*" host and "*" path wildcards.
 */
export function matchesPattern(href, pattern) {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  if (parsed.allUrls) return /^(?:https?|file|ftp):/i.test(String(href || ''));

  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const protocol = url.protocol.replace(/:$/, '');
  if (parsed.scheme === '*') {
    if (!['http', 'https', 'file', 'ftp'].includes(protocol)) return false;
  } else if (protocol !== parsed.scheme) {
    return false;
  }

  if (parsed.host !== '*') {
    if (!parsed.host.includes('*')) {
      if (url.hostname !== parsed.host && url.host !== parsed.host) return false;
    } else if (parsed.host.startsWith('*.')) {
      const base = parsed.host.slice(2);
      if (url.hostname !== base && !url.hostname.endsWith(`.${base}`)) return false;
    } else {
      return false;
    }
  }

  return globToRegExp(parsed.path || '/*').test(url.pathname || '/');
}

/**
 * Returns true when the URL matches any pattern. A null/empty pattern list
 * means "no restriction" (i.e. every page the userscript runs on).
 */
export function matchesAnyPattern(href, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(pattern => matchesPattern(href, pattern));
}

/**
 * Builds a concrete sample URL that satisfies a Chrome match pattern. Used by
 * the verifier to emulate the page an extension's content scripts target.
 */
export function patternToSampleUrl(pattern) {
  if (!pattern) return null;
  if (pattern === '<all_urls>') return 'https://example.com/';
  const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(String(pattern));
  if (!match) return null;
  const scheme = match[1] === '*' ? 'https' : match[1];
  let host = match[2];
  if (host === '*') host = 'example.com';
  else if (host.startsWith('*.')) host = `sub.${host.slice(2)}`;
  else host = host.replace(/\*/g, 'sub');
  const path = match[3].replace(/\*/g, 'sample');
  if (scheme === 'file') return `file://${path}`;
  return `${scheme}://${host}${path}`;
}

/**
 * Normalizes a Chrome match pattern into a userscript @match pattern.
 * Returns null for patterns a userscript manager cannot express natively.
 */
export function normalizeUserscriptMatch(pattern, warnings = null) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  if (trimmed === '<all_urls>') return '*://*/*';
  const parsed = parseMatchPattern(trimmed);
  if (!parsed) {
    if (warnings) warnings.push(`Unsupported match pattern skipped: ${trimmed}`);
    return null;
  }
  if (parsed.scheme !== '*' && !['http', 'https', 'file', 'ftp'].includes(parsed.scheme)) {
    if (warnings) warnings.push(`Match pattern scheme not supported by userscript managers: ${trimmed}`);
    return null;
  }
  return trimmed;
}

/**
 * Extracts hostnames for @connect from host permission patterns.
 * Accepts both a raw pattern array (backwards compatible) and a manifest.
 */
export function extractConnectDomains(hostPermissions = []) {
  const patterns = Array.isArray(hostPermissions)
    ? hostPermissions
    : [
        ...(Array.isArray(hostPermissions?.host_permissions) ? hostPermissions.host_permissions : []),
        ...(Array.isArray(hostPermissions?.optional_host_permissions) ? hostPermissions.optional_host_permissions : []),
        ...(Array.isArray(hostPermissions?.permissions) ? hostPermissions.permissions : [])
      ];

  const domains = new Set();
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed === '<all_urls>') {
      domains.add('*');
      continue;
    }
    const match = trimmed.match(/^(?:[a-z][a-z0-9+.-]*|\*):\/\/([^/]+)/i);
    if (!match) continue;
    let host = match[1];
    if (host === '*') {
      domains.add('*');
      continue;
    }
    host = host.replace(/^\*\./, '').replace(/:\d+$/, '');
    if (host) domains.add(host);
  }
  return [...domains];
}

function safeResolve(root, relativePath) {
  const cleaned = String(relativePath).replace(/\\/g, '/').replace(/^\.?\//, '');
  const absolute = resolve(root, cleaned);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`Path escapes the extension root: ${relativePath}`);
  }
  return absolute;
}

async function loadTextAsset(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`${label} contains an invalid file reference: ${JSON.stringify(relativePath)}`);
  }
  let code;
  try {
    code = await readFile(safeResolve(root, relativePath), 'utf8');
  } catch (error) {
    throw new Error(`${label} file not found: ${relativePath} (${error.code || error.message})`);
  }
  return { path: relativePath, code, sha256: sha256(code) };
}

async function expandResourcePattern(root, resourcePattern) {
  const pattern = String(resourcePattern || '').trim();
  if (!pattern) return [];
  if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
    throw new Error(`web_accessible_resources entry escapes the extension root: ${pattern}`);
  }
  const parts = pattern.split('/').filter(Boolean);
  const results = [];
  const seen = new Set();

  async function walk(currentDir, index) {
    if (index >= parts.length) return;
    const part = parts[index];
    const isLast = index === parts.length - 1;
    if (part.includes('*')) {
      const matcher = globToRegExp(part);
      let entries;
      try {
        entries = await readdir(join(root, currentDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!matcher.test(entry.name)) continue;
        const relative = currentDir ? `${currentDir}/${entry.name}` : entry.name;
        if (isLast) {
          if (entry.isFile() && !seen.has(relative)) {
            seen.add(relative);
            results.push(relative);
          }
        } else if (entry.isDirectory()) {
          await walk(relative, index + 1);
        }
      }
      return;
    }
    const relative = currentDir ? `${currentDir}/${part}` : part;
    if (isLast) {
      try {
        const info = await stat(join(root, relative));
        if (info.isFile() && !seen.has(relative)) {
          seen.add(relative);
          results.push(relative);
        }
      } catch {
        // Missing resource: caller records a warning.
      }
      return;
    }
    await walk(relative, index + 1);
  }

  await walk('', 0);
  return results;
}

function mergeGates(current, incoming) {
  if (current === null || incoming === null) return null;
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  const merged = [...current];
  for (const item of incoming) if (!merged.includes(item)) merged.push(item);
  return merged;
}

async function collectBackgroundImports(root, entryRelativePath, warnings) {
  const cache = new Map();
  const imports = [];
  const dynamicCalls = [];
  const visited = new Set([entryRelativePath]);

  async function load(relativePath) {
    if (cache.has(relativePath)) return cache.get(relativePath);
    const asset = await loadTextAsset(root, relativePath, 'background import');
    cache.set(relativePath, asset);
    return asset;
  }

  async function visit(relativePath) {
    const asset = await load(relativePath);
    const callPattern = /importScripts\s*\(([^)]*)\)/g;
    let call;
    while ((call = callPattern.exec(asset.code))) {
      const args = call[1];
      const literalPattern = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
      const specifiers = [];
      let literal;
      while ((literal = literalPattern.exec(args))) specifiers.push(literal[2]);
      const leftover = args.replace(literalPattern, '').replace(/[\s,]/g, '');

      if (leftover || specifiers.length === 0) {
        dynamicCalls.push({ declaredIn: relativePath, expression: call[0] });
        warnings.push(`Non-literal importScripts() cannot be inlined (${relativePath}): ${call[0]}`);
        continue;
      }

      for (const specifier of specifiers) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(specifier)) {
          dynamicCalls.push({ declaredIn: relativePath, expression: call[0] });
          warnings.push(`Remote importScripts() URL cannot be inlined: ${specifier}`);
          continue;
        }
        const target = posix.normalize(posix.join(posix.dirname(relativePath), specifier));
        if (posix.isAbsolute(target) || target.startsWith('..')) {
          dynamicCalls.push({ declaredIn: relativePath, expression: call[0] });
          warnings.push(`importScripts() target escapes the extension root: ${specifier}`);
          continue;
        }
        if (visited.has(target)) continue;
        visited.add(target);
        await visit(target);
        let importedAsset;
        try {
          importedAsset = await load(target);
        } catch (error) {
          dynamicCalls.push({ declaredIn: relativePath, expression: call[0] });
          warnings.push(error.message);
          continue;
        }
        imports.push(importedAsset);
      }
    }
  }

  await visit(entryRelativePath);
  return { imports, dynamicCalls };
}

function readIconCandidates(manifest) {
  const candidates = [];
  const pushIcons = (icons, source) => {
    if (!icons) return;
    if (typeof icons === 'string') {
      candidates.push({ path: icons, size: 0, source });
      return;
    }
    if (typeof icons !== 'object') return;
    for (const [size, value] of Object.entries(icons)) {
      if (typeof value !== 'string') continue;
      candidates.push({ path: value, size: Number(size) || 0, source });
    }
  };
  pushIcons(manifest.icons, 'icons');
  pushIcons(manifest.action?.default_icon, 'action');
  pushIcons(manifest.browser_action?.default_icon, 'browser_action');
  candidates.sort((a, b) => b.size - a.size);
  return candidates;
}

function toDataUri(mimeType, buffer) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Parses an unpacked Chrome Manifest V3 extension directory into a generic,
 * structured bundle that is ready for userscript compilation and verification.
 *
 * Generic MV3 surface covered:
 *  - background.service_worker, including recursive static importScripts()
 *  - multiple content_scripts entries (different matches, run_at, world: MAIN)
 *  - content script CSS, web_accessible_resources CSS/JS/other assets
 *  - icons, host_permissions -> @connect, multiple match patterns
 */
export async function parseExtensionDir(extDir) {
  const root = resolve(extDir);
  let manifestRaw;
  try {
    manifestRaw = await readFile(join(root, 'manifest.json'), 'utf8');
  } catch (error) {
    throw new Error(`Cannot read manifest.json in ${root} (${error.code || error.message})`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`Invalid manifest.json: ${error.message}`);
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected Manifest V3 (manifest_version: 3), got: ${manifest.manifest_version}`);
  }

  const warnings = [];
  const version = normalizeVersion(manifest.version);
  if (String(manifest.version || '').trim() !== version) {
    warnings.push(`Manifest version "${manifest.version}" normalized to "${version}" for userscript compatibility.`);
  }

  // ---------------------------------------------------------------------
  // content_scripts: each entry keeps its own matches, run_at and world so
  // the compiled userscript can gate every script to the right pages.
  // ---------------------------------------------------------------------
  const contentScriptDefinitions = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const contentScripts = [];
  const userscriptMatches = [];
  let runAt = 'document-idle';

  for (let index = 0; index < contentScriptDefinitions.length; index += 1) {
    const definition = contentScriptDefinitions[index] || {};
    const matches = [];
    for (const rawMatch of Array.isArray(definition.matches) ? definition.matches : []) {
      const normalized = normalizeUserscriptMatch(rawMatch, warnings);
      if (normalized && !matches.includes(normalized)) matches.push(normalized);
    }
    if (matches.length === 0) {
      warnings.push(`content_scripts[${index}] has no usable match patterns and is ignored.`);
      continue;
    }

    const world = String(definition.world || 'ISOLATED').toUpperCase() === 'MAIN' ? 'MAIN' : 'ISOLATED';
    const rawRunAt = String(definition.run_at || 'document_idle').replace(/_/g, '-');
    const entryRunAt = RUN_AT_ORDER.includes(rawRunAt) ? rawRunAt : 'document-idle';
    if (RUN_AT_ORDER.indexOf(entryRunAt) < RUN_AT_ORDER.indexOf(runAt)) runAt = entryRunAt;

    const js = [];
    for (const file of Array.isArray(definition.js) ? definition.js : []) {
      js.push(await loadTextAsset(root, file, `content_scripts[${index}].js`));
    }
    const css = [];
    for (const file of Array.isArray(definition.css) ? definition.css : []) {
      css.push(await loadTextAsset(root, file, `content_scripts[${index}].css`));
    }

    for (const match of matches) {
      if (!userscriptMatches.includes(match)) userscriptMatches.push(match);
    }
    contentScripts.push({
      index,
      matches,
      runAt: entryRunAt,
      world,
      allFrames: definition.all_frames === true,
      matchAboutBlank: definition.match_about_blank === true,
      js,
      css
    });
  }

  // ---------------------------------------------------------------------
  // background service worker + recursive static importScripts()
  // ---------------------------------------------------------------------
  let background = null;
  const backgroundDefinition = manifest.background;
  if (backgroundDefinition && backgroundDefinition.service_worker) {
    if (String(backgroundDefinition.type || '') === 'module') {
      throw new Error(
        'ES module service workers (background.type = "module") are not supported yet. ' +
          'Bundle the service worker into a single classic script (for example with esbuild --format=iife) before converting.'
      );
    }
    const entry = await loadTextAsset(root, backgroundDefinition.service_worker, 'background.service_worker');
    const collected = await collectBackgroundImports(root, entry.path, warnings);
    if (/^\s*(?:import|export)\s/m.test(entry.code)) {
      warnings.push(
        'background service worker contains top-level ES import/export statements. ' +
          'Only classic service workers are supported; bundle the worker before converting.'
      );
    }
    background = {
      path: entry.path,
      code: entry.code,
      sha256: entry.sha256,
      imports: collected.imports,
      hasDynamicImports: collected.dynamicCalls.length > 0,
      unresolvedImports: collected.dynamicCalls
    };
  }

  // ---------------------------------------------------------------------
  // web_accessible_resources: page-world JS, CSS and binary assets
  // ---------------------------------------------------------------------
  const warEntries = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources.filter(entry => entry && typeof entry === 'object')
    : [];

  const cssAssets = [];
  const pageScripts = [];
  const binaryAssets = [];
  const cssByPath = new Map();
  const pageByPath = new Map();
  const binaryByPath = new Map();

  const addCssAsset = (asset, matches, source, runAt = null) => {
    if (cssByPath.has(asset.path)) {
      const existing = cssByPath.get(asset.path);
      existing.matches = mergeGates(existing.matches, matches);
      existing.runAt = earlierRunAt(existing.runAt, runAt);
      return;
    }
    const record = { path: asset.path, content: asset.code, sha256: asset.sha256, matches, source, runAt };
    cssByPath.set(asset.path, record);
    cssAssets.push(record);
  };

  const addPageScript = (asset, matches, source, runAt = null) => {
    if (pageByPath.has(asset.path)) {
      const existing = pageByPath.get(asset.path);
      existing.matches = mergeGates(existing.matches, matches);
      existing.runAt = earlierRunAt(existing.runAt, runAt);
      return;
    }
    const record = { path: asset.path, code: asset.code, sha256: asset.sha256, matches, source, runAt };
    pageByPath.set(asset.path, record);
    pageScripts.push(record);
  };

  const addBinaryAsset = async (relativePath, bulkMatches) => {
    if (binaryByPath.has(relativePath)) {
      binaryByPath.get(relativePath).matches = mergeGates(binaryByPath.get(relativePath).matches, bulkMatches);
      return;
    }
    let info;
    try {
      info = await stat(safeResolve(root, relativePath));
    } catch {
      warnings.push(`web_accessible_resources file not found: ${relativePath}`);
      return;
    }
    if (!info.isFile()) return;
    if (info.size > MAX_EMBEDDED_ASSET_BYTES) {
      warnings.push(`web_accessible_resources file too large to embed (${relativePath}, ${info.size} bytes); getURL() returns a virtual URL instead.`);
      return;
    }
    let buffer;
    try {
      buffer = await readFile(safeResolve(root, relativePath));
    } catch {
      warnings.push(`web_accessible_resources file could not be read: ${relativePath}`);
      return;
    }
    const record = {
      path: relativePath,
      mimeType: mimeTypeForPath(relativePath),
      base64: buffer.toString('base64'),
      size: info.size,
      matches: bulkMatches,
      dataUri: toDataUri(mimeTypeForPath(relativePath), buffer)
    };
    binaryByPath.set(relativePath, record);
    binaryAssets.push(record);
  };

  // Content-script CSS runs first (matches its entry); web-accessible CSS after.
  for (const entry of contentScripts) {
    for (const asset of entry.css) addCssAsset(asset, entry.matches, `content_scripts[${entry.index}]`, entry.runAt);
  }

  const codeReferencedBy = relativePath =>
    contentScripts.filter(entry => entry.js.some(js => js.code.includes(relativePath)));

  for (const warEntry of warEntries) {
    const warMatches = [];
    for (const rawMatch of Array.isArray(warEntry.matches) ? warEntry.matches : []) {
      const normalized = normalizeUserscriptMatch(rawMatch, warnings);
      if (normalized && !warMatches.includes(normalized)) warMatches.push(normalized);
    }
    const bulkMatches = warMatches.length > 0 ? warMatches : null;

    for (const resourcePattern of Array.isArray(warEntry.resources) ? warEntry.resources : []) {
      let files;
      try {
        files = await expandResourcePattern(root, resourcePattern);
      } catch (error) {
        warnings.push(error.message);
        continue;
      }
      if (files.length === 0) {
        warnings.push(`web_accessible_resources pattern matched no files: ${resourcePattern}`);
        continue;
      }
      for (const file of files) {
        const lower = file.toLowerCase();
        if (lower.endsWith('.css')) {
          const asset = await loadTextAsset(root, file, 'web_accessible_resources');
          const referencers = codeReferencedBy(file);
          const matches = referencers.length > 0
            ? [...new Set(referencers.flatMap(entry => entry.matches))]
            : bulkMatches;
          const runAt = referencers.length > 0
            ? referencers.map(entry => entry.runAt).reduce(earlierRunAt)
            : 'document-idle';
          addCssAsset(asset, matches, 'web_accessible_resources', runAt);
        } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
          const asset = await loadTextAsset(root, file, 'web_accessible_resources');
          const referencers = codeReferencedBy(file);
          const matches = referencers.length > 0
            ? [...new Set(referencers.flatMap(entry => entry.matches))]
            : bulkMatches;
          const runAt = referencers.length > 0
            ? referencers.map(entry => entry.runAt).reduce(earlierRunAt)
            : 'document-idle';
          addPageScript(asset, matches, 'web_accessible_resources', runAt);
        } else {
          await addBinaryAsset(file, bulkMatches);
        }
      }
    }
  }

  // MAIN world content scripts execute directly in the page world.
  for (const entry of contentScripts) {
    if (entry.world !== 'MAIN') continue;
    for (const asset of entry.js) addPageScript(asset, entry.matches, `content_scripts[${entry.index}].world=MAIN`, entry.runAt);
  }

  // ---------------------------------------------------------------------
  // Icon + @connect domains + bonus metadata
  // ---------------------------------------------------------------------
  let iconDataUri = null;
  let iconPath = null;
  for (const candidate of readIconCandidates(manifest)) {
    try {
      const buffer = await readFile(safeResolve(root, candidate.path));
      iconDataUri = toDataUri(mimeTypeForPath(candidate.path), buffer);
      iconPath = candidate.path;
      break;
    } catch {
      warnings.push(`Icon file not found: ${candidate.path}`);
    }
  }

  const connectDomains = extractConnectDomains(manifest);

  const noframes = contentScripts.length > 0 && contentScripts.every(entry => entry.allFrames !== true);

  return {
    root,
    manifest,
    name: String(manifest.name || 'Converted Userscript'),
    shortName: String(manifest.short_name || manifest.name || 'Converted Userscript'),
    version,
    description: String(manifest.description || ''),
    homepageUrl: String(manifest.homepage_url || ''),
    author: String(manifest.author || ''),
    matches: userscriptMatches,
    runAt,
    noframes,
    connectDomains,
    iconDataUri,
    iconPath,
    background,
    contentScripts,
    cssAssets,
    pageScripts,
    binaryAssets,
    webAccessibleResources: warEntries,
    warnings
  };
}
