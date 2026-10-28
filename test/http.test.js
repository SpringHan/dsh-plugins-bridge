import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  bearerToken,
  isLoopbackAddress,
  isLoopbackRequest,
  isSameOriginRequest,
  pickLocalized,
  readJsonBody,
  safeJson,
  timingSafeEqualString,
} from '../lib/http.js';

/** Minimal IncomingMessage stand-in for body parsing. */
function fakeRequest(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.destroy = () => {};
  req.resume = () => {};
  return req;
}

test('isLoopbackAddress classifies IPv4, IPv6, and mapped forms', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['', '10.0.0.1', '128.0.0.1', '::2', '::ffff:10.0.0.1', 'fe80::1%lo0', 'localhost', null, 42]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test('isLoopbackRequest reads the socket address', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.5' } }), false);
  assert.equal(isLoopbackRequest({}), false);
});

test('isSameOriginRequest permits absent origins and matching hosts', () => {
  assert.equal(isSameOriginRequest({ headers: {} }), true);
  assert.equal(
    isSameOriginRequest({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }),
    true,
  );
  assert.equal(
    isSameOriginRequest({ headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }),
    false,
  );
  assert.equal(isSameOriginRequest({ headers: { origin: 'not a url', host: 'x' } }), false);
});

test('bearerToken accepts Authorization and the fallback header', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(bearerToken({ headers: { authorization: 'bearer   abc  ' } }), 'abc');
  assert.equal(bearerToken({ headers: { 'x-bridge-token': ' xyz ' } }), 'xyz');
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), undefined);
  assert.equal(bearerToken({ headers: {} }), undefined);
});

test('timingSafeEqualString compares values and lengths', () => {
  assert.equal(timingSafeEqualString('abc', 'abc'), true);
  assert.equal(timingSafeEqualString('abc', 'abd'), false);
  assert.equal(timingSafeEqualString('abc', 'abcd'), false);
  assert.equal(timingSafeEqualString(undefined, ''), false);
});

test('readJsonBody parses objects and treats an empty body as {}', async () => {
  const good = fakeRequest();
  const pending = readJsonBody(good);
  good.emit('data', Buffer.from('{"a":1}'));
  good.emit('end');
  assert.deepEqual(await pending, { a: 1 });

  const empty = fakeRequest();
  const emptyPending = readJsonBody(empty);
  empty.emit('end');
  assert.deepEqual(await emptyPending, {});
});

test('readJsonBody rejects non-objects, invalid JSON, and oversized bodies', async () => {
  await assert.rejects(async () => {
    const req = fakeRequest();
    const pending = readJsonBody(req);
    req.emit('data', Buffer.from('[1,2]'));
    req.emit('end');
    await pending;
  }, (error) => error.code === 'invalid-body');

  await assert.rejects(async () => {
    const req = fakeRequest();
    const pending = readJsonBody(req);
    req.emit('data', Buffer.from('{oops'));
    req.emit('end');
    await pending;
  }, (error) => error.code === 'invalid-json');

  await assert.rejects(async () => {
    const req = fakeRequest();
    const pending = readJsonBody(req, 4);
    req.emit('data', Buffer.from('{"long":true}'));
    await pending;
  }, (error) => error.code === 'body-too-large');
});

test('safeJson projects runtime values without throwing', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  const value = safeJson({
    big: 10n,
    bytes: new Uint8Array([1, 2, 3]),
    when: new Date('2020-01-02T03:04:05.000Z'),
    missing: undefined,
    fn: () => {},
    nan: Number.NaN,
    nested: [1, undefined, cyclic],
    error: new Error('boom'),
  });
  assert.equal(value.big, '10');
  assert.equal(value.bytes, 'AQID');
  assert.equal(value.when, '2020-01-02T03:04:05.000Z');
  assert.equal('missing' in value, false);
  assert.equal('fn' in value, false);
  assert.equal(value.nan, 'NaN');
  assert.equal(value.nested[1], null);
  assert.equal(value.nested[2].self, '[Circular]');
  assert.deepEqual(value.error, { name: 'Error', message: 'boom' });
  assert.equal(safeJson(undefined), null);
});

test('pickLocalized selects the active language with an English fallback', () => {
  assert.equal(pickLocalized('plain', 'zh'), 'plain');
  assert.equal(pickLocalized({ en: 'English', zh: '中文' }, 'zh'), '中文');
  assert.equal(pickLocalized({ en: 'English', zh: '中文' }, 'fr'), 'English');
  assert.equal(pickLocalized({ zh: '中文' }, 'en'), '中文');
  assert.equal(pickLocalized(undefined, 'en'), undefined);
});
