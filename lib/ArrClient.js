'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Typed error thrown by ArrClient subclasses on connection/auth failures.
 * @property {string} code  One of: invalid_url | unauthorized | not_found | refused | timeout | reset | network | http_error
 */
class ArrConnectionError extends Error {

  constructor(code, message) {
    super(message);
    this.name = 'ArrConnectionError';
    this.code = code;
  }

}

// Splits a JSON array string into per-item substrings without building the full parsed tree.
// Handles nested objects/arrays and string escape sequences.
function* iterJsonArray(text) {
  let i = text.indexOf('[');
  if (i === -1) return;
  i++;

  while (i < text.length) {
    while (i < text.length && ' \t\r\n,'.includes(text[i])) i++;
    if (i >= text.length || text[i] === ']') break;

    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;

    while (i < text.length) {
      const c = text[i];
      if (escape) {
        escape = false;
      } else if (inString) {
        if (c === '\\') escape = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{' || c === '[') {
        depth++;
      } else if (c === '}' || c === ']') {
        if (--depth === 0) { i++; break; }
      }
      i++;
    }

    yield text.slice(start, i);
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

  // Fetches a JSON array endpoint and maps each item with mapFn without ever
  // building the full array object tree — each item is parsed and mapped individually,
  // so peak memory per parse is one item rather than the entire collection.
  getArray(path, query, mapFn) {
    const params = new URLSearchParams({ ...query, apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    return this._fetchText(fullUrl).then((text) => {
      const result = [];
      for (const itemStr of iterJsonArray(text)) {
        result.push(mapFn(JSON.parse(itemStr)));
      }
      return result;
    });
  }

  // Fetches a paginated endpoint (returns {records:[...], totalRecords:N, ...}) and
  // maps each record individually — same per-item approach as getArray().
  getRecords(path, query, mapFn) {
    const params = new URLSearchParams({ ...query, apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    return this._fetchText(fullUrl).then((text) => {
      const totalMatch = text.match(/"totalRecords"\s*:\s*(\d+)/);
      const totalRecords = totalMatch ? parseInt(totalMatch[1], 10) : 0;
      const records = [];
      // Locate the records array robustly — find the key then the next '[' after it,
      // so whitespace variations like "records": [ don't cause a missed match.
      const keyIdx = text.indexOf('"records"');
      if (keyIdx !== -1) {
        const bracketIdx = text.indexOf('[', keyIdx);
        if (bracketIdx !== -1) {
          for (const itemStr of iterJsonArray(text.slice(bracketIdx))) {
            records.push(mapFn ? mapFn(JSON.parse(itemStr)) : JSON.parse(itemStr));
          }
        }
      }
      return { records, totalRecords };
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

  _fetchText(fullUrl, method = 'GET', body = null) {
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

      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Buffer.concat(chunks).toString('utf8'));
          } else if (res.statusCode === 401) {
            reject(new ArrConnectionError('unauthorized', 'Invalid API key'));
          } else if (res.statusCode === 404) {
            reject(new ArrConnectionError('not_found', `${this.appName} API not found — check the host URL`));
          } else {
            reject(new ArrConnectionError('http_error', `${this.appName} returned HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new ArrConnectionError('refused', `Connection refused — is ${this.appName} running?`));
        } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
          reject(new ArrConnectionError('not_found', `Host not found: ${parsed.hostname}`));
        } else if (err.code === 'ECONNRESET') {
          reject(new ArrConnectionError('reset', 'Connection was reset by the server'));
        } else {
          reject(new ArrConnectionError('network', err.message));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new ArrConnectionError('timeout', 'Request timed out — check the host URL and network'));
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

  getCalendar(start, end) {
    return this.get('/api/v3/calendar', { start, end });
  }

  sendCommand(name, extraParams = {}) {
    return this.post('/api/v3/command', { name, ...extraParams });
  }

  getRecentHistory(pageSize = 50, includeDetails = false, eventType = null) {
    return this.get('/api/v3/history', {
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
