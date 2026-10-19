(() => {
  'use strict';
  document.documentElement.dataset.genericAppBoot = '2.4.1';
  window.postMessage({ channel: 'generic-ping', id: 'boot', payload: { hello: 'world' } }, '*');
})();
