import { sha256 } from './parser.mjs';

/**
 * Generates the ==UserScript== metadata block from parsed extension metadata.
 */
export function buildUserscriptHeader(bundle, options = {}) {
  const lines = [
    '// ==UserScript==',
    `// @name         ${options.name || bundle.name}`,
    `// @namespace    ${options.namespace || bundle.homepageUrl || 'https://futmarket.app'}`,
    `// @version      ${bundle.version}`,
    `// @description  ${bundle.description}`,
    `// @author       ${options.author || bundle.shortName || 'futmarket.app'}`
  ];

  if (bundle.homepageUrl) {
    lines.push(`// @homepageURL  ${bundle.homepageUrl}`);
    lines.push(`// @supportURL   ${bundle.homepageUrl}`);
  }
  if (options.updateUrl) {
    lines.push(`// @updateURL    ${options.updateUrl}`);
  }
  if (options.downloadUrl) {
    lines.push(`// @downloadURL  ${options.downloadUrl}`);
  }
  for (const m of bundle.matches) {
    lines.push(`// @match        ${m}`);
  }
  for (const domain of bundle.connectDomains) {
    lines.push(`// @connect      ${domain}`);
  }
  lines.push(`// @run-at       ${bundle.runAt || 'document-idle'}`);
  lines.push('// @grant        GM_xmlhttpRequest');
  lines.push('// @grant        GM.xmlHttpRequest');
  lines.push('// @grant        GM_addStyle');
  lines.push('// @grant        unsafeWindow');
  if (bundle.iconDataUri && options.includeIcon !== false) {
    lines.push(`// @icon         ${bundle.iconDataUri}`);
  }
  lines.push('// ==/UserScript==');
  return lines.join('\n');
}

/**
 * Compiles a parsed Chrome MV3 extension bundle into a standalone Userscript (.user.js).
 */
export function compileUserscript(bundle, options = {}) {
  const header = buildUserscriptHeader(bundle, options);

  const auditMetadata = {
    generator: 'crx-mainworld-to-userscript@1.0.0',
    sourceName: bundle.name,
    version: bundle.version,
    matches: bundle.matches,
    connectDomains: bundle.connectDomains,
    hashes: {
      background: bundle.background?.sha256 || null,
      cssAssets: Object.fromEntries(bundle.cssAssets.map(a => [a.path, a.sha256])),
      pageScripts: Object.fromEntries(bundle.pageScripts.map(s => [s.path, s.sha256]))
    }
  };

  const cssEntriesJson = JSON.stringify(
    bundle.cssAssets.map(a => ({ path: a.path, sha256: a.sha256, content: a.content }))
  );
  const backgroundCodeJson = JSON.stringify(bundle.background?.content || '');
  const pageScriptsJson = JSON.stringify(
    bundle.pageScripts.map(s => ({ path: s.path, sha256: s.sha256, content: s.content }))
  );

  const body = `// __CRX2USER_AUDIT_JSON__: ${JSON.stringify(auditMetadata)}

(function () {
  'use strict';

  const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const pageDoc = pageWin.document || document;

  if (pageDoc.documentElement && pageDoc.documentElement.dataset.crx2userBoot === ${JSON.stringify(bundle.version)}) {
    return;
  }
  if (pageDoc.documentElement) {
    pageDoc.documentElement.dataset.crx2userBoot = ${JSON.stringify(bundle.version)};
  }

  // ==========================================================================
  // 1. In-Sandbox Chrome Runtime & GM_xmlhttpRequest CORS Fetch Shim
  // ==========================================================================
  const messageListeners = [];

  function resolveGmXhr() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && typeof GM?.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
    if (typeof pageWin.GM_xmlhttpRequest === 'function') return pageWin.GM_xmlhttpRequest;
    return null;
  }

  function gmFetch(url, init = {}) {
    const gmXhr = resolveGmXhr();
    if (!gmXhr) {
      return fetch(url, init);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const signal = init?.signal;
      if (signal?.aborted) {
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        reject(abortErr);
        return;
      }

      let reqHandle = null;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        try { reqHandle?.abort?.(); } catch {}
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        reject(abortErr);
      };
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      reqHandle = gmXhr({
        method: (init?.method || 'GET').toUpperCase(),
        url: String(url),
        headers: init?.headers || { Accept: 'application/json' },
        data: init?.body,
        timeout: 10000,
        onload(res) {
          if (settled) return;
          settled = true;
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
          const status = Number(res.status || 200);
          const responseText = typeof res.responseText === 'string' ? res.responseText : '';
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusText || '',
            text: async () => responseText,
            json: async () => JSON.parse(responseText)
          });
        },
        onerror(err) {
          if (settled) return;
          settled = true;
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
          reject(new Error(err?.error || 'PRICE_NETWORK_ERROR'));
        },
        ontimeout() {
          if (settled) return;
          settled = true;
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
          const timeoutErr = new Error('PRICE_TIMEOUT');
          timeoutErr.name = 'AbortError';
          reject(timeoutErr);
        }
      });
    });
  }

  const chromeShim = {
    runtime: {
      id: 'userscript-gm-bridge-' + ${JSON.stringify(bundle.version)},
      lastError: null,
      getURL: path => path,
      onMessage: {
        addListener(fn) {
          if (typeof fn === 'function') messageListeners.push(fn);
        }
      },
      sendMessage(message, callback) {
        let responded = false;
        const sendResponse = res => {
          if (responded) return;
          responded = true;
          if (typeof callback === 'function') callback(res);
        };
        for (const listener of messageListeners) {
          try {
            listener(message, { id: 'userscript-content' }, sendResponse);
          } catch (err) {
            chromeShim.runtime.lastError = { message: err?.message || String(err) };
            sendResponse({ body: null, error: err?.message || 'PRICE_NETWORK_ERROR' });
            chromeShim.runtime.lastError = null;
          }
        }
      }
    }
  };

  // ==========================================================================
  // 2. Boot Extension Background Worker inside GM Sandbox
  // ==========================================================================
  const BACKGROUND_CODE = ${backgroundCodeJson};
  if (BACKGROUND_CODE) {
    const runBackground = new Function('chrome', 'fetch', BACKGROUND_CODE);
    runBackground(chromeShim, gmFetch);
  }

  // ==========================================================================
  // 3. Inject Extension CSS Assets
  // ==========================================================================
  const CSS_ASSETS = ${cssEntriesJson};
  for (const asset of CSS_ASSETS) {
    let injected = false;
    if (typeof GM_addStyle === 'function') {
      try {
        const el = GM_addStyle(asset.content);
        if (el && el.dataset) el.dataset.crx2userCss = asset.path;
        injected = true;
      } catch {}
    }
    if (!injected && pageDoc) {
      const style = pageDoc.createElement('style');
      style.dataset.crx2userCss = asset.path;
      style.textContent = asset.content;
      (pageDoc.head || pageDoc.documentElement || pageDoc.body)?.appendChild(style);
    }
  }

  // ==========================================================================
  // 4. Register Content-Script <-> Page-World PostMessage Bridge
  // ==========================================================================
  const origin = pageWin.location?.origin || location.origin;
  function onPagePriceMessage(e) {
    if (e.origin !== origin || e.data?.channel !== 'enhancer-mod-price-request') return;
    const { id, payload } = e.data;
    if (typeof id !== 'string' || !payload) return;
    chromeShim.runtime.sendMessage({ type: 'enhancer-mod-price-request', payload }, res => {
      const err = chromeShim.runtime.lastError?.message || res?.error || null;
      pageWin.postMessage({
        channel: 'enhancer-mod-price-result',
        id,
        body: res?.body ?? null,
        error: err
      }, origin);
    });
  }
  pageWin.addEventListener('message', onPagePriceMessage);

  // ==========================================================================
  // 5. Inject Page-World Main Script (DOM <script> with CSP unsafeWindow fallback)
  // ==========================================================================
  const PAGE_SCRIPTS = ${pageScriptsJson};
  for (const scriptAsset of PAGE_SCRIPTS) {
    let executedInPage = false;
    try {
      const scriptEl = pageDoc.createElement('script');
      scriptEl.dataset.crx2userScript = scriptAsset.path;
      scriptEl.textContent = scriptAsset.content;
      (pageDoc.head || pageDoc.documentElement || pageDoc.body)?.appendChild(scriptEl);
      scriptEl.remove();
      if (pageDoc.documentElement?.dataset?.enhancerModBoot) {
        executedInPage = true;
      }
    } catch {}

    if (!executedInPage) {
      if (typeof pageWin.eval === 'function') {
        pageWin.eval(scriptAsset.content);
      } else {
        const runInPage = new Function(scriptAsset.content);
        runInPage.call(pageWin);
      }
    }
  }
})();
`;

  const fullCode = `${header}\n\n${body}`;
  return {
    code: fullCode,
    sha256: sha256(fullCode),
    audit: auditMetadata
  };
}
