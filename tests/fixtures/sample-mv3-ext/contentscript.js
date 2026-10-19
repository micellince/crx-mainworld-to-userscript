'use strict';
const origin = location.origin;
window.addEventListener('message', e => {
  if (e.origin !== origin || e.data?.channel !== 'enhancer-mod-price-request') return;
  const { id, payload } = e.data;
  chrome.runtime.sendMessage({ type: 'enhancer-mod-price-request', payload }, res => {
    window.postMessage({ channel: 'enhancer-mod-price-result', id, body: res?.body ?? null, error: res?.error ?? null }, origin);
  });
});
