/**
 * Transport helpers shared by the management and external APIs.
 *
 * Everything here is Harness-independent so it can be unit-tested with plain
 * Node. The callers own policy; these helpers only classify, serialize, and
 * read.
 *
 * @module dsh-plugins-bridge/http
 */

import { timingSafeEqual } from 'node:crypto';

/** Default request body ceiling: 1 MiB of JSON. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/**
 * Whether a peer address is a loopback literal.
 *
 * Covers IPv4 (`127.0.0.0/8`), IPv6 (`::1`), their IPv4-mapped forms in both
 * dotted (`::ffff:127.0.0.1`) and hexadecimal (`::ffff:7f00:1`) spelling, and
 * an optional zone id (`fe80::1%lo` style) that is never compared.
 *
 * @param address - `req.socket.remoteAddress`-shaped text.
 * @returns whether the address is loopback.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  let value = address.trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (value.startsWith('0:0:0:0:0:ffff:')) value = value.slice('0:0:0:0:0:ffff:'.length);
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  // IPv4-mapped IPv6 hex spelling: the last two hextets are the IPv4 bytes.
  const mapped = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return (high >>> 8) === 127 && Number.isInteger(low);
  }
  return false;
}

/**
 * Whether a request arrived over a loopback socket.
 * @param req - incoming request.
 * @returns true when the peer is this machine.
 */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(req?.socket?.remoteAddress);
}

/**
 * Whether a browser request came from this exact origin.
 *
 * A request without an `Origin` header (curl, an editor plugin, a native HTTP
 * client) is allowed; a browser `Origin` must match the `Host` the request was
 * sent to. This is CSRF defence for the management API, not authentication.
 *
 * @param req - incoming request.
 * @returns whether the request may be treated as same-origin.
 */
export function isSameOriginRequest(req) {
  const origin = req?.headers?.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Normalize default ports through the URL parser, so an `Origin` that omits
    // `:80` still matches a `Host` that spells it out.
    const hostUrl = new URL(`${parsed.protocol}//${host}`);
    return parsed.host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Extract a bearer token from the request.
 *
 * `Authorization: Bearer <token>` is canonical; `X-Bridge-Token` exists for
 * clients that cannot set `Authorization`.
 *
 * @param req - incoming request.
 * @returns the token, or `undefined` when absent or malformed.
 */
export function bearerToken(req) {
  const header = req?.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
    if (match !== null) return match[1].trim();
  }
  const alternate = req?.headers?.['x-bridge-token'];
  if (typeof alternate === 'string' && alternate.trim() !== '') return alternate.trim();
  return undefined;
}

/**
 * Compare two secrets without leaking length or content through timing.
 * @param left - candidate value.
 * @param right - expected value.
 * @returns whether they are equal.
 */
export function timingSafeEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    // Compare a value with itself so the failure path still costs a compare.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Send one JSON response.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param value - JSON-serializable payload.
 * @param headers - extra response headers.
 */
export function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  const body = `${JSON.stringify(value === undefined ? null : value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/**
 * Send a structured error.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param code - stable machine code.
 * @param message - human-readable message.
 * @param options - optional field name and extra headers.
 */
export function sendError(res, status, code, message, options = {}) {
  const error = { code, message };
  if (typeof options.field === 'string') error.field = options.field;
  sendJson(res, status, { ok: false, error }, options.headers);
}

/**
 * Create an Error carrying a status code and stable machine code.
 * @param status - HTTP status code.
 * @param code - stable machine code.
 * @param message - human-readable message.
 * @param field - optional request field.
 * @returns the annotated error.
 */
export function httpError(status, code, message, field) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (typeof field === 'string') error.field = field;
  return error;
}

/**
 * Read and parse a bounded JSON object body.
 *
 * An empty body is `{}` so a bodyless POST is valid. Arrays, primitives, and
 * malformed JSON are rejected with a 400; an oversized body with a 413.
 *
 * @param req - incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed object.
 */
export function readJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(httpError(413, 'body-too-large', `request body exceeds ${limit} bytes`));
        // Keep the socket alive so the 413 can be delivered; drain the rest of
        // the unread body without retaining it.
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch (error) {
        reject(httpError(400, 'invalid-json', `request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'body'));
        return;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        reject(httpError(400, 'invalid-body', 'request body must be a JSON object', 'body'));
        return;
      }
      resolve(value);
    });
    req.on('error', (error) => fail(httpError(400, 'request-error', error instanceof Error ? error.message : String(error))));
  });
}

/**
 * Pick one language from a `LocalizedText` value.
 * @param value - string, `{ en, zh, ... }`, or absent.
 * @param lang - preferred language id.
 * @returns the selected text, or `undefined`.
 */
export function pickLocalized(value, lang) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value[lang] === 'string') return value[lang];
  if (typeof value.en === 'string') return value.en;
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}

/** Maximum nesting that survives projection. */
const MAX_JSON_DEPTH = 12;
/** Maximum array items retained in one projected array. */
const MAX_ARRAY_ITEMS = 10_000;
/** Maximum object keys retained in one projected object. */
const MAX_OBJECT_KEYS = 2_000;

/**
 * Project arbitrary runtime values (including bytes, bigint, cycles, Error,
 * and `undefined`) onto lossless-enough JSON for an HTTP client.
 *
 * The projection is intentionally bounded: an enormous runtime value yields a
 * truncated preview rather than an unbounded response or a JSON failure.
 *
 * @param value - any runtime value.
 * @returns a JSON-safe value.
 */
export function safeJson(value) {
  const stack = [];
  const visit = (input, depth) => {
    if (input === null) return null;
    const type = typeof input;
    if (type === 'string' || type === 'boolean') return input;
    if (type === 'number') return Number.isFinite(input) ? input : String(input);
    if (type === 'bigint') return input.toString();
    if (type === 'undefined') return undefined;
    if (type === 'function' || type === 'symbol') return undefined;
    if (depth >= MAX_JSON_DEPTH) return '[Max depth]';
    if (stack.includes(input)) return '[Circular]';
    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) return { name: input.name, message: input.message };
    if (input instanceof Uint8Array) return Buffer.from(input).toString('base64');
    if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input)).toString('base64');
    stack.push(input);
    try {
      if (Array.isArray(input)) {
        const out = [];
        const length = Math.min(input.length, MAX_ARRAY_ITEMS);
        for (let index = 0; index < length; index += 1) {
          const item = visit(input[index], depth + 1);
          out.push(item === undefined ? null : item);
        }
        if (input.length > MAX_ARRAY_ITEMS) out.push(`[…${input.length - MAX_ARRAY_ITEMS} more items]`);
        return out;
      }
      if (input instanceof Map) {
        return visit(Object.fromEntries(input), depth + 1);
      }
      if (input instanceof Set) {
        return visit([...input], depth + 1);
      }
      const out = {};
      const keys = Object.keys(input);
      const length = Math.min(keys.length, MAX_OBJECT_KEYS);
      for (let index = 0; index < length; index += 1) {
        const key = keys[index];
        let item;
        try {
          item = visit(input[key], depth + 1);
        } catch {
          item = '[Unreadable]';
        }
        if (item !== undefined) out[key] = item;
      }
      if (keys.length > MAX_OBJECT_KEYS) out['[truncated]'] = `${keys.length - MAX_OBJECT_KEYS} more keys`;
      return out;
    } finally {
      stack.pop();
    }
  };
  const projected = visit(value, 0);
  return projected === undefined ? null : projected;
}
