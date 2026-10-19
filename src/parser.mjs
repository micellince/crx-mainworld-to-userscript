import { readFile, stat, readdir, realpath, lstat } from 'node:fs/promises';
import { resolve, join, posix, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_EMBEDDED_ASSET_BYTES = 4 * 1024 * 1024;
const RUN_AT_ORDER = ['document-start', 'document-end', 'document-idle'];
const REAL_ROOT_CACHE = new Map();


const PERMANENT_BROWSER_APIS = {
  tabs: 'opening and controlling browser tabs is a browser-extension privilege with no userscript equivalent',
  windows: 'window management is not available to userscripts',
  scripting: 'injecting scripts into other tabs is a browser-extension privilege',
  webRequest: 'network interception/modification is not available to userscripts',
  declarativeNetRequest: 'declarative network rules are not available to userscripts',
  cookies: 'the cookies API is not available to userscripts',
  debugger: 'the debugger API is extension-only',
  identity: 'OAuth/web-auth identity flows are extension-only',
  sidePanel: 'the side panel UI is extension-only',
  offscreen: 'offscreen documents are extension-only',
  proxy: 'proxy control is extension-only',
  management: 'extension management is extension-only',
  permissions: 'runtime permission requests are extension-only',
  privacy: 'privacy settings control is extension-only',
  contentSettings: 'content settings control is extension-only',
  nativeMessaging: 'native messaging is extension-only',
  connectNative: 'native messaging is extension-only',
  devtools: 'devtools integration is extension-only',
  tabGroups: 'tab groups are not available to userscripts',
  webNavigation: 'the webNavigation API is extension-only',
  sessions: 'the sessions API is extension-only',
  history: 'browser history access is extension-only',
  bookmarks: 'browser bookmarks access is extension-only',
  downloads: 'download-item control is extension-only (a plain download may be possible)',
  topSites: 'top sites access is extension-only',
  readingList: 'the reading list API is extension-only',
  fontSettings: 'font settings are extension-only',
  tts: 'text-to-speech is extension-only',
  usb: 'USB access is extension-only',
  serial: 'serial access is extension-only',
  bluetooth: 'Bluetooth access is extension-only',
  hid: 'HID access is extension-only',
  sockets: 'raw sockets are extension-only',
  fileSystemProvider: 'filesystem providers are extension-only',
  printing: 'printing APIs are extension-only',
  enterprise: 'enterprise APIs are extension-only',
  vpnProvider: 'VPN APIs are extension-only',
  wallpaper: 'wallpaper control is extension-only',
  audio: 'audio device control is extension-only',
  system: 'system.* APIs are extension-only'
};

const DEGRADED_BROWSER_APIS = {
  alarms: 'scheduled callbacks only run while a matching page is open (no service worker)',
  action: 'no toolbar button/popup; use an injected UI or the userscript menu instead',
  contextMenus: 'no native context menu integration; use the userscript manager menu',
  browserAction: 'no toolbar button/popup; use an injected UI or the userscript menu instead',
  notifications: 'depends on GM_notification support in the userscript manager',
  commands: 'no global keyboard shortcut API; page-level key listeners only'
};

function detectBrowserApiUsage(sources) {
  const used = new Set();
  const degraded = new Set();
  const patterns = [
    /chrome\s*\.\s*([a-zA-Z][a-zA-Z0-9_]*)/g,
    /chrome\s*\[\s*['"`]([a-zA-Z][a-zA-Z0-9_]*)['"`]\s*\]/g
  ];
  for (const source of sources) {
    const code = String(source || '');
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(code))) {
        const api = match[1];
        if (Object.prototype.hasOwnProperty.call(PERMANENT_BROWSER_APIS, api)) used.add(api);
        else if (Object.prototype.hasOwnProperty.call(DEGRADED_BROWSER_APIS, api)) degraded.add(api);
      }
    }
    if (/chrome\s*\.\s*runtime\s*\.\s*(connectNative|sendNativeMessage)\b/.test(code)) used.add('nativeMessaging');
  }
  return { unsupported: [...used].sort(), degraded: [...degraded].sort() };
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
 * Normalizes a userscript-compatible version string.
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
 * Returns true when the URL matches any pattern. Empty list = no restriction.
 */
export function matchesAnyPattern(href, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(pattern => matchesPattern(href, pattern));
}

/**
 * Builds a concrete sample URL that satisfies a Chrome match pattern.
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

function normalizeGlobList(rawList) {
  const globs = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    globs.push(raw.trim());
  }
  return globs;
}

/**
 * Builds a gate object matching Chrome's content_scripts filtering semantics:
 * matches AND include_globs, minus exclude_matches / exclude_globs.
 */
function makeGate({ matches = [], includeGlobs = [], excludeMatches = [], excludeGlobs = [] } = {}) {
  return {
    matches: [...matches],
    includeGlobs: [...includeGlobs],
    excludeMatches: [...excludeMatches],
    excludeGlobs: [...excludeGlobs]
  };
}

/**
 * Returns true when a Chrome URL gate allows the given href.
 */
export function gateMatches(href, gate) {
  if (!gate) return true;
  const value = String(href || '');
  if (gate.matches && gate.matches.length > 0 && !gate.matches.some(pattern => matchesPattern(value, pattern))) {
    return false;
  }
  if (gate.includeGlobs && gate.includeGlobs.length > 0 && !gate.includeGlobs.some(glob => globToRegExp(glob).test(value))) {
    return false;
  }
  if (gate.excludeMatches && gate.excludeMatches.some(pattern => matchesPattern(value, pattern))) {
    return false;
  }
  if (gate.excludeGlobs && gate.excludeGlobs.some(glob => globToRegExp(glob).test(value))) {
    return false;
  }
  return true;
}

/**
 * OR semantics for asset-level gates. An empty list means "no restriction".
 */
export function gatesMatch(href, gates) {
  if (!gates || gates.length === 0) return true;
  return gates.some(gate => gateMatches(href, gate));
}

function mergeGateLists(left, right) {
  const merged = [...left];
  const seen = new Set(merged.map(gate => JSON.stringify(gate)));
  for (const gate of right) {
    const key = JSON.stringify(gate);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(gate);
    }
  }
  return merged;
}

/**
 * Extracts hostnames for @connect from host permission patterns.
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

async function realRootOf(root) {
  if (!REAL_ROOT_CACHE.has(root)) REAL_ROOT_CACHE.set(root, await realpath(root));
  return REAL_ROOT_CACHE.get(root);
}

/**
 * Rejects files that resolve (through symlinks) outside the extension root,
 * so a malicious unpacked extension cannot embed arbitrary local files.
 */
async function assertRealInside(root, absolutePath, relativePath) {
  const realRoot = await realRootOf(root);
  let realTarget;
  try {
    realTarget = await realpath(absolutePath);
  } catch (error) {
    throw new Error(`Cannot resolve file: ${relativePath} (${error.code || error.message})`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error(`Refusing to read a symlink that escapes the extension root: ${relativePath}`);
  }
  return realTarget;
}

async function loadTextAsset(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`${label} contains an invalid file reference: ${JSON.stringify(relativePath)}`);
  }
  let absolutePath;
  try {
    absolutePath = safeResolve(root, relativePath);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
  let realPath;
  try {
    realPath = await assertRealInside(root, absolutePath, relativePath);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
  let code;
  try {
    code = await readFile(realPath, 'utf8');
  } catch (error) {
    throw new Error(`${label} file not found: ${relativePath} (${error.code || error.message})`);
  }
  return { path: relativePath, code, sha256: sha256(code) };
}

async function expandResourcePattern(root, resourcePattern, warnings) {
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
      const dirAbsolute = currentDir ? safeResolve(root, currentDir) : root;
      let dirInfo;
      try {
        dirInfo = await lstat(dirAbsolute);
      } catch {
        return;
      }
      if (dirInfo.isSymbolicLink()) {
        warnings.push(`Skipping symlinked directory while expanding web_accessible_resources: ${currentDir || '.'}`);
        return;
      }
      let entries;
      try {
        entries = await readdir(dirAbsolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!matcher.test(entry.name)) continue;
        if (entry.isSymbolicLink()) {
          warnings.push(`Skipping symlink in web_accessible_resources: ${currentDir ? `${currentDir}/` : ''}${entry.name}`);
          continue;
        }
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
        const info = await lstat(safeResolve(root, relative));
        if (info.isSymbolicLink()) {
          warnings.push(`Skipping symlink in web_accessible_resources: ${relative}`);
          return;
        }
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

function mergeRunAt(left, right) {
  if (left === null || left === undefined) return right === undefined ? null : right;
  if (right === null || right === undefined) return left;
  return RUN_AT_ORDER.indexOf(left) <= RUN_AT_ORDER.indexOf(right) ? left : right;
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
        imports.push({ ...importedAsset, declaredIn: relativePath, specifier });
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

function codeUsesChromeStorage(code) {
  return /chrome\s*(?:\.\s*storage|\[\s*['"`]storage['"`]\s*\])/.test(String(code || ''));
}

/**
 * Parses an unpacked Chrome Manifest V3 extension directory into a generic
 * bundle ready for userscript compilation and verification.
 */
export async function parseExtensionDir(extDir) {
  const root = resolve(extDir);
  await realRootOf(root);
  let manifestRaw;
  try {
    const manifestPath = await assertRealInside(root, join(root, 'manifest.json'), 'manifest.json');
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read manifest.json in ${root}: ${error.message}`);
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
  // content_scripts: matches, include/exclude globs, run_at, world, frames
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
    const excludeMatches = [];
    for (const rawMatch of Array.isArray(definition.exclude_matches) ? definition.exclude_matches : []) {
      const normalized = normalizeUserscriptMatch(rawMatch, warnings);
      if (normalized && !excludeMatches.includes(normalized)) excludeMatches.push(normalized);
    }
    const includeGlobs = normalizeGlobList(definition.include_globs);
    const excludeGlobs = normalizeGlobList(definition.exclude_globs);

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
      gate: makeGate({ matches, includeGlobs, excludeMatches, excludeGlobs }),
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
  let usesStorage = false;
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
    usesStorage = usesStorage || codeUsesChromeStorage(entry.code);
    for (const imported of collected.imports) usesStorage = usesStorage || codeUsesChromeStorage(imported.code);
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

  const addCssAsset = (asset, gates, source, entryRunAt = null, allFrames = false) => {
    if (cssByPath.has(asset.path)) {
      const existing = cssByPath.get(asset.path);
      existing.gates = mergeGateLists(existing.gates, gates);
      existing.runAt = mergeRunAt(existing.runAt, entryRunAt);
      existing.allFrames = existing.allFrames || allFrames;
      return;
    }
    const record = {
      path: asset.path,
      content: asset.code,
      sha256: asset.sha256,
      gates,
      runAt: entryRunAt || 'document-idle',
      allFrames,
      source
    };
    cssByPath.set(asset.path, record);
    cssAssets.push(record);
  };

  const addPageScript = (asset, gates, source, entryRunAt = null, allFrames = false) => {
    if (pageByPath.has(asset.path)) {
      const existing = pageByPath.get(asset.path);
      existing.gates = mergeGateLists(existing.gates, gates);
      existing.runAt = mergeRunAt(existing.runAt, entryRunAt);
      existing.allFrames = existing.allFrames || allFrames;
      return;
    }
    const record = {
      path: asset.path,
      code: asset.code,
      sha256: asset.sha256,
      gates,
      runAt: entryRunAt || 'document-idle',
      allFrames,
      source
    };
    pageByPath.set(asset.path, record);
    pageScripts.push(record);
  };

  const addBinaryAsset = async (relativePath, gates) => {
    if (binaryByPath.has(relativePath)) return;
    let realPath;
    try {
      const absolute = safeResolve(root, relativePath);
      realPath = await assertRealInside(root, absolute, relativePath);
    } catch {
      warnings.push(`web_accessible_resources file not found: ${relativePath}`);
      return;
    }
    let info;
    try {
      info = await stat(realPath);
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
      buffer = await readFile(realPath);
    } catch {
      warnings.push(`web_accessible_resources file could not be read: ${relativePath}`);
      return;
    }
    const record = {
      path: relativePath,
      mimeType: mimeTypeForPath(relativePath),
      base64: buffer.toString('base64'),
      size: info.size,
      gates,
      dataUri: toDataUri(mimeTypeForPath(relativePath), buffer)
    };
    binaryByPath.set(relativePath, record);
    binaryAssets.push(record);
  };

  for (const entry of contentScripts) {
    for (const asset of entry.css) addCssAsset(asset, [entry.gate], `content_scripts[${entry.index}]`, entry.runAt, entry.allFrames);
    usesStorage = usesStorage || entry.js.some(asset => codeUsesChromeStorage(asset.code));
  }

  const referencedBy = relativePath => contentScripts.filter(entry => entry.js.some(js => js.code.includes(relativePath)));

  for (const warEntry of warEntries) {
    const warMatches = [];
    for (const rawMatch of Array.isArray(warEntry.matches) ? warEntry.matches : []) {
      const normalized = normalizeUserscriptMatch(rawMatch, warnings);
      if (normalized && !warMatches.includes(normalized)) warMatches.push(normalized);
    }
    const fallbackGates = warMatches.length > 0 ? [makeGate({ matches: warMatches })] : [];

    for (const resourcePattern of Array.isArray(warEntry.resources) ? warEntry.resources : []) {
      let files;
      try {
        files = await expandResourcePattern(root, resourcePattern, warnings);
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
          const referencers = referencedBy(file);
          const gates = referencers.length > 0 ? referencers.map(entry => entry.gate) : fallbackGates;
          const entryRunAt = referencers.length > 0
            ? referencers.map(entry => entry.runAt).reduce((left, right) => mergeRunAt(left, right))
            : 'document-idle';
          addCssAsset(asset, gates, 'web_accessible_resources', entryRunAt, referencers.some(entry => entry.allFrames));
        } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
          const asset = await loadTextAsset(root, file, 'web_accessible_resources');
          const referencers = referencedBy(file);
          const gates = referencers.length > 0 ? referencers.map(entry => entry.gate) : fallbackGates;
          const entryRunAt = referencers.length > 0
            ? referencers.map(entry => entry.runAt).reduce((left, right) => mergeRunAt(left, right))
            : 'document-idle';
          if (referencers.length === 0) {
            warnings.push(`Page-world script not referenced by any content script; it will still be injected (${file}).`);
          }
          addPageScript(asset, gates, 'web_accessible_resources', entryRunAt, referencers.some(entry => entry.allFrames));
        } else {
          await addBinaryAsset(file, fallbackGates);
        }
      }
    }
  }

  for (const entry of contentScripts) {
    if (entry.world !== 'MAIN') continue;
    for (const asset of entry.js) {
      addPageScript(asset, [entry.gate], `content_scripts[${entry.index}].world=MAIN`, entry.runAt, entry.allFrames);
    }
  }

  // ---------------------------------------------------------------------
  // Icon + @connect domains + bonus metadata
  // ---------------------------------------------------------------------
  let iconDataUri = null;
  let iconPath = null;
  for (const candidate of readIconCandidates(manifest)) {
    try {
      const absolute = safeResolve(root, candidate.path);
      const realPath = await assertRealInside(root, absolute, candidate.path);
      const buffer = await readFile(realPath);
      iconDataUri = toDataUri(mimeTypeForPath(candidate.path), buffer);
      iconPath = candidate.path;
      break;
    } catch {
      warnings.push(`Icon file not readable: ${candidate.path}`);
    }
  }

  const connectDomains = extractConnectDomains(manifest);
  const noframes = contentScripts.length > 0 && contentScripts.every(entry => entry.allFrames !== true);

  // Detect browser-extension-only APIs so conversion output and documentation
  // are explicit about features a userscript can never reproduce.
  const scannedSources = [];
  if (background) {
    scannedSources.push(background.code);
    for (const imported of background.imports) scannedSources.push(imported.code);
  }
  for (const entry of contentScripts) {
    if (entry.world === 'MAIN') continue;
    for (const asset of entry.js) scannedSources.push(asset.code);
  }
  const browserApis = detectBrowserApiUsage(scannedSources);
  const manifestPermissions = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : [])
  ];
  for (const permission of manifestPermissions) {
    if (typeof permission === 'string' && Object.prototype.hasOwnProperty.call(PERMANENT_BROWSER_APIS, permission)) {
      if (!browserApis.unsupported.includes(permission)) browserApis.unsupported.push(permission);
    }
    if (typeof permission === 'string' && Object.prototype.hasOwnProperty.call(DEGRADED_BROWSER_APIS, permission)) {
      if (!browserApis.degraded.includes(permission)) browserApis.degraded.push(permission);
    }
  }
  browserApis.unsupported.sort();
  browserApis.degraded.sort();
  for (const api of browserApis.unsupported) {
    warnings.push(
      `Extension uses chrome.${api}: ${PERMANENT_BROWSER_APIS[api]}. Features depending on it cannot be converted 1:1 to a userscript.`
    );
  }
  for (const api of browserApis.degraded) {
    warnings.push(
      `Extension uses chrome.${api}: ${DEGRADED_BROWSER_APIS[api]}. It is converted as a best-effort stub.`
    );
  }
  if (manifest.externally_connectable) {
    warnings.push(
      'Manifest declares externally_connectable: userscripts have no extension ID, so websites cannot handshake with them via chrome.runtime messaging. A DOM/postMessage handshake is required instead.'
    );
  }

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
    usesStorage,
    browserApis,
    warnings
  };
}
