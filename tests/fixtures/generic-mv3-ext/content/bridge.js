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

// Generic loader: request page-world script + stylesheet via getURL().
const loader = document.createElement('script');
loader.src = chrome.runtime.getURL('page/main.js');
(document.head || document.documentElement).appendChild(loader);

const styleLink = document.createElement('link');
styleLink.rel = 'stylesheet';
styleLink.href = chrome.runtime.getURL('page/main.css');
(document.head || document.documentElement).appendChild(styleLink);

// Generic chrome.* surface exercised at boot: getManifest / getURL / storage.
document.documentElement.dataset.genericBridgeVersion = chrome.runtime.getManifest().version;
const logoUrl = chrome.runtime.getURL('assets/logo.png');
if (logoUrl.indexOf('data:image/png') === 0) document.documentElement.dataset.genericLogoResolved = '1';
chrome.storage.local.set({ bridgeBoots: 1 });
