'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Typed error thrown by SonarrClient on connection/auth failures.
 * @property {string} code  One of: invalid_url | unauthorized | not_found | refused | timeout | reset | network | http_error
 */
class SonarrConnectionError extends Error {

  constructor(code, message) {
    super(message);
    this.name = 'SonarrConnectionError';
    this.code = code;
  }

}

/**
 * Minimal HTTP client for the Sonarr V3 API.
 * No external dependencies — uses Node's built-in http/https modules.
 */
class SonarrClient {

  /**
   * @param {string} host  e.g. "http://192.168.1.10:8989"
   * @param {string} apiKey
   */
  constructor(host, apiKey) {
    this.host = host.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * @param {string} path  e.g. "/api/v3/system/status"
   * @param {object} [query]  query-string parameters
   * @returns {Promise<any>}
   */
  get(path, query = {}) {
    const params = new URLSearchParams({ ...query, apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    return this._request(fullUrl, 'GET');
  }

  /**
   * @param {string} path
   * @param {object} body
   * @returns {Promise<any>}
   */
  post(path, body = {}) {
    const params = new URLSearchParams({ apikey: this.apiKey });
    const fullUrl = `${this.host}${path}?${params}`;
    return this._request(fullUrl, 'POST', body);
  }

  _request(fullUrl, method, body) {
    let parsed;
    try {
      parsed = new url.URL(fullUrl);
    } catch {
      return Promise.reject(new SonarrConnectionError('invalid_url', 'Invalid host URL — make sure it starts with http:// or https://'));
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
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else if (res.statusCode === 401) {
            reject(new SonarrConnectionError('unauthorized', 'Invalid API key'));
          } else if (res.statusCode === 404) {
            reject(new SonarrConnectionError('not_found', 'Sonarr API not found — check the host URL'));
          } else {
            reject(new SonarrConnectionError('http_error', `Sonarr returned HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new SonarrConnectionError('refused', 'Connection refused — is Sonarr running?'));
        } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
          reject(new SonarrConnectionError('not_found', `Host not found: ${parsed.hostname}`));
        } else if (err.code === 'ECONNRESET') {
          reject(new SonarrConnectionError('reset', 'Connection was reset by the server'));
        } else {
          reject(new SonarrConnectionError('network', err.message));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new SonarrConnectionError('timeout', 'Request timed out — check the host URL and network'));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  // --- Convenience methods ---

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

  getSeries() {
    return this.get('/api/v3/series');
  }

  getCalendar(start, end) {
    return this.get('/api/v3/calendar', { start, end });
  }

  sendCommand(name, extraParams = {}) {
    return this.post('/api/v3/command', { name, ...extraParams });
  }

  getHistorySince(isoDate) {
    return this.get('/api/v3/history/since', { date: isoDate, eventType: 0 });
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

module.exports = SonarrClient;
module.exports.SonarrConnectionError = SonarrConnectionError;
