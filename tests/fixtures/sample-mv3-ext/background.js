'use strict';
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'enhancer-mod-price-request') return false;
  const p = msg.payload;
  if (!p || !['FUTNext', 'FUTBIN'].includes(p.source)) {
    sendResponse({ body: null, error: 'PRICE_INVALID_REQUEST' });
    return false;
  }
  const url = p.source === 'FUTNext'
    ? 'https://enhancer-api.futnext.com/players/v2/prices?ids=' + (p.ids || []).join('_') + '&platform=' + p.platform
    : 'https://www.futbin.org/futbin/api/27/getFilteredPlayers?rating=' + p.rating;
  fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(body => sendResponse({ body, error: null }))
    .catch(err => sendResponse({ body: null, error: err?.message || 'PRICE_NETWORK_ERROR' }));
  return true;
});
