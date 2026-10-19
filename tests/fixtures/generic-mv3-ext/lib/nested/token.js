'use strict';
var TOKEN = 'fixture-token';

function deepToken(value) {
  return TOKEN + ':' + String(value == null ? '' : value);
}
