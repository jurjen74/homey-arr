'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const { JsonArraySplitter, JsonSplitError } = require('./JsonArraySplitter');

// Ceiling for the buffered path (_fetchText). Everything that still goes through it is sized by
// the request itself — a status object, one page, one item — and stays well under 1 MB, so this
// is never reached in normal use. It is there so that a response which is unexpectedly huge
// fails as an error on one device instead of running the whole app out of heap.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Typed error thrown by ArrClient subclasses on connection/auth failures.
 * @property {string} code  One of: invalid_url | unauthorized | not_found | refused | timeout |
 *   reset | network | http_error | incomplete | unexpected | too_large
 */
class ArrConnectionError extends Error {

  constructor(code, message) {
    super(message);
    this.name = 'ArrConnectionError';
    this.code = code;
  }

}

/**
 * Minimal HTTP base client for the *arr v3 API family (Sonarr, Radarr, …).
 * No external dependencies — uses Node's built-in http/https modules.
 * Subclasses set this.appName in their constructor for error messages.
 */
class ArrClient {

  /**
   * @param {string} host     e.g. "http://192.168.1.10:8989"
   * @param {string} apiKey
   * @param {string} appName  Used in error messages ("Sonarr", "Radarr", …)
   */
  constructor(host, apiKey, appName = 'Arr') {
    this.host = host.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.appName = appName;
  }

  get(path, query = {}) {
    const params = new URLSearchParams({ ...query, apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    return this._request(fullUrl, 'GET');
  }

  post(path, body = {}) {
    const params = new URLSearchParams({ apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    return this._request(fullUrl, 'POST', body);
  }

  // Fetches a JSON array endpoint and maps each item with mapFn as it comes off the socket. The
  // response is never held as a whole — not as text, not as a parsed tree — so peak memory is one
  // item plus whatever mapFn keeps, however large the collection is.
  getArray(path, query, mapFn) {
    const params = new URLSearchParams({ ...query, apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    const result = [];
    return this._fetchItems(fullUrl, null, (item) => { result.push(mapFn(item)); })
      .then(() => result);
  }

  // Fetches a paginated endpoint (returns {records:[...], totalRecords:N, ...}) and
  // maps each record individually — same streamed, per-item approach as getArray().
  getRecords(path, query, mapFn) {
    const params = new URLSearchParams({ ...query, apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    const records = [];
    return this._fetchItems(fullUrl, 'records', (item) => { records.push(mapFn ? mapFn(item) : item); })
      .then((envelope) => ({ records, totalRecords: Number(envelope.totalRecords) || 0 }));
  }

  // Streams a response through JsonArraySplitter, handing each parsed item to onItem. `key` is
  // null when the response is the array itself, or the property that holds it. Resolves with the
  // object around the array (or null) — but only once the array has arrived in full.
  //
  // A response that stops early rejects rather than resolving with what was received. The callers
  // diff these lists against the previous one, so a short list would read as items removed and
  // then, on the next complete fetch, as all of them added again.
  _fetchItems(fullUrl, key, onItem) {
    const splitter = new JsonArraySplitter({ key, onItem: (text) => onItem(JSON.parse(text)) });
    return this._stream(fullUrl, 'GET', null, (chunk) => splitter.write(chunk))
      .then(() => {
        const { complete, envelope } = splitter.end();
        if (!complete) {
          throw new ArrConnectionError('incomplete', `${this.appName} sent an incomplete response`);
        }
        return envelope;
      })
      .catch((err) => {
        // Not JSON at all (a proxy's login page, say), or an item that does not parse. Anything
        // else — a bug in a mapper, a connection error — passes through as it is.
        if (err instanceof JsonSplitError || err instanceof SyntaxError) {
          throw new ArrConnectionError('unexpected', `Unexpected response from ${this.appName}: ${err.message}`);
        }
        throw err;
      });
  }

  _request(fullUrl, method, body) {
    return this._fetchText(fullUrl, method, body).then((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    });
  }

  // Buffers the whole body and returns it as text. Only for responses whose size is set by the
  // request. Anything that grows with the library must go through getArray()/getRecords(): on
  // Homey's Node 22 the decoded text sits in the V8 heap at two bytes per character as soon as it
  // contains one non-Latin-1 character, so a 39 MB movie list is a 74 MB string.
  _fetchText(fullUrl, method = 'GET', body = null) {
    const chunks = [];
    let size = 0;
    return this._stream(fullUrl, method, body, (chunk) => {
      size += chunk.length;
      if (size > MAX_BUFFERED_BYTES) {
        throw new ArrConnectionError('too_large', `${this.appName} sent an unexpectedly large response`);
      }
      chunks.push(chunk);
    }).then(() => Buffer.concat(chunks).toString('utf8'));
  }

  // Performs the request and hands each chunk of the body to onChunk as it arrives. Resolves
  // once the response has ended cleanly. Rejects — and stops the transfer — on an HTTP error
  // status, a network error, an idle timeout, a body that is cut short, or an error thrown by
  // onChunk.
  _stream(fullUrl, method, body, onChunk) {
    let parsed;
    try {
      parsed = new url.URL(fullUrl);
    } catch {
      return Promise.reject(new ArrConnectionError('invalid_url', 'Invalid host URL — make sure it starts with http:// or https://'));
    }

    return new Promise((resolve, reject) => {
      const transport = parsed.protocol === 'https:' ? https : http;
      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      };

      // Every failure goes through here: the request settles exactly once, and the transfer is
      // torn down rather than left running with nobody listening.
      let req;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const lost = () => fail(new ArrConnectionError('reset', 'Connection was lost while reading the response'));

      req = transport.request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (res.statusCode === 401) {
            fail(new ArrConnectionError('unauthorized', 'Invalid API key'));
          } else if (res.statusCode === 404) {
            fail(new ArrConnectionError('not_found', `${this.appName} API not found — check the host URL`));
          } else {
            fail(new ArrConnectionError('http_error', `${this.appName} returned HTTP ${res.statusCode}`));
          }
          return;
        }

        res.on('data', (chunk) => {
          if (settled) return;
          try {
            onChunk(chunk);
          } catch (err) {
            fail(err);
          }
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        // A body that stops before its end never emits 'end'. Without these two the promise
        // would stay pending for good.
        res.on('error', lost);
        res.on('close', () => { if (!res.complete) lost(); });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          fail(new ArrConnectionError('refused', `Connection refused — is ${this.appName} running?`));
        } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
          fail(new ArrConnectionError('not_found', `Host not found: ${parsed.hostname}`));
        } else if (err.code === 'ECONNRESET') {
          fail(new ArrConnectionError('reset', 'Connection was reset by the server'));
        } else {
          fail(new ArrConnectionError('network', err.message));
        }
      });

      req.on('timeout', () => {
        fail(new ArrConnectionError('timeout', 'Request timed out — check the host URL and network'));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  // --- Shared API methods (identical across all *arr apps) ---

  getSystemStatus() {
    return this.get('/api/v3/system/status');
  }

  getHealth() {
    return this.get('/api/v3/health');
  }

  getDiskSpace() {
    return this.get('/api/v3/diskspace');
  }

  getQueue() {
    return this.get('/api/v3/queue', { pageSize: 1 });
  }

  getWantedMissing() {
    return this.get('/api/v3/wanted/missing', { pageSize: 1 });
  }

  // The calendar is fetched on every poll and its size follows how busy the library is, not the
  // request. mapFn runs per item as the response arrives, so callers keep only what they use.
  getCalendar(start, end, mapFn = (item) => item) {
    return this.getArray('/api/v3/calendar', { start, end }, mapFn);
  }

  sendCommand(name, extraParams = {}) {
    return this.post('/api/v3/command', { name, ...extraParams });
  }

  getRecentHistory(pageSize = 50, includeDetails = false, eventType = null, page = 1) {
    return this.get('/api/v3/history', {
      page,
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
      ...(eventType != null ? { eventType } : {}),
      ...(includeDetails ? { includeSeries: true, includeEpisode: true, includeMovie: true } : {}),
    });
  }

  markHistoryFailed(id) {
    return this.post(`/api/v3/history/failed/${id}`);
  }

  getDownloadClients() {
    return this.get('/api/v3/downloadclient');
  }

  updateDownloadClient(id, data) {
    const params = new URLSearchParams({ apikey: this.apiKey });
    return this._request(`${this.host}/api/v3/downloadclient/${id}?${params}`, 'PUT', data);
  }

}

module.exports = ArrClient;
module.exports.ArrConnectionError = ArrConnectionError;
