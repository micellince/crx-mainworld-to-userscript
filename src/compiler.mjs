import { sanitizeHeaderValue, sha256 } from './parser.mjs';

export const GENERATOR = 'crx-mainworld-to-userscript@1.2.0';

const REQUIRED_GRANTS = ['GM_xmlhttpRequest', 'GM.xmlHttpRequest', 'GM_addStyle', 'unsafeWindow'];
const STORAGE_GRANTS = ['GM_getValue', 'GM_setValue'];

/**
 * Serializes a value into a JavaScript string literal safe to embed in the
 * generated userscript (line/paragraph separators are escaped explicitly).
 */
function jsLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Stable per-extension namespace used for storage keys so two converted
 * userscripts (or the same script on different origins) never collide.
 */
function buildStorageNamespace(bundle) {
  const slug = String(bundle.name || 'userscript')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'userscript';
  const fingerprint = sha256(`${bundle.name}|${bundle.homepageUrl || ''}|${(bundle.matches || [])[0] || ''}`).slice(0, 12);
  return `${slug}-${fingerprint}`;
}

/**
 * Generates the ==UserScript== metadata block from parsed extension metadata.
 */
export function buildUserscriptHeader(bundle, options = {}) {
  const requestedMatches = Array.isArray(options.matches) && options.matches.length > 0
    ? options.matches
    : bundle.matches || [];

  const matches = [];
  for (const rawMatch of requestedMatches) {
    const match = sanitizeHeaderValue(rawMatch);
    if (match && !matches.includes(match)) matches.push(match);
  }
  if (matches.length === 0) {
    throw new Error(
      'Cannot build a userscript header: the extension has no usable content_scripts matches. ' +
        'Pass an explicit list of match patterns via options.matches.'
    );
  }

  const name = sanitizeHeaderValue(options.name || bundle.name, 'Converted Userscript') || 'Converted Userscript';
  const namespace = sanitizeHeaderValue(options.namespace || bundle.homepageUrl || 'https://crx2user.local');
  const version = sanitizeHeaderValue(bundle.version || '1.0.0') || '1.0.0';
  const description = sanitizeHeaderValue(options.description || bundle.description || '');
  const author = sanitizeHeaderValue(options.author || bundle.author || 'crx2user');
  const homepage = sanitizeHeaderValue(options.homepageUrl || bundle.homepageUrl || '');
  const updateUrl = sanitizeHeaderValue(options.updateUrl || '');
  const downloadUrl = sanitizeHeaderValue(options.downloadUrl || '');
  let supportUrl = sanitizeHeaderValue(options.supportUrl || '');
  const runAt = sanitizeHeaderValue(bundle.runAt || 'document-idle') || 'document-idle';

  const lines = [
    '// ==UserScript==',
    `// @name         ${name}`,
    `// @namespace    ${namespace}`,
    `// @version      ${version}`
  ];
  if (description) lines.push(`// @description  ${description}`);
  lines.push(`// @author       ${author}`);
  if (homepage) {
    lines.push(`// @homepageURL  ${homepage}`);
    if (!supportUrl) supportUrl = homepage;
  }
  if (supportUrl) lines.push(`// @supportURL   ${supportUrl}`);
  if (updateUrl) lines.push(`// @updateURL    ${updateUrl}`);
  if (downloadUrl) lines.push(`// @downloadURL  ${downloadUrl}`);
  for (const match of matches) lines.push(`// @match        ${match}`);
  for (const domain of bundle.connectDomains || []) {
    const connect = sanitizeHeaderValue(domain);
    if (connect) lines.push(`// @connect      ${connect}`);
  }
  lines.push(`// @run-at       ${runAt}`);
  for (const grant of REQUIRED_GRANTS) lines.push(`// @grant        ${grant}`);
  if (bundle.usesStorage) {
    for (const grant of STORAGE_GRANTS) lines.push(`// @grant        ${grant}`);
  }
  if (bundle.noframes && options.noframes !== false) lines.push('// @noframes');
  if (bundle.iconDataUri && options.includeIcon !== false) {
    lines.push(`// @icon         ${bundle.iconDataUri}`);
  }
  lines.push('// ==/UserScript==');
  return lines.join('\n');
}

/**
 * Extension -> virtual/data URL mapping used by the chrome.runtime.getURL()
 * shim. CSS and JS get virtual URLs (the userscript injects them itself);
 * other assets become data URLs so content-script UI code can still use them.
 */
function buildUrlMap(bundle) {
  const urlMap = {};
  const virtual = (prefix, relativePath) => `crx2user://${prefix}/${relativePath}`;

  for (const asset of bundle.cssAssets || []) {
    if (!Object.prototype.hasOwnProperty.call(urlMap, asset.path)) urlMap[asset.path] = virtual('css', asset.path);
  }
  for (const asset of bundle.pageScripts || []) {
    if (!Object.prototype.hasOwnProperty.call(urlMap, asset.path)) urlMap[asset.path] = virtual('js', asset.path);
  }
  for (const entry of bundle.contentScripts || []) {
    for (const asset of entry.js || []) {
      if (!Object.prototype.hasOwnProperty.call(urlMap, asset.path)) urlMap[asset.path] = virtual('js', asset.path);
    }
    for (const asset of entry.css || []) {
      if (!Object.prototype.hasOwnProperty.call(urlMap, asset.path)) urlMap[asset.path] = virtual('css', asset.path);
    }
  }
  if (bundle.background) {
    urlMap[bundle.background.path] = virtual('worker', bundle.background.path);
    for (const imported of bundle.background.imports || []) {
      urlMap[imported.path] = virtual('worker', imported.path);
    }
  }
  for (const asset of bundle.binaryAssets || []) {
    if (!Object.prototype.hasOwnProperty.call(urlMap, asset.path)) urlMap[asset.path] = asset.dataUri;
  }
  if (bundle.iconPath && bundle.iconDataUri && !Object.prototype.hasOwnProperty.call(urlMap, bundle.iconPath)) {
    urlMap[bundle.iconPath] = bundle.iconDataUri;
  }
  urlMap.manifest = 'crx2user://manifest.json';
  return urlMap;
}

function looksLikeStatementPosition(source, start, end) {
  const before = source.slice(Math.max(0, start - 160), start).replace(/\s+$/, '');
  const after = source.slice(end, end + 80).replace(/^\s+/, '');
  const beforeChar = before ? before[before.length - 1] : '';
  const afterChar = after ? after[0] : '';
  const beforeOk = beforeChar === '' || beforeChar === ';' || beforeChar === '{' || beforeChar === '}';
  if (!beforeOk) return false;
  if (afterChar === '') return true;
  if (/[;}\)\]]/.test(afterChar)) return true;
  if (/[A-Za-z0-9_$"'`(]/.test(afterChar)) return true;
  return false;
}

/**
 * Inlines statically analysable importScripts() calls at their original call
 * sites, preserving worker execution order. Calls that cannot be inlined at
 * their call site are prepended as a best-effort fallback.
 */
function buildBackgroundSource(bundle) {
  const background = bundle.background;
  if (!background) return '';

  const lookup = new Map();
  for (const imported of background.imports || []) {
    lookup.set(`${imported.declaredIn}\u0000${imported.specifier}`, imported);
  }
  const inlined = new Set();

  const inlineFile = (relativePath, source) => {
    const callPattern = /importScripts\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)\s*;?/g;
    let output = '';
    let cursor = 0;
    let call;
    while ((call = callPattern.exec(source))) {
      const specifier = call[2];
      const dependency = lookup.get(`${relativePath}\u0000${specifier}`);
      output += source.slice(cursor, call.index);
      if (dependency && looksLikeStatementPosition(source, call.index, callPattern.lastIndex)) {
        if (inlined.has(dependency.path)) {
          output += `\n/* importScripts(${JSON.stringify(specifier)}) already inlined */\n`;
        } else {
          inlined.add(dependency.path);
          output += `\n${inlineFile(dependency.path, dependency.code)}\n`;
        }
      } else {
        output += call[0];
      }
      cursor = callPattern.lastIndex;
    }
    output += source.slice(cursor);
    return output;
  };

  let transformed = inlineFile(background.path, background.code);

  const fallback = [];
  for (const imported of background.imports || []) {
    if (inlined.has(imported.path)) continue;
    inlined.add(imported.path);
    fallback.push(`\n/* fallback inline: ${imported.path} */\n${inlineFile(imported.path, imported.code)}`);
  }
  if (fallback.length > 0) transformed = `${fallback.join('\n;\n')}\n;\n${transformed}`;
  return transformed;
}

/**
 * Runtime template. Never executed in Node.js: serialized via Function#toString
 * and embedded after @@TOKEN@@ substitution.
 */
function crx2userRuntime() {
  'use strict';

  var VERSION = "@@VERSION@@";
  var METADATA = JSON.parse("@@METADATA@@");
  var AUDIT = JSON.parse("@@AUDIT@@");
  var MANIFEST = JSON.parse("@@MANIFEST@@");
  var URL_MAP = JSON.parse("@@URL_MAP@@");
  var PAYLOADS = JSON.parse("@@PAYLOADS@@");

  var BACKGROUND_SOURCE = PAYLOADS.backgroundSource || '';
  var INLINED_IMPORT_NAMES = PAYLOADS.importNames || [];
  var CSS_ASSETS = PAYLOADS.cssAssets || [];
  var CONTENT_SCRIPTS = PAYLOADS.contentScripts || [];
  var PAGE_SCRIPTS = PAYLOADS.pageScripts || [];

  var pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  var pageDoc = (pageWin && pageWin.document) ? pageWin.document : document;

  if (pageDoc && pageDoc.documentElement && pageDoc.documentElement.dataset) {
    if (pageDoc.documentElement.dataset.crx2userBoot === VERSION) return;
    pageDoc.documentElement.dataset.crx2userBoot = VERSION;
  }

  var HOST = (typeof __CRX2USER_HOST__ === 'object' && __CRX2USER_HOST__) ? __CRX2USER_HOST__ : null;

  var stats = {
    version: VERSION,
    backgroundStarted: false,
    backgroundListeners: 0,
    bridgeListenerInvocations: 0,
    cssAssets: 0,
    cssChars: 0,
    contentScripts: [],
    pageScripts: [],
    pageInjectionMode: 'none',
    errors: []
  };

  function recordError(scope, error) {
    stats.errors.push(scope + ': ' + (error && error.message ? error.message : String(error)));
  }

  var ORIGIN = '';
  var HREF = '';
  try {
    var locationObject = pageWin.location || (typeof location !== 'undefined' ? location : null);
    if (locationObject) {
      ORIGIN = String(locationObject.origin || '');
      HREF = String(locationObject.href || '');
    }
  } catch (error) {}

  var IS_TOP_FRAME = true;
  try {
    IS_TOP_FRAME = pageWin.top === pageWin.self || pageWin.frameElement === null || pageWin.frameElement === undefined;
  } catch (error) {
    IS_TOP_FRAME = false;
  }

  function allowedByFrames(allFrames) {
    return IS_TOP_FRAME || Boolean(allFrames);
  }

  // -----------------------------------------------------------------------
  // Chrome match-pattern / glob gating helpers
  // -----------------------------------------------------------------------
  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function globToRegExp(pattern) {
    return new RegExp('^' + String(pattern).split('*').map(escapeRegExp).join('[\\s\\S]*') + '$');
  }

  function parseMatchPattern(pattern) {
    if (pattern === '<all_urls>') return { allUrls: true };
    var match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(String(pattern || ''));
    if (!match) return null;
    return { scheme: match[1], host: match[2], path: match[3] || '/*' };
  }

  function matchesPattern(href, pattern) {
    var parsed = parseMatchPattern(pattern);
    if (!parsed) return false;
    if (parsed.allUrls) return /^(?:https?|file|ftp):/i.test(String(href || ''));
    var url;
    try {
      url = new URL(href);
    } catch (error) {
      return false;
    }
    var protocol = url.protocol.replace(/:$/, '');
    if (parsed.scheme === '*') {
      if (['http', 'https', 'file', 'ftp'].indexOf(protocol) === -1) return false;
    } else if (protocol !== parsed.scheme) {
      return false;
    }
    if (parsed.host !== '*') {
      if (parsed.host.indexOf('*') === -1) {
        if (url.hostname !== parsed.host && url.host !== parsed.host) return false;
      } else if (parsed.host.indexOf('*.') === 0) {
        var base = parsed.host.slice(2);
        if (url.hostname !== base && url.hostname.slice(-(base.length + 1)) !== '.' + base) return false;
      } else {
        return false;
      }
    }
    return globToRegExp(parsed.path || '/*').test(url.pathname || '/');
  }

  function gateAllows(gate) {
    if (!gate) return true;
    var index;
    if (gate.matches && gate.matches.length > 0) {
      var matchOk = false;
      for (index = 0; index < gate.matches.length; index += 1) {
        if (matchesPattern(HREF, gate.matches[index])) {
          matchOk = true;
          break;
        }
      }
      if (!matchOk) return false;
    }
    if (gate.includeGlobs && gate.includeGlobs.length > 0) {
      var globOk = false;
      for (index = 0; index < gate.includeGlobs.length; index += 1) {
        if (globToRegExp(gate.includeGlobs[index]).test(HREF)) {
          globOk = true;
          break;
        }
      }
      if (!globOk) return false;
    }
    if (gate.excludeMatches) {
      for (index = 0; index < gate.excludeMatches.length; index += 1) {
        if (matchesPattern(HREF, gate.excludeMatches[index])) return false;
      }
    }
    if (gate.excludeGlobs) {
      for (index = 0; index < gate.excludeGlobs.length; index += 1) {
        if (globToRegExp(gate.excludeGlobs[index]).test(HREF)) return false;
      }
    }
    return true;
  }

  function gatesAllow(gates) {
    if (!gates || gates.length === 0) return true;
    for (var index = 0; index < gates.length; index += 1) {
      if (gateAllows(gates[index])) return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Small event/emitter helper shared by chrome.* shims
  // -----------------------------------------------------------------------
  function createEvent() {
    var listeners = [];
    return {
      addListener: function (fn) {
        if (typeof fn === 'function' && listeners.indexOf(fn) === -1) listeners.push(fn);
      },
      removeListener: function (fn) {
        var index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      },
      hasListener: function (fn) {
        return listeners.indexOf(fn) !== -1;
      },
      emit: function (args) {
        var snapshot = listeners.slice();
        for (var index = 0; index < snapshot.length; index += 1) {
          try {
            snapshot[index].apply(null, args);
          } catch (error) {}
        }
      }
    };
  }

  function callbackOrPromise(value, callback) {
    if (typeof callback === 'function') {
      Promise.resolve().then(function () {
        callback(value);
      });
      return undefined;
    }
    return Promise.resolve(value);
  }

  // -----------------------------------------------------------------------
  // chrome.storage shim. Uses GM storage when granted (isolated from the
  // page); session storage is always in-memory. localStorage is only a
  // namespaced fallback when GM storage is unavailable.
  // -----------------------------------------------------------------------
  function createStorageArea(areaName, onChangedEvent) {
    var storageKey = 'crx2user:storage:' + METADATA.storageNamespace + ':' + areaName;
    var memory = {};

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function gmStorageAvailable() {
      return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    }

    function readAll() {
      if (areaName === 'session') return clone(memory);
      try {
        if (gmStorageAvailable()) {
          var stored = GM_getValue(storageKey, null);
          if (stored !== null && stored !== undefined) return typeof stored === 'string' ? JSON.parse(stored) : stored;
          return {};
        }
      } catch (error) {}
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          var raw = localStorage.getItem(storageKey);
          if (raw) return JSON.parse(raw) || {};
        }
      } catch (error) {}
      return clone(memory);
    }

    function writeAll(value) {
      memory = clone(value);
      if (areaName === 'session') return;
      try {
        if (gmStorageAvailable()) {
          GM_setValue(storageKey, value);
          return;
        }
      } catch (error) {}
      try {
        if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(storageKey, JSON.stringify(value));
      } catch (error) {}
    }

    function pick(keys) {
      var all = readAll();
      var result = {};
      if (keys === undefined || keys === null) return all;
      if (typeof keys === 'string') {
        if (Object.prototype.hasOwnProperty.call(all, keys)) result[keys] = all[keys];
        return result;
      }
      if (Array.isArray(keys)) {
        for (var index = 0; index < keys.length; index += 1) {
          var key = String(keys[index]);
          if (Object.prototype.hasOwnProperty.call(all, key)) result[key] = all[key];
        }
        return result;
      }
      if (typeof keys === 'object') {
        for (var name in keys) {
          if (!Object.prototype.hasOwnProperty.call(keys, name)) continue;
          result[name] = Object.prototype.hasOwnProperty.call(all, name) ? all[name] : keys[name];
        }
      }
      return result;
    }

    function emitChanges(changes) {
      if (onChangedEvent && Object.keys(changes).length > 0) onChangedEvent.emit([changes, areaName]);
    }

    return {
      get: function (keys, callback) {
        return callbackOrPromise(pick(keys), callback);
      },
      set: function (items, callback) {
        var all = readAll();
        var changes = {};
        for (var key in items) {
          if (!Object.prototype.hasOwnProperty.call(items, key)) continue;
          changes[key] = { oldValue: all[key], newValue: items[key] };
          all[key] = items[key];
        }
        writeAll(all);
        emitChanges(changes);
        return callbackOrPromise(undefined, callback);
      },
      remove: function (keys, callback) {
        var all = readAll();
        var list = Array.isArray(keys) ? keys : [keys];
        var changes = {};
        for (var index = 0; index < list.length; index += 1) {
          var key = String(list[index]);
          if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
          changes[key] = { oldValue: all[key], newValue: undefined };
          delete all[key];
        }
        writeAll(all);
        emitChanges(changes);
        return callbackOrPromise(undefined, callback);
      },
      clear: function (callback) {
        var all = readAll();
        var changes = {};
        for (var key in all) {
          if (Object.prototype.hasOwnProperty.call(all, key)) changes[key] = { oldValue: all[key], newValue: undefined };
        }
        writeAll({});
        emitChanges(changes);
        return callbackOrPromise(undefined, callback);
      }
    };
  }

  // -----------------------------------------------------------------------
  // chrome.runtime shim: messaging bus, ports, getURL, getManifest
  // -----------------------------------------------------------------------
  function normalizeExtensionPath(path) {
    return String(path || '').replace(/^\.?\//, '');
  }

  function extensionUrl(path) {
    var normalized = normalizeExtensionPath(path);
    if (!normalized) return 'crx2user://';
    if (Object.prototype.hasOwnProperty.call(URL_MAP, normalized)) return URL_MAP[normalized];
    return 'crx2user://asset/' + normalized;
  }

  var storageOnChanged = createEvent();
  var messageListeners = [];
  var connectListeners = [];
  var runtimeOnInstalled = createEvent();
  var runtimeOnStartup = createEvent();
  var runtimeOnSuspend = createEvent();
  var RUNTIME_ID = 'crx2user@' + VERSION;

  var runtime = {
    id: RUNTIME_ID,
    getManifest: function () {
      return JSON.parse(JSON.stringify(MANIFEST));
    },
    getURL: extensionUrl,
    lastError: null,
    onMessage: {
      addListener: function (fn) {
        if (typeof fn === 'function' && messageListeners.indexOf(fn) === -1) messageListeners.push(fn);
      },
      removeListener: function (fn) {
        var index = messageListeners.indexOf(fn);
        if (index >= 0) messageListeners.splice(index, 1);
      },
      hasListener: function (fn) {
        return messageListeners.indexOf(fn) !== -1;
      }
    },
    onConnect: {
      addListener: function (fn) {
        if (typeof fn === 'function' && connectListeners.indexOf(fn) === -1) connectListeners.push(fn);
      },
      removeListener: function (fn) {
        var index = connectListeners.indexOf(fn);
        if (index >= 0) connectListeners.splice(index, 1);
      },
      hasListener: function (fn) {
        return connectListeners.indexOf(fn) !== -1;
      }
    },
    onInstalled: runtimeOnInstalled,
    onStartup: runtimeOnStartup,
    onSuspend: runtimeOnSuspend,
    getPlatformInfo: function (callback) {
      return callbackOrPromise({ os: 'mac', arch: 'x86-64', nacl_arch: 'x86-64' }, callback);
    },
    reload: function () {},
    sendMessage: function (first, second, third) {
      var message = first;
      var callback = second;
      if (typeof first === 'string' && second !== undefined) {
        message = second;
        callback = third;
      }
      var responded = false;
      var finished = false;
      var resolvePromise = null;
      var promise = null;
      if (typeof callback !== 'function') {
        promise = new Promise(function (resolve) {
          resolvePromise = resolve;
        });
      }
      function finish(response) {
        if (finished) return;
        finished = true;
        var error = runtime.lastError;
        if (typeof callback === 'function') callback(response);
        if (resolvePromise) resolvePromise(response);
        runtime.lastError = null;
      }
      function sendResponse(response) {
        if (responded) return;
        responded = true;
        finish(response);
      }
      var listeners = messageListeners.slice();
      var sender = { id: RUNTIME_ID, url: HREF || ORIGIN, frameId: 0 };
      var expectsAsync = false;
      for (var index = 0; index < listeners.length; index += 1) {
        stats.bridgeListenerInvocations += 1;
        try {
          var result = listeners[index](message, sender, sendResponse);
          if (result === true) expectsAsync = true;
        } catch (error) {
          runtime.lastError = { message: error && error.message ? error.message : String(error) };
          finish(undefined);
          return promise;
        }
      }
      if (!responded && !expectsAsync) {
        Promise.resolve().then(function () {
          finish(undefined);
        });
      }
      return promise;
    },
    connect: function (info) {
      var name = info && info.name ? String(info.name) : '';
      var disconnected = false;
      var pageSideOnMessage = createEvent();
      var pageSideOnDisconnect = createEvent();
      var backgroundSideOnMessage = createEvent();
      var backgroundSideOnDisconnect = createEvent();

      function deliver(event, payload) {
        Promise.resolve().then(function () {
          event.emit([payload]);
        });
      }

      var pageSide = {
        name: name,
        onMessage: pageSideOnMessage,
        onDisconnect: pageSideOnDisconnect,
        postMessage: function (payload) {
          if (!disconnected) deliver(backgroundSideOnMessage, payload);
        },
        disconnect: function () {
          if (disconnected) return;
          disconnected = true;
          deliver(backgroundSideOnDisconnect, pageSide);
          deliver(pageSideOnDisconnect, backgroundSide);
        }
      };
      var backgroundSide = {
        name: name,
        sender: { id: RUNTIME_ID, url: HREF || ORIGIN },
        onMessage: backgroundSideOnMessage,
        onDisconnect: backgroundSideOnDisconnect,
        postMessage: function (payload) {
          if (!disconnected) deliver(pageSideOnMessage, payload);
        },
        disconnect: function () {
          if (disconnected) return;
          disconnected = true;
          deliver(pageSideOnDisconnect, backgroundSide);
          deliver(backgroundSideOnDisconnect, pageSide);
        }
      };

      var snapshot = connectListeners.slice();
      Promise.resolve().then(function () {
        for (var index = 0; index < snapshot.length; index += 1) {
          try {
            snapshot[index](backgroundSide);
          } catch (error) {}
        }
      });
      return pageSide;
    }
  };

  // -----------------------------------------------------------------------
  // Additional chrome.* stubs for common MV3 background APIs. They never
  // throw at boot; calls that cannot be emulated in a userscript reject
  // with a descriptive error instead of crashing the worker.
  // -----------------------------------------------------------------------
  var actionOnClicked = createEvent();
  var contextMenusOnClicked = createEvent();
  var notificationsOnClicked = createEvent();
  var alarmEvent = createEvent();
  var alarmTimers = {};
  var alarmRecords = {};
  var nextTabId = 1;

  function alarmDelayMillis(info) {
    var when = Number(info && info.when);
    if (when > 0) return Math.max(0, when - Date.now());
    var delay = Number(info && info.delayInMinutes);
    if (delay > 0) return delay * 60000;
    var period = Number(info && info.periodInMinutes);
    if (period > 0) return period * 60000;
    return 60000;
  }

  function clearAlarmTimer(name) {
    if (alarmTimers[name]) {
      clearTimeout(alarmTimers[name]);
      delete alarmTimers[name];
    }
  }

  function scheduleAlarm(name, info) {
    clearAlarmTimer(name);
    var delay = alarmDelayMillis(info);
    var period = Number(info && info.periodInMinutes) || 0;
    alarmRecords[name] = { name: name, scheduledTime: Date.now() + delay, periodInMinutes: period || undefined };
    function fire() {
      var record = alarmRecords[name];
      if (!record) return;
      alarmEvent.emit([{ name: name, scheduledTime: Date.now() }]);
      if (period > 0) {
        record.scheduledTime = Date.now() + period * 60000;
        alarmTimers[name] = setTimeout(fire, period * 60000);
      } else {
        delete alarmRecords[name];
        delete alarmTimers[name];
      }
    }
    alarmTimers[name] = setTimeout(fire, delay);
  }

  var chromeAlarms = {
    create: function (nameOrInfo, maybeInfo) {
      var name = typeof nameOrInfo === 'string' ? nameOrInfo : '';
      var info = typeof nameOrInfo === 'string' ? (maybeInfo || {}) : (nameOrInfo || {});
      scheduleAlarm(name, info);
      return callbackOrPromise(undefined);
    },
    clear: function (name, callback) {
      var key = String(name);
      var existed = Boolean(alarmRecords[key]);
      clearAlarmTimer(key);
      delete alarmRecords[key];
      return callbackOrPromise(existed, callback);
    },
    clearAll: function (callback) {
      for (var key in alarmTimers) {
        if (Object.prototype.hasOwnProperty.call(alarmTimers, key)) clearTimeout(alarmTimers[key]);
      }
      alarmTimers = {};
      alarmRecords = {};
      return callbackOrPromise(true, callback);
    },
    get: function (name, callback) {
      var record = alarmRecords[String(name)];
      if (!record) return callbackOrPromise(undefined, callback);
      return callbackOrPromise({
        name: record.name,
        scheduledTime: record.scheduledTime,
        periodInMinutes: record.periodInMinutes
      }, callback);
    },
    getAll: function (callback) {
      var list = [];
      for (var key in alarmRecords) {
        if (!Object.prototype.hasOwnProperty.call(alarmRecords, key)) continue;
        var record = alarmRecords[key];
        list.push({ name: record.name, scheduledTime: record.scheduledTime, periodInMinutes: record.periodInMinutes });
      }
      return callbackOrPromise(list, callback);
    },
    onAlarm: alarmEvent
  };

  var chromeTabs = {
    create: function (properties, callback) {
      var props = properties || {};
      var tab = {
        id: nextTabId,
        url: String(props.url || 'about:blank'),
        active: props.active !== false,
        status: 'complete',
        windowId: 1
      };
      nextTabId += 1;
      try {
        if (pageWin && typeof pageWin.open === 'function' && tab.url !== 'about:blank') pageWin.open(tab.url, '_blank');
      } catch (error) {}
      return callbackOrPromise(tab, callback);
    },
    get: function (tabId, callback) {
      return callbackOrPromise({ id: tabId, url: HREF, active: true, status: 'complete', windowId: 1 }, callback);
    },
    query: function (queryInfo, callback) {
      return callbackOrPromise([{ id: 1, url: HREF, active: true, status: 'complete', windowId: 1 }], callback);
    },
    update: function (tabId, properties, callback) {
      return callbackOrPromise({
        id: tabId,
        url: (properties && properties.url) || HREF,
        active: true,
        status: 'complete',
        windowId: 1
      }, callback);
    },
    remove: function (tabIds, callback) {
      return callbackOrPromise(undefined, callback);
    },
    sendMessage: function () {
      return Promise.reject(new Error('chrome.tabs.sendMessage is not supported in converted userscripts'));
    }
  };

  var chromeScripting = {
    executeScript: function () {
      return Promise.reject(new Error('chrome.scripting.executeScript is not supported in converted userscripts'));
    },
    insertCSS: function () {
      return Promise.reject(new Error('chrome.scripting.insertCSS is not supported in converted userscripts'));
    }
  };

  function noopCallback(value) {
    return function (callback) {
      return callbackOrPromise(value, callback);
    };
  }

  var chromeAction = {
    onClicked: actionOnClicked,
    setBadgeText: noopCallback(undefined),
    setBadgeBackgroundColor: noopCallback(undefined),
    setTitle: noopCallback(undefined),
    setIcon: noopCallback(undefined),
    setPopup: noopCallback(undefined),
    getPopup: noopCallback(''),
    getTitle: noopCallback(''),
    getBadgeText: noopCallback('')
  };

  var chromeNotifications = {
    create: function (id, options, callback) {
      if (typeof id === 'object' && id !== null) {
        callback = options;
        id = (id && id.id) || 'notification';
      }
      return callbackOrPromise(String(id || 'notification'), callback);
    },
    clear: noopCallback(true),
    update: noopCallback(true),
    onClicked: notificationsOnClicked
  };

  var chromeContextMenus = {
    create: noopCallback(undefined),
    remove: noopCallback(undefined),
    removeAll: noopCallback(undefined),
    update: noopCallback(undefined),
    onClicked: contextMenusOnClicked
  };

  var chromeShim = {
    runtime: runtime,
    storage: {
      local: createStorageArea('local', storageOnChanged),
      sync: createStorageArea('sync', storageOnChanged),
      session: createStorageArea('session', storageOnChanged),
      onChanged: {
        addListener: storageOnChanged.addListener,
        removeListener: storageOnChanged.removeListener,
        hasListener: storageOnChanged.hasListener
      }
    },
    alarms: chromeAlarms,
    tabs: chromeTabs,
    scripting: chromeScripting,
    action: chromeAction,
    notifications: chromeNotifications,
    contextMenus: chromeContextMenus,
    i18n: {
      getMessage: function (key) {
        return String(key);
      },
      getUILanguage: function () {
        return (typeof navigator !== 'undefined' && navigator && navigator.language) || 'en';
      }
    }
  };

  // -----------------------------------------------------------------------
  // GM_xmlhttpRequest backed fetch() shim for the background worker
  // -----------------------------------------------------------------------
  function buildHeaders(rawHeaders) {
    var map = {};
    var lines = String(rawHeaders || '').split(/\r?\n/);
    for (var index = 0; index < lines.length; index += 1) {
      var colon = lines[index].indexOf(':');
      if (colon <= 0) continue;
      var key = lines[index].slice(0, colon).trim().toLowerCase();
      var value = lines[index].slice(colon + 1).trim();
      if (!map[key]) map[key] = [];
      map[key].push(value);
    }
    return {
      get: function (name) {
        var values = map[String(name).toLowerCase()];
        return values ? values.join(', ') : null;
      },
      has: function (name) {
        return !!map[String(name).toLowerCase()];
      },
      forEach: function (fn) {
        for (var key in map) {
          if (Object.prototype.hasOwnProperty.call(map, key)) fn(map[key].join(', '), key);
        }
      }
    };
  }

  function resolveGmXhr() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
    if (pageWin && typeof pageWin.GM_xmlhttpRequest === 'function') return pageWin.GM_xmlhttpRequest;
    return null;
  }

  function gmFetch(url, init) {
    init = init || {};
    var gmXhr = resolveGmXhr();
    if (!gmXhr) {
      if (typeof fetch === 'function') return fetch(url, init);
      return Promise.reject(new Error('NETWORK_ERROR: neither GM_xmlhttpRequest nor fetch is available'));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var signal = init.signal;
      var request = null;

      function cleanup() {
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      }

      function onAbort() {
        if (settled) return;
        settled = true;
        try {
          if (request && request.abort) request.abort();
        } catch (error) {}
        cleanup();
        var abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        reject(abortError);
      }

      if (signal && signal.aborted) {
        var abortedError = new Error('The operation was aborted.');
        abortedError.name = 'AbortError';
        reject(abortedError);
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });

      request = gmXhr({
        method: String(init.method || 'GET').toUpperCase(),
        url: String(url),
        headers: init.headers || { Accept: 'application/json' },
        data: init.body,
        timeout: Number(init.timeout) || 15000,
        onload: function (response) {
          if (settled) return;
          settled = true;
          cleanup();
          var status = Number((response && response.status) || 200);
          var responseText = response && typeof response.responseText === 'string' ? response.responseText : '';
          resolve({
            ok: status >= 200 && status < 300,
            status: status,
            statusText: (response && response.statusText) || '',
            url: (response && response.finalUrl) || String(url),
            headers: buildHeaders(response && response.responseHeaders),
            text: function () {
              return Promise.resolve(responseText);
            },
            json: function () {
              return Promise.resolve().then(function () {
                return JSON.parse(responseText);
              });
            }
          });
        },
        onerror: function (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error((error && error.error) || 'NETWORK_ERROR'));
        },
        ontimeout: function () {
          if (settled) return;
          settled = true;
          cleanup();
          var timeoutError = new Error('NETWORK_TIMEOUT');
          timeoutError.name = 'TimeoutError';
          reject(timeoutError);
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // Worker-style self stub + globalThis proxy with a chrome property
  // -----------------------------------------------------------------------
  function createWorkerSelf() {
    var events = {};
    return {
      location: { href: HREF, origin: ORIGIN },
      addEventListener: function (type, fn) {
        if (!events[type]) events[type] = [];
        events[type].push(fn);
      },
      removeEventListener: function (type, fn) {
        var list = events[type] || [];
        var index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      dispatchEvent: function (event) {
        var list = events[event && event.type] || [];
        for (var index = 0; index < list.length; index += 1) {
          try {
            list[index](event);
          } catch (error) {}
        }
        return true;
      },
      skipWaiting: function () {
        return Promise.resolve();
      },
      clients: {
        claim: function () {
          return Promise.resolve();
        },
        matchAll: function () {
          return Promise.resolve([]);
        }
      },
      registration: {
        showNotification: function () {
          return Promise.resolve();
        }
      }
    };
  }

  function createGlobalProxy() {
    var target = typeof globalThis !== 'undefined' ? globalThis : pageWin;
    try {
      return new Proxy(target, {
        get: function (object, property) {
          if (property === 'chrome') return chromeShim;
          var value = object[property];
          if (typeof value === 'function') return value.bind(object);
          return value;
        },
        set: function (object, property, value) {
          object[property] = value;
          return true;
        }
      });
    } catch (error) {
      return target;
    }
  }

  var globalProxy = createGlobalProxy();

  // -----------------------------------------------------------------------
  // 1. Boot the original background service worker inside the GM sandbox
  // -----------------------------------------------------------------------
  function importScriptsShim() {
    for (var index = 0; index < arguments.length; index += 1) {
      var name = String(arguments[index]);
      if (INLINED_IMPORT_NAMES.indexOf(name) === -1) {
        throw new Error(
          'crx2user: importScripts("' + name + '") cannot be resolved at runtime. ' +
            'Only statically analysable worker imports are inlined during conversion.'
        );
      }
    }
  }

  if (BACKGROUND_SOURCE) {
    try {
      var runBackground = new Function('chrome', 'fetch', 'self', 'importScripts', 'globalThis', BACKGROUND_SOURCE);
      runBackground(chromeShim, gmFetch, createWorkerSelf(), importScriptsShim, globalProxy);
      stats.backgroundStarted = true;
    } catch (error) {
      recordError('background', error);
    }
  } else {
    stats.backgroundStarted = true;
  }
  stats.backgroundListeners = messageListeners.length;

  // Honors each content_scripts entry's run_at even though the userscript
  // itself is injected at the earliest @run-at across the extension.
  function whenDocumentReady(runAt, callback) {
    var readyState = 'loading';
    try {
      readyState = String((pageDoc && pageDoc.readyState) || 'loading');
    } catch (error) {}
    if (!runAt || runAt === 'document-start' || readyState !== 'loading') {
      callback();
      return;
    }
    var fired = false;
    function onReady() {
      if (fired) return;
      fired = true;
      try {
        pageDoc.removeEventListener('DOMContentLoaded', onReady);
      } catch (error) {}
      callback();
    }
    try {
      pageDoc.addEventListener('DOMContentLoaded', onReady);
    } catch (error) {
      onReady();
    }
  }

  // -----------------------------------------------------------------------
  // 2. Inject extension CSS (content script CSS + web accessible CSS)
  // -----------------------------------------------------------------------
  function injectCssAsset(cssAsset) {
    var injected = false;
    if (typeof GM_addStyle === 'function') {
      try {
        var styleElement = GM_addStyle(cssAsset.content);
        if (styleElement && styleElement.dataset) styleElement.dataset.crx2userCss = cssAsset.path;
        injected = true;
      } catch (error) {}
    }
    if (!injected && pageDoc && pageDoc.createElement) {
      try {
        var styleNode = pageDoc.createElement('style');
        if (styleNode.dataset) styleNode.dataset.crx2userCss = cssAsset.path;
        styleNode.textContent = cssAsset.content;
        var styleParent = pageDoc.head || pageDoc.documentElement || pageDoc.body;
        if (styleParent && styleParent.appendChild) styleParent.appendChild(styleNode);
        injected = true;
      } catch (error) {
        recordError('css:' + cssAsset.path, error);
      }
    }
    if (injected) {
      stats.cssAssets += 1;
      stats.cssChars += cssAsset.content.length;
    }
  }

  for (var cssIndex = 0; cssIndex < CSS_ASSETS.length; cssIndex += 1) {
    (function (asset) {
      if (!allowedByFrames(asset.allFrames)) return;
      if (!gatesAllow(asset.gates)) return;
      whenDocumentReady(asset.runAt, function () {
        injectCssAsset(asset);
      });
    })(CSS_ASSETS[cssIndex]);
  }

  // -----------------------------------------------------------------------
  // 3. Run the extension's own content scripts (the generic messaging bridge)
  // -----------------------------------------------------------------------
  function runContentScriptEntry(entry) {
    var sources = [];
    for (var fileIndex = 0; fileIndex < entry.js.length; fileIndex += 1) {
      stats.contentScripts.push(entry.js[fileIndex].path);
      sources.push(entry.js[fileIndex].code);
    }
    if (sources.length === 0) return;
    try {
      // One Function body per entry: files of the same content script group
      // share top-level globals, matching Chrome's isolated-world semantics.
      var runContentScript = new Function('chrome', 'fetch', 'self', 'globalThis', sources.join('\n;\n'));
      runContentScript(chromeShim, gmFetch, pageWin, globalProxy);
    } catch (error) {
      recordError('contentScript:' + entry.js.map(function (asset) {
        return asset.path;
      }).join('+'), error);
    }
  }

  for (var scriptIndex = 0; scriptIndex < CONTENT_SCRIPTS.length; scriptIndex += 1) {
    (function (entry) {
      if (entry.world === 'MAIN') return;
      if (!allowedByFrames(entry.allFrames)) return;
      if (!gatesAllow(entry.gates)) return;
      whenDocumentReady(entry.runAt, function () {
        runContentScriptEntry(entry);
      });
    })(CONTENT_SCRIPTS[scriptIndex]);
  }

  // -----------------------------------------------------------------------
  // 4. Inject page-world scripts (web accessible JS + world:MAIN scripts)
  // -----------------------------------------------------------------------
  var inlineInjectionWorks = false;
  try {
    if (pageDoc && pageDoc.createElement && pageDoc.documentElement && pageDoc.documentElement.dataset) {
      var probeNode = pageDoc.createElement('script');
      probeNode.textContent = 'document.documentElement.dataset.crx2userCspProbe="1";';
      var probeParent = pageDoc.head || pageDoc.documentElement || pageDoc.body;
      probeParent.appendChild(probeNode);
      if (probeNode.parentNode) probeNode.parentNode.removeChild(probeNode);
      else if (probeNode.remove) probeNode.remove();
      inlineInjectionWorks = pageDoc.documentElement.dataset.crx2userCspProbe === '1';
      try {
        delete pageDoc.documentElement.dataset.crx2userCspProbe;
      } catch (error) {}
    }
  } catch (error) {
    recordError('page-injection-probe', error);
  }
  stats.pageInjectionMode = inlineInjectionWorks ? 'inline' : 'eval';

  function injectPageScript(pageAsset) {
    if (inlineInjectionWorks) {
      var scriptNode = pageDoc.createElement('script');
      scriptNode.textContent = pageAsset.code;
      var parent = pageDoc.head || pageDoc.documentElement || pageDoc.body;
      parent.appendChild(scriptNode);
      if (scriptNode.parentNode) scriptNode.parentNode.removeChild(scriptNode);
      else if (scriptNode.remove) scriptNode.remove();
      return;
    }
    if (pageWin && typeof pageWin.eval === 'function') {
      pageWin.eval(pageAsset.code);
      return;
    }
    var runInPage = new Function(pageAsset.code);
    runInPage.call(pageWin);
  }

  function runPageScript(pageAsset) {
    stats.pageScripts.push(pageAsset.path);
    try {
      injectPageScript(pageAsset);
    } catch (error) {
      recordError('pageScript:' + pageAsset.path, error);
    }
  }

  for (var pageIndex = 0; pageIndex < PAGE_SCRIPTS.length; pageIndex += 1) {
    (function (asset) {
      if (!allowedByFrames(asset.allFrames)) return;
      if (!gatesAllow(asset.gates)) return;
      whenDocumentReady(asset.runAt, function () {
        runPageScript(asset);
      });
    })(PAGE_SCRIPTS[pageIndex]);
  }

  // -----------------------------------------------------------------------
  // 5. Report to the verification host (only present in the VM sandbox)
  // -----------------------------------------------------------------------
  if (HOST && typeof HOST.booted === 'function') {
    try {
      HOST.booted({
        version: VERSION,
        href: HREF,
        origin: ORIGIN,
        stats: stats,
        chrome: chromeShim,
        metadata: METADATA,
        audit: AUDIT
      });
    } catch (error) {
      recordError('host-report', error);
    }
  }
}

/**
 * Compiles a parsed Chrome MV3 extension bundle into a standalone userscript.
 */
export function compileUserscript(bundle, options = {}) {
  const header = buildUserscriptHeader(bundle, options);

  const background = bundle.background || null;
  const backgroundImports = (background && background.imports) || [];
  const backgroundSource = buildBackgroundSource(bundle);

  const isolatedContentScripts = (bundle.contentScripts || [])
    .filter(entry => entry.world !== 'MAIN')
    .map(entry => ({
      index: entry.index,
      gates: [entry.gate],
      runAt: entry.runAt,
      world: entry.world,
      allFrames: entry.allFrames,
      js: entry.js.map(asset => ({ path: asset.path, code: asset.code, sha256: asset.sha256 }))
    }));

  const pageScripts = (bundle.pageScripts || []).map(asset => ({
    path: asset.path,
    code: asset.code,
    sha256: asset.sha256,
    gates: asset.gates,
    runAt: asset.runAt,
    allFrames: asset.allFrames
  }));

  const cssAssets = (bundle.cssAssets || []).map(asset => ({
    path: asset.path,
    content: asset.content,
    sha256: asset.sha256,
    gates: asset.gates,
    runAt: asset.runAt,
    allFrames: asset.allFrames
  }));

  const payloads = {
    background: background ? background.code : '',
    backgroundSource,
    backgroundImports: backgroundImports.map(asset => ({
      path: asset.path,
      code: asset.code,
      declaredIn: asset.declaredIn,
      specifier: asset.specifier
    })),
    importNames: [...new Set(backgroundImports.map(asset => asset.specifier))],
    contentScripts: isolatedContentScripts,
    pageScripts,
    cssAssets
  };

  const contentScriptHashes = {};
  for (const entry of bundle.contentScripts || []) {
    for (const asset of entry.js) contentScriptHashes[asset.path] = asset.sha256;
    for (const asset of entry.css) {
      if (!Object.prototype.hasOwnProperty.call(contentScriptHashes, asset.path)) contentScriptHashes[asset.path] = asset.sha256;
    }
  }

  const auditMetadata = {
    generator: GENERATOR,
    sourceName: bundle.name,
    version: bundle.version,
    matches: bundle.matches,
    connectDomains: bundle.connectDomains,
    runAt: bundle.runAt,
    noframes: Boolean(bundle.noframes),
    usesStorage: Boolean(bundle.usesStorage),
    contentScripts: (bundle.contentScripts || []).map(entry => ({
      index: entry.index,
      matches: entry.matches,
      runAt: entry.runAt,
      world: entry.world,
      allFrames: entry.allFrames,
      js: entry.js.map(asset => asset.path),
      css: entry.css.map(asset => asset.path)
    })),
    background: background
      ? {
          path: background.path,
          imports: background.imports.map(asset => asset.path),
          hasDynamicImports: Boolean(background.hasDynamicImports)
        }
      : null,
    hashes: {
      background: background ? background.sha256 : null,
      backgroundSource: backgroundSource ? sha256(backgroundSource) : null,
      backgroundImports: Object.fromEntries(backgroundImports.map(asset => [asset.path, asset.sha256])),
      cssAssets: Object.fromEntries((bundle.cssAssets || []).map(asset => [asset.path, asset.sha256])),
      pageScripts: Object.fromEntries((bundle.pageScripts || []).map(asset => [asset.path, asset.sha256])),
      contentScripts: contentScriptHashes
    }
  };

  const metadataForRuntime = {
    generator: GENERATOR,
    version: bundle.version,
    name: bundle.name,
    matches: bundle.matches,
    runAt: bundle.runAt,
    noframes: Boolean(bundle.noframes),
    usesStorage: Boolean(bundle.usesStorage),
    storageNamespace: buildStorageNamespace(bundle)
  };

  const urlMap = buildUrlMap(bundle);

  const replacements = {
    VERSION: jsLiteral(bundle.version),
    METADATA: jsLiteral(jsLiteral(metadataForRuntime)),
    AUDIT: jsLiteral(jsLiteral(auditMetadata)),
    MANIFEST: jsLiteral(jsLiteral(bundle.manifest)),
    URL_MAP: jsLiteral(jsLiteral(urlMap)),
    PAYLOADS: jsLiteral(JSON.stringify(payloads))
  };

  const runtimeTemplate = crx2userRuntime.toString();
  const runtime = runtimeTemplate.replace(/"@@([A-Z0-9_]+)@@"/g, (match, token) => {
    if (!Object.prototype.hasOwnProperty.call(replacements, token)) {
      throw new Error(`Unknown userscript runtime placeholder: ${token}`);
    }
    return replacements[token];
  });

  const auditLine = `// __CRX2USER_AUDIT_JSON__: ${jsLiteral(auditMetadata)}`;
  const fullCode = `${header}\n\n${auditLine}\n\n(${runtime})();\n`;

  return {
    code: fullCode,
    sha256: sha256(fullCode),
    audit: auditMetadata,
    payloads
  };
}
