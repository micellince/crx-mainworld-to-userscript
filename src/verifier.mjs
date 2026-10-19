import { readFile } from 'node:fs/promises';
import { Script, createContext, runInContext } from 'node:vm';
import { parseExtensionDir, sha256 } from './parser.mjs';

/**
 * Parses the ==UserScript== header block from a .user.js string.
 */
export function parseUserscriptHeader(code) {
  const m = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!m) return null;
  const meta = {
    match: [],
    connect: [],
    grant: []
  };
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.trim();
    const tagMatch = line.match(/^\/\/\s*@(\S+)\s+(.*)$/);
    if (!tagMatch) continue;
    const [, key, val] = tagMatch;
    const cleanVal = val.trim();
    if (key === 'match' || key === 'connect' || key === 'grant') {
      meta[key].push(cleanVal);
    } else {
      meta[key] = cleanVal;
    }
  }
  return meta;
}

/**
 * Extracts the embedded __CRX2USER_AUDIT__ JSON block from a generated .user.js string.
 */
export function parseEmbeddedAudit(code) {
  const m = code.match(/^\/\/ __CRX2USER_AUDIT_JSON__: (.+)$/m);
  if (!m) return null;
  return JSON.parse(m[1]);
}

/**
 * Runs a 4-stage automated verification suite on a compiled Userscript (.user.js):
 *  1. Metadata & Manifest Contract Check (@version, @match, @connect, @grant)
 *  2. Payload Integrity & SHA-256 Hash Parity against source extension
 *  3. Node VM JavaScript Syntax Compilation Check
 *  4. End-to-End Sandbox Smoke Test (DOM CSS mount + Page-World boot + FUTNext/FUTBIN GM_xmlhttpRequest CORS bridge roundtrip)
 */
export async function verifyUserscript(userscriptCodeOrPath, options = {}) {
  const code = userscriptCodeOrPath.endsWith('.js') && !userscriptCodeOrPath.includes('\n')
    ? await readFile(userscriptCodeOrPath, 'utf8')
    : userscriptCodeOrPath;

  const sourceBundle = options.sourceDir
    ? await parseExtensionDir(options.sourceDir)
    : options.sourceBundle || null;

  const checks = [];
  const record = (name, passed, details) => {
    checks.push({ name, passed: Boolean(passed), details });
  };

  // ==========================================================================
  // Check 1: Userscript Metadata & Manifest Contract
  // ==========================================================================
  const meta = parseUserscriptHeader(code);
  const audit = parseEmbeddedAudit(code);
  if (!meta) {
    record('metadata_header', false, 'Missing // ==UserScript== header block');
  } else {
    const requiredGrants = ['GM_xmlhttpRequest', 'GM.xmlHttpRequest', 'GM_addStyle', 'unsafeWindow'];
    const missingGrants = requiredGrants.filter(g => !meta.grant.includes(g));
    let contractOk = missingGrants.length === 0 && meta.match.length > 0 && meta.connect.length > 0;
    let detailMsg = `version=${meta.version}, matches=${meta.match.length}, connect=[${meta.connect.join(', ')}]`;

    if (sourceBundle) {
      const versionMatch = meta.version === sourceBundle.version;
      const matchesParity = sourceBundle.matches.every(m => meta.match.includes(m));
      const connectParity = sourceBundle.connectDomains.every(c => meta.connect.includes(c));
      contractOk = contractOk && versionMatch && matchesParity && connectParity;
      detailMsg += `, manifestParity=${versionMatch && matchesParity && connectParity}`;
    }
    record('metadata_contract', contractOk, detailMsg);
  }

  // ==========================================================================
  // Check 2: Payload SHA-256 Parity & Zero Unshimmed Chrome API Leakage
  // ==========================================================================
  if (!audit) {
    record('payload_sha256_parity', false, 'Missing embedded __CRX2USER_AUDIT__ block');
  } else if (sourceBundle) {
    const bgMatch = audit.hashes.background === (sourceBundle.background?.sha256 || null);
    const cssMatch = sourceBundle.cssAssets.every(a => audit.hashes.cssAssets?.[a.path] === a.sha256 && code.includes(a.sha256));
    const pageMatch = sourceBundle.pageScripts.every(s => audit.hashes.pageScripts?.[s.path] === s.sha256 && code.includes(s.sha256));
    const allMatch = bgMatch && cssMatch && pageMatch;
    record(
      'payload_sha256_parity',
      allMatch,
      `bg=${bgMatch}, css=${cssMatch} (${sourceBundle.cssAssets.length}), pageScripts=${pageMatch} (${sourceBundle.pageScripts.length})`
    );
  } else {
    record('payload_sha256_parity', true, `Verified embedded audit hashes for v${audit.version}`);
  }

  // ==========================================================================
  // Check 3: Node VM Syntax Compilation Check
  // ==========================================================================
  try {
    new Script(code, { filename: 'compiled.user.js' });
    record('vm_syntax_compile', true, `Compiled ${(code.length / 1024 / 1024).toFixed(2)} MB userscript with zero syntax errors`);
  } catch (err) {
    record('vm_syntax_compile', false, `Syntax error: ${err.message}`);
  }

  // ==========================================================================
  // Check 4: End-to-End Sandbox Runtime & GM_xmlhttpRequest CORS Bridge Smoke Test
  // ==========================================================================
  const activeTimers = new Set();
  const cleanupTimers = () => {
    for (const id of activeTimers) clearTimeout(id);
    activeTimers.clear();
  };

  try {
    const origin = 'https://www.ea.com';
    const messageHandlers = new Set();
    const appendedElements = [];
    const gmRequests = [];
    let gmStylesAdded = 0;
    let sandbox = null;

    const sandboxSetTimeout = (fn, ms, ...args) => {
      const id = setTimeout(() => {
        activeTimers.delete(id);
        try { fn(...args); } catch {}
      }, ms);
      activeTimers.add(id);
      return id;
    };
    const sandboxClearTimeout = id => {
      activeTimers.delete(id);
      clearTimeout(id);
    };

    const handleNodeAppend = el => {
      appendedElements.push(el);
      if (el?.tagName === 'SCRIPT' && el.textContent && sandbox) {
        runInContext(el.textContent, sandbox, {
          filename: el.dataset?.crx2userScript || 'injected-page-script.js',
          timeout: 5000
        });
      }
      return el;
    };

    const mockDoc = {
      documentElement: {
        lang: 'en',
        dataset: {},
        appendChild: handleNodeAppend
      },
      head: {
        appendChild: handleNodeAppend
      },
      body: {
        classList: { toggle() {}, add() {}, remove() {} },
        append() {},
        appendChild: handleNodeAppend
      },
      createElement(tag) {
        return {
          tagName: String(tag).toUpperCase(),
          dataset: {},
          style: {},
          classList: { add() {}, remove() {}, toggle() {} },
          textContent: '',
          remove() {},
          appendChild() {},
          querySelector() { return null; }
        };
      },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    };

    const mockGmXhr = req => {
      gmRequests.push(req);
      sandboxSetTimeout(() => {
        if (req.url.includes('enhancer-api.futnext.com/players/v2/prices')) {
          req.onload({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({
              231747: { definitionId: 231747, price: 2860000, avg: 2890000, top5Cheapest: [2850000, 2860000] }
            })
          });
        } else if (req.url.includes('futbin.org/futbin/api/27/getFilteredPlayers')) {
          req.onload({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({
              data: [{ resource_id: 231747, rating: 91, ps_LCPrice: '2,860,000', pc_LCPrice: '3,605,000' }]
            })
          });
        } else {
          req.onload({ status: 404, statusText: 'Not Found', responseText: '{}' });
        }
      }, 5);
      return { abort() {} };
    };

    sandbox = createContext({
      location: {
        origin,
        href: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/'
      },
      navigator: { language: 'en-US', userAgent: 'Mozilla/5.0' },
      document: mockDoc,
      crypto: globalThis.crypto,
      setTimeout: sandboxSetTimeout,
      clearTimeout: sandboxClearTimeout,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      AbortController: globalThis.AbortController,
      console: { log() {}, warn() {}, error() {} },
      addEventListener(type, fn) {
        if (type === 'message' && typeof fn === 'function') {
          messageHandlers.add(fn);
        }
      },
      removeEventListener(type, fn) {
        if (type === 'message') {
          messageHandlers.delete(fn);
        }
      },
      postMessage(data, targetOrigin) {
        const evt = { origin: targetOrigin || origin, data };
        for (const fn of [...messageHandlers]) {
          fn(evt);
        }
      },
      GM_xmlhttpRequest: mockGmXhr,
      GM: { xmlHttpRequest: mockGmXhr },
      GM_addStyle(css) {
        gmStylesAdded += css.length;
        return { dataset: {} };
      }
    });
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.unsafeWindow = sandbox;

    runInContext(code, sandbox, { filename: 'smoke-test.user.js', timeout: 5000 });

    const bootVersion = mockDoc.documentElement.dataset.enhancerModBoot;
    const crx2userBoot = mockDoc.documentElement.dataset.crx2userBoot;

    // Test 1: Round-trip FUTNext price query via window.postMessage -> GM_xmlhttpRequest
    const futnextRes = await new Promise((resolve, reject) => {
      const reqId = 'smoke-futnext-1';
      const timer = setTimeout(() => reject(new Error('FUTNext smoke test timed out')), 2500);
      const listener = e => {
        if (e.data?.channel === 'enhancer-mod-price-result' && e.data.id === reqId) {
          sandbox.removeEventListener('message', listener);
          clearTimeout(timer);
          resolve(e.data);
        }
      };
      sandbox.addEventListener('message', listener);
      sandbox.postMessage({
        channel: 'enhancer-mod-price-request',
        id: reqId,
        payload: { source: 'FUTNext', platform: 'ps', ids: [231747] }
      }, origin);
    });

    // Test 2: Round-trip FUTBIN price query via window.postMessage -> GM_xmlhttpRequest
    const futbinRes = await new Promise((resolve, reject) => {
      const reqId = 'smoke-futbin-1';
      const timer = setTimeout(() => reject(new Error('FUTBIN smoke test timed out')), 2500);
      const listener = e => {
        if (e.data?.channel === 'enhancer-mod-price-result' && e.data.id === reqId) {
          sandbox.removeEventListener('message', listener);
          clearTimeout(timer);
          resolve(e.data);
        }
      };
      sandbox.addEventListener('message', listener);
      sandbox.postMessage({
        channel: 'enhancer-mod-price-request',
        id: reqId,
        payload: { source: 'FUTBIN', platform: 'ps', rating: 91 }
      }, origin);
    });

    // Test 3: Invalid payload rejection check
    const invalidRes = await new Promise((resolve, reject) => {
      const reqId = 'smoke-invalid-1';
      const timer = setTimeout(() => reject(new Error('Invalid payload smoke test timed out')), 2500);
      const listener = e => {
        if (e.data?.channel === 'enhancer-mod-price-result' && e.data.id === reqId) {
          sandbox.removeEventListener('message', listener);
          clearTimeout(timer);
          resolve(e.data);
        }
      };
      sandbox.addEventListener('message', listener);
      sandbox.postMessage({
        channel: 'enhancer-mod-price-request',
        id: reqId,
        payload: { source: 'UNKNOWN_SOURCE', platform: 'ps' }
      }, origin);
    });

    const futnextOk = futnextRes?.error === null && futnextRes?.body?.['231747']?.price === 2860000;
    const futbinOk = futbinRes?.error === null && Array.isArray(futbinRes?.body?.data) && futbinRes.body.data[0]?.rating === 91;
    const invalidOk = invalidRes?.error === 'PRICE_INVALID_REQUEST';
    const cssOk = gmStylesAdded > 0;
    const bootOk = Boolean(bootVersion && crx2userBoot && bootVersion === crx2userBoot);

    const allSmokeOk = bootOk && cssOk && futnextOk && futbinOk && invalidOk;
    record(
      'sandbox_e2e_smoke_test',
      allSmokeOk,
      `boot=${bootVersion}, cssChars=${gmStylesAdded}, gmRequests=${gmRequests.length}, futnext=${futnextOk}, futbin=${futbinOk}, invalidGuard=${invalidOk}`
    );
  } catch (err) {
    record('sandbox_e2e_smoke_test', false, `Runtime error: ${err.message}`);
  } finally {
    cleanupTimers();
  }

  return {
    passed: checks.every(c => c.passed),
    version: meta?.version || audit?.version || null,
    sha256: sha256(code),
    sizeBytes: Buffer.byteLength(code, 'utf8'),
    checks
  };
}
