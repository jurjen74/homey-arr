'use strict';

const ArrClient = require('./ArrClient');

/**
 * Radarr-specific API client. Extends ArrClient with movie endpoints.
 */
class RadarrClient extends ArrClient {

  constructor(host, apiKey) {
    super(host, apiKey, 'Radarr');
  }

  getMovies() {
    return this.get('/api/v3/movie');
  }

  // Override to always include embedded movie objects (Radarr-specific).
  getRecentHistory(pageSize = 50, includeDetails = false, eventType = null) {
    return this.get('/api/v3/history', {
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
      includeMovie: true,
      ...(eventType != null ? { eventType } : {}),
    });
  }

}

module.exports = RadarrClient;
module.exports.RadarrConnectionError = require('./ArrClient').ArrConnectionError;
