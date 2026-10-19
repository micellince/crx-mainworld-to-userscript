'use strict';
importScripts('lib/helpers.js');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'generic-ping') return false;
  const payload = message.payload || {};
  const url = buildApiUrl('/ping?echo=' + encodeURIComponent(payload.hello || ''));
  fetch(url, { method: 'GET', headers: { Accept: 'application/json', 'X-Fixture': TOKEN } })
    .then(response => response.json())
    .then(body => sendResponse({
      ok: true,
      result: {
        version: chrome.runtime.getManifest().version,
        label: helpersLabel(payload.hello),
        body
      }
    }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
