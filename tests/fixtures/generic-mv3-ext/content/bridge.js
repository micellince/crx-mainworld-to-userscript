'use strict';
// Generic bridge: forwards window.postMessage traffic to the background worker.
window.addEventListener('message', event => {
  if (event.source !== window || !event.data || event.data.channel !== 'generic-ping') return;
  chrome.runtime.sendMessage({ type: 'generic-ping', payload: event.data.payload }, response => {
    window.postMessage({
      channel: 'generic-pong',
      id: event.data.id,
      ok: !chrome.runtime.lastError && Boolean(response && response.ok),
      result: response && response.result
    }, event.origin);
  });
});

// Generic chrome.* surface exercised at boot: getManifest / getURL / storage.
document.documentElement.dataset.genericBridgeVersion = chrome.runtime.getManifest().version;
const logoUrl = chrome.runtime.getURL('assets/logo.png');
if (logoUrl.indexOf('data:image/png') === 0) document.documentElement.dataset.genericLogoResolved = '1';
chrome.storage.local.set({ bridgeBoots: 1 });
