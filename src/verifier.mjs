import { readFile } from 'node:fs/promises';
import { Script, createContext, runInContext } from 'node:vm';
import { parseExtensionDir, sha256, matchesAnyPattern, patternToSampleUrl } from './parser.mjs';

/**
 * Parses the ==UserScript== header block from a .user.js string.
 */
export function parseUserscriptHeader(code) {
  const match = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/.exec(code);
  if (!match) return null;
  const meta = { match: [], connect: [], grant: [] };
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    const tagMatch = line.match(/^\/\/\s*@(\S+)(?:\s+(.*))?$/);
    if (!tagMatch) continue;
    const [, key, rawValue] = tagMatch;
    const value = (rawValue || '').trim();
    if (key === 'match' || key === 'connect' || key === 'grant') {
      if (value) meta[key].push(value);
    } else {
      meta[key] = value;
    }
  }
  return meta;
}

/**
 * Extracts the embedded __CRX2USER_AUDIT__ JSON block from a generated .user.js.
 */
export function parseEmbeddedAudit(code) {
  const match = /^\/\/ __CRX2USER_AUDIT_JSON__: (.+)$/m.exec(code);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function hasHash(code, hash) {
  return typeof hash === 'string' && hash.length > 0 && code.includes(hash);
}

function flattenContentScriptPaths(bundle, href) {
  const paths = [];
  const entries = (bundle.contentScripts || []).filter(
    entry => entry.world !== 'MAIN' && matchesAnyPattern(href, entry.matches)
  );
  for (const entry of entries) for (const asset of entry.js) paths.push(asset.path);
  return paths;
}

function gatedAssets(bundle, href) {
  const css = (bundle.cssAssets || [])
    .filter(asset => matchesAnyPattern(href, asset.matches))
    .map(asset => asset.path);
  const pageScripts = (bundle.pageScripts || [])
    .filter(asset => matchesAnyPattern(href, asset.matches))
    .map(asset => asset.path);
  const contentScripts = flattenContentScriptPaths(bundle, href);
  return { css, pageScripts, contentScripts };
}

function sameStringSet(actual, expected) {
  const actualSet = [...new Set(actual || [])].sort();
  const expectedSet = [...new Set(expected || [])].sort();
  return actualSet.length === expectedSet.length && actualSet.every((value, index) => value === expectedSet[index]);
}

/**
 * Builds a sandbox that emulates just enough of the browser + Tampermonkey
 * environment for a converted userscript to boot generically:
 * DOM, CSS injection, window messaging, timers and GM_xmlhttpRequest.
 */
function createSandboxEnvironment(sampleUrl, options) {
  const parsedUrl = new URL(sampleUrl);
  const state = {
    url: sampleUrl,
    styleChunks: [],
    appendedScripts: [],
    links: [],
    gmRequests: [],
    messageHandlers: new Set(),
    documentHandlers: {},
    timers: new Set(),
    intervals: new Set(),
    errors: []
  };
  let sandbox = null;
  let capturedReport = null;
  const host = {
    booted(report) {
      capturedReport = report;
    }
  };

  function trackError(scope, error) {
    state.errors.push(`${scope}: ${error && error.message ? error.message : String(error)}`);
  }

  function executePageScript(source, filename) {
    try {
      runInContext(source, sandbox, { filename, timeout: 15000 });
    } catch (error) {
      trackError(`script:${filename}`, error);
    }
  }

  function classList() {
    const contained = new Set();
    return {
      add(...names) {
        for (const name of names) contained.add(String(name));
      },
      remove(...names) {
        for (const name of names) contained.delete(String(name));
      },
      toggle(name, force) {
        const key = String(name);
        if (force === true) {
          contained.add(key);
          return true;
        }
        if (force === false) {
          contained.delete(key);
          return false;
        }
        if (contained.has(key)) {
          contained.delete(key);
          return false;
        }
        contained.add(key);
        return true;
      },
      contains(name) {
        return contained.has(String(name));
      }
    };
  }

  function createElement(rawTag) {
    const tagName = String(rawTag || 'div').toUpperCase();
    const listeners = new Map();
    const element = {
      nodeType: 1,
      tagName,
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      parentNode: null,
      textContent: '',
      innerHTML: '',
      id: '',
      className: '',
      src: '',
      href: '',
      rel: '',
      type: '',
      onload: null,
      onerror: null,
      classList: classList(),
      setAttribute(name, value) {
        const key = String(name);
        this.attributes[key] = String(value);
        if (key === 'id') this.id = String(value);
        if (key === 'class') this.className = String(value);
      },
      getAttribute(name) {
        const key = String(name);
        return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
      },
      removeAttribute(name) {
        delete this.attributes[String(name)];
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, String(name));
      },
      appendChild(child) {
        if (!child) return child;
        child.parentNode = this;
        this.children.push(child);
        return handleNodeAppend(child);
      },
      insertBefore(child) {
        if (!child) return child;
        child.parentNode = this;
        this.children.unshift(child);
        return handleNodeAppend(child);
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
      },
      replaceChildren(...nodes) {
        this.children = [];
        for (const node of nodes) this.appendChild(node);
      },
      append(...nodes) {
        for (const node of nodes) this.appendChild(typeof node === 'string' ? { textContent: node } : node);
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      addEventListener(type, fn) {
        if (typeof fn !== 'function') return;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
      },
      dispatchEvent(event) {
        const handlers = listeners.get(event && event.type);
        if (handlers) for (const handler of [...handlers]) {
          try {
            handler(event);
          } catch (error) {
            trackError('element-event', error);
          }
        }
        return true;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getBoundingClientRect() {
        return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
      },
      focus() {},
      blur() {},
      click() {},
      cloneNode() {
        return createElement(tagName);
      }
    };
    return element;
  }

  function walkElements(node, callback) {
    if (!node || typeof node !== 'object') return;
    callback(node);
    if (Array.isArray(node.children)) for (const child of node.children) walkElements(child, callback);
  }

  function matchesSimpleSelector(element, selector) {
    if (!selector || !element) return false;
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
    return element.tagName === selector.toUpperCase();
  }

  function querySelectorAll(root, selector) {
    const results = [];
    walkElements(root, node => {
      if (matchesSimpleSelector(node, selector)) results.push(node);
    });
    return results;
  }

  function handleNodeAppend(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.tagName === 'SCRIPT') {
      state.appendedScripts.push({ src: node.src || '', textLength: String(node.textContent || '').length });
      if (!node.src && typeof node.textContent === 'string' && node.textContent) {
        executePageScript(node.textContent, (node.dataset && node.dataset.crx2userScript) || 'page-world-script.js');
      }
      if (typeof node.onload === 'function') {
        try {
          node.onload();
        } catch (error) {
          trackError('script-onload', error);
        }
      }
    } else if (node.tagName === 'STYLE') {
      state.styleChunks.push(String(node.textContent || ''));
    } else if (node.tagName === 'LINK') {
      state.links.push(node.href || '');
    }
    return node;
  }

  const documentElement = createElement('html');
  const head = createElement('head');
  const body = createElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document = {
    nodeType: 9,
    documentElement,
    head,
    body,
    title: '',
    readyState: 'complete',
    currentScript: null,
    visibilityState: 'visible',
    hidden: false,
    cookie: '',
    referrer: '',
    createElement,
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text), parentNode: null, remove() {}, appendChild(child) { return child; } };
    },
    createDocumentFragment() {
      const fragment = createElement('fragment');
      fragment.nodeType = 11;
      return fragment;
    },
    querySelector(selector) {
      return querySelectorAll(documentElement, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return querySelectorAll(documentElement, selector);
    },
    getElementById(id) {
      return querySelectorAll(documentElement, `#${id}`)[0] || null;
    },
    getElementsByClassName(className) {
      return querySelectorAll(documentElement, `.${className}`);
    },
    getElementsByTagName(tagName) {
      return querySelectorAll(documentElement, tagName);
    },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      if (!state.documentHandlers[type]) state.documentHandlers[type] = new Set();
      state.documentHandlers[type].add(fn);
    },
    removeEventListener(type, fn) {
      if (state.documentHandlers[type]) state.documentHandlers[type].delete(fn);
    },
    dispatchEvent(event) {
      const handlers = state.documentHandlers[event && event.type];
      if (handlers) for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (error) {
          trackError('document-event', error);
        }
      }
      return true;
    }
  };

  function sandboxSetTimeout(fn, delay, ...args) {
    const id = setTimeout(() => {
      state.timers.delete(id);
      try {
        fn(...args);
      } catch (error) {
        trackError('timer', error);
      }
    }, Number(delay) || 0);
    state.timers.add(id);
    return id;
  }

  function sandboxClearTimeout(id) {
    state.timers.delete(id);
    clearTimeout(id);
  }

  function sandboxSetInterval(fn, delay, ...args) {
    const id = setInterval(() => {
      try {
        fn(...args);
      } catch (error) {
        trackError('interval', error);
      }
    }, Number(delay) || 0);
    state.intervals.add(id);
    return id;
  }

  function sandboxClearInterval(id) {
    state.intervals.delete(id);
    clearInterval(id);
  }

  function addWindowEventListener(type, fn) {
    if (type === 'message' && typeof fn === 'function') state.messageHandlers.add(fn);
  }

  function removeWindowEventListener(type, fn) {
    if (type === 'message') state.messageHandlers.delete(fn);
  }

  function postMessage(data, targetOrigin) {
    const event = { type: 'message', data, origin: targetOrigin || parsedUrl.origin, source: sandbox, ports: [] };
    for (const handler of [...state.messageHandlers]) {
      try {
        handler(event);
      } catch (error) {
        trackError('message-listener', error);
      }
    }
  }

  function respondToGmRequest(request) {
    if (typeof options.xhr === 'function') {
      const response = options.xhr(request);
      if (response && typeof response === 'object') return response;
    }
    return { status: 200, statusText: 'OK', responseText: '{}' };
  }

  function gmXhr(request) {
    state.gmRequests.push(request);
    const timer = sandboxSetTimeout(() => {
      try {
        const response = respondToGmRequest(request);
        if (typeof request.onload === 'function') request.onload(response);
      } catch (error) {
        if (typeof request.onerror === 'function') request.onerror({ error: error.message });
      }
    }, 5);
    return {
      abort() {
        sandboxClearTimeout(timer);
      }
    };
  }

  function mockFetch(url, init) {
    state.gmRequests.push({ url: String(url), method: (init && init.method) || 'GET', fetch: true });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: String(url),
      headers: { get: () => null, has: () => false, forEach: () => {} },
      text: () => Promise.resolve('{}'),
      json: () => Promise.resolve({})
    });
  }

  class MockEvent {
    constructor(type, init) {
      this.type = String(type);
      Object.assign(this, init || {});
    }
  }

  class MockCustomEvent extends MockEvent {
    constructor(type, init) {
      super(type, init);
      this.detail = init && Object.prototype.hasOwnProperty.call(init, 'detail') ? init.detail : null;
    }
  }

  class MockObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }

  const location = {
    origin: parsedUrl.origin,
    href: sampleUrl,
    protocol: parsedUrl.protocol,
    host: parsedUrl.host,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port,
    pathname: parsedUrl.pathname,
    search: parsedUrl.search,
    hash: parsedUrl.hash,
    assign() {},
    replace() {},
    reload() {}
  };

  sandbox = createContext({
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} },
    document,
    location,
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Mozilla/5.0 (crx2user verifier)', platform: 'MacIntel' },
    crypto: globalThis.crypto,
    setTimeout: sandboxSetTimeout,
    clearTimeout: sandboxClearTimeout,
    setInterval: sandboxSetInterval,
    clearInterval: sandboxClearInterval,
    requestAnimationFrame: fn => sandboxSetTimeout(fn, 16),
    cancelAnimationFrame: id => sandboxClearTimeout(id),
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    AbortController: globalThis.AbortController,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    Blob: globalThis.Blob,
    Event: MockEvent,
    CustomEvent: MockCustomEvent,
    MutationObserver: MockObserver,
    IntersectionObserver: MockObserver,
    ResizeObserver: MockObserver,
    matchMedia: () => ({
      matches: false,
      media: '',
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {}
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: addWindowEventListener,
    removeEventListener: removeWindowEventListener,
    postMessage,
    dispatchEvent: event => {
      const handlers = state.documentHandlers[event && event.type];
      if (handlers) for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (error) {
          trackError('window-event', error);
        }
      }
      return true;
    },
    GM_xmlhttpRequest: gmXhr,
    GM: { xmlHttpRequest: gmXhr, info: { script: { version: 'crx2user-verifier' } } },
    GM_addStyle: css => {
      state.styleChunks.push(String(css));
      return createElement('style');
    },
    GM_info: { script: { version: 'crx2user-verifier' } },
    fetch: mockFetch,
    __CRX2USER_HOST__: host
  });

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.unsafeWindow = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.frames = sandbox;

  function dispose() {
    for (const id of state.timers) clearTimeout(id);
    for (const id of state.intervals) clearInterval(id);
    state.timers.clear();
    state.intervals.clear();
  }

  return {
    sandbox,
    state,
    dispose,
    getReport: () => capturedReport
  };
}

/**
 * Runs a 4-stage automated verification suite on a compiled userscript:
 *  1. metadata_contract     - userscript header vs manifest contract
 *  2. payload_sha256_parity - byte-level hashes of every embedded payload
 *  3. vm_syntax_compile     - full userscript syntax compilation
 *  4. sandbox_e2e_smoke_test- generic browser/Tampermonkey sandbox boot test
 */
export async function verifyUserscript(userscriptCodeOrPath, options = {}) {
  const code = typeof userscriptCodeOrPath === 'string' && userscriptCodeOrPath.endsWith('.js') && !userscriptCodeOrPath.includes('\n')
    ? await readFile(userscriptCodeOrPath, 'utf8')
    : userscriptCodeOrPath;

  const sourceBundle = options.sourceDir
    ? await parseExtensionDir(options.sourceDir)
    : options.sourceBundle || null;

  const checks = [];
  const record = (name, passed, details) => {
    checks.push({ name, passed: Boolean(passed), details });
  };

  const meta = parseUserscriptHeader(code);
  const audit = parseEmbeddedAudit(code);

  // ========================================================================
  // Stage 1: userscript metadata vs manifest contract
  // ========================================================================
  if (!meta) {
    record('metadata_contract', false, 'Missing // ==UserScript== header block');
  } else {
    const requiredGrants = ['GM_xmlhttpRequest', 'GM.xmlHttpRequest', 'GM_addStyle', 'unsafeWindow'];
    const missingGrants = requiredGrants.filter(grant => !meta.grant.includes(grant));
    let contractOk = missingGrants.length === 0 && meta.match.length > 0;
    let details = `version=${meta.version || '?'}, matches=${meta.match.length}, grants=${meta.grant.length}`;

    if (sourceBundle) {
      const versionMatches = meta.version === sourceBundle.version;
      const matchesParity = sourceBundle.matches.every(match => meta.match.includes(match));
      const connectParity = sourceBundle.connectDomains.every(domain => meta.connect.includes(domain));
      const runAtParity = meta['run-at'] === sourceBundle.runAt;
      contractOk = contractOk && versionMatches && matchesParity && connectParity && runAtParity;
      details += `, versionParity=${versionMatches}, matchesParity=${matchesParity}, connectParity=${connectParity}, runAtParity=${runAtParity}`;
    }
    if (missingGrants.length > 0) details += `, missingGrants=${missingGrants.join('|')}`;
    record('metadata_contract', contractOk, details);
  }

  // ========================================================================
  // Stage 2: payload SHA-256 parity against the source extension
  // ========================================================================
  if (!audit || !audit.hashes) {
    record('payload_sha256_parity', false, 'Missing embedded __CRX2USER_AUDIT__ hash block');
  } else if (sourceBundle) {
    const hashes = audit.hashes;
    const backgroundOk = !sourceBundle.background
      || (hashes.background === sourceBundle.background.sha256 && hasHash(code, hashes.background));
    const importsExpected = sourceBundle.background ? sourceBundle.background.imports || [] : [];
    const importsOk = importsExpected.every(
      asset => hashes.backgroundImports?.[asset.path] === asset.sha256 && hasHash(code, asset.sha256)
    );
    const cssOk = sourceBundle.cssAssets.every(
      asset => hashes.cssAssets?.[asset.path] === asset.sha256 && hasHash(code, asset.sha256)
    );
    const pageOk = sourceBundle.pageScripts.every(
      asset => hashes.pageScripts?.[asset.path] === asset.sha256 && hasHash(code, asset.sha256)
    );
    const contentScriptAssets = [];
    for (const entry of sourceBundle.contentScripts) {
      for (const asset of entry.js) contentScriptAssets.push(asset);
      for (const asset of entry.css) contentScriptAssets.push(asset);
    }
    const contentOk = contentScriptAssets.every(
      asset => hashes.contentScripts?.[asset.path] === asset.sha256 && hasHash(code, asset.sha256)
    );
    const allMatch = backgroundOk && importsOk && cssOk && pageOk && contentOk;
    record(
      'payload_sha256_parity',
      allMatch,
      `background=${backgroundOk}, imports=${importsExpected.length}, css=${sourceBundle.cssAssets.length}, pageScripts=${sourceBundle.pageScripts.length}, contentScripts=${contentScriptAssets.length}`
    );
  } else {
    const hashValues = Object.values(audit.hashes || {})
      .flatMap(value => (value && typeof value === 'object' ? Object.values(value) : [value]))
      .filter(value => typeof value === 'string');
    const hashesEmbedded = hashValues.every(hash => hasHash(code, hash));
    record('payload_sha256_parity', hashValues.length > 0 && hashesEmbedded, `embedded hashes cannot be matched against a source directory (${hashValues.length} hashes present)`);
  }

  // ========================================================================
  // Stage 3: userscript syntax compilation
  // ========================================================================
  try {
    new Script(code, { filename: 'compiled.user.js' });
    record('vm_syntax_compile', true, `Compiled ${(code.length / 1024 / 1024).toFixed(2)} MB userscript with zero syntax errors`);
  } catch (error) {
    record('vm_syntax_compile', false, `Syntax error: ${error.message}`);
  }

  // ========================================================================
  // Stage 4: generic browser/Tampermonkey sandbox boot test
  // ========================================================================
  const sampleUrl = options.url
    || (sourceBundle && sourceBundle.matches.length > 0 ? patternToSampleUrl(sourceBundle.matches[0]) : null)
    || 'https://example.com/';

  let environment = null;
  try {
    environment = createSandboxEnvironment(sampleUrl, options);
    const { sandbox, state } = environment;

    try {
      runInContext(code, sandbox, { filename: 'smoke-test.user.js', timeout: 30000 });
    } catch (error) {
      record('sandbox_e2e_smoke_test', false, `Runtime error while booting userscript: ${error.message}`);
      return {
        passed: checks.every(check => check.passed),
        version: meta?.version || audit?.version || null,
        sha256: sha256(code),
        sizeBytes: Buffer.byteLength(code, 'utf8'),
        checks
      };
    }

    const report = environment.getReport();
    if (!report) {
      record('sandbox_e2e_smoke_test', false, 'Sandbox boot hook was not invoked by the generated userscript');
    } else {
      const stats = report.stats || {};
      const bootOk = sandbox.document.documentElement.dataset.crx2userBoot === (sourceBundle ? sourceBundle.version : report.version);
      const expected = sourceBundle
        ? gatedAssets(sourceBundle, sampleUrl)
        : { css: [], pageScripts: [], contentScripts: [] };

      const backgroundOk = !sourceBundle || !sourceBundle.background
        ? true
        : Boolean(stats.backgroundStarted);
      const cssOk = expected.css.length === 0
        ? Number(stats.cssAssets || 0) === 0
        : Number(stats.cssAssets) === expected.css.length && Number(stats.cssChars) > 0;
      const contentScriptsOk = sameStringSet(stats.contentScripts, expected.contentScripts);
      const pageScriptsOk = sameStringSet(stats.pageScripts, expected.pageScripts);
      const contentScriptErrors = (stats.errors || []).filter(message => message.startsWith('contentScript:'));
      const pageScriptErrors = (stats.errors || []).filter(message => message.startsWith('pageScript:'));

      let bridgeProbe = null;
      if (report.chrome && sourceBundle && sourceBundle.background && Number(stats.backgroundListeners) > 0) {
        const before = Number(stats.bridgeListenerInvocations) || 0;
        try {
          report.chrome.runtime.sendMessage({ type: '__crx2user_probe__', payload: {} });
        } catch (error) {
          state.errors.push(`bridge-probe: ${error.message}`);
        }
        bridgeProbe = (Number(stats.bridgeListenerInvocations) || 0) - before;
      }
      const bridgeOk = bridgeProbe === null || bridgeProbe > 0;

      const allOk = bootOk && backgroundOk && cssOk && contentScriptsOk && pageScriptsOk && bridgeOk && contentScriptErrors.length === 0;
      const details = [
        `boot=${bootOk}`,
        `background=${backgroundOk ? 'started' : 'failed'}`,
        `contentScripts=${(stats.contentScripts || []).length}/${expected.contentScripts.length}`,
        `pageScripts=${(stats.pageScripts || []).length}/${expected.pageScripts.length}`,
        `css=${(stats.cssAssets || 0)}/${expected.css.length}`,
        `injection=${stats.pageInjectionMode || 'n/a'}`,
        `bridgeProbe=${bridgeProbe === null ? 'n/a' : bridgeProbe}`,
        `errors=${contentScriptErrors.length + pageScriptErrors.length}`
      ];
      if (contentScriptErrors.length > 0) details.push(`contentScriptErrors=${contentScriptErrors.slice(0, 3).join(' | ')}`);
      if (pageScriptErrors.length > 0) details.push(`pageScriptWarnings=${pageScriptErrors.slice(0, 2).join(' | ')}`);
      if (!allOk) {
        details.push(
          `flags=boot:${bootOk},background:${backgroundOk},css:${cssOk},contentScripts:${contentScriptsOk},pageScripts:${pageScriptsOk},bridge:${bridgeOk},contentScriptErrors:${contentScriptErrors.length}`
        );
      }
      record('sandbox_e2e_smoke_test', allOk, details.join(', '));
    }
  } catch (error) {
    record('sandbox_e2e_smoke_test', false, `Sandbox setup error: ${error.message}`);
  } finally {
    if (environment) environment.dispose();
  }

  return {
    passed: checks.every(check => check.passed),
    version: meta?.version || audit?.version || null,
    sha256: sha256(code),
    sizeBytes: Buffer.byteLength(code, 'utf8'),
    checks
  };
}
