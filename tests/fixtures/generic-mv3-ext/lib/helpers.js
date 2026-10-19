'use strict';
importScripts('nested/token.js');

function buildApiUrl(path) {
  return 'https://api.example.com' + path;
}

function helpersLabel(value) {
  return 'helper:' + deepToken(value);
}
