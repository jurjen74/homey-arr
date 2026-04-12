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

  // Override base methods to include embedded movie objects in history responses.
  // Without includeMovie:true the history records contain only movieId, not the full movie object.
  getHistorySince(isoDate) {
    return this.get('/api/v3/history/since', { date: isoDate, eventType: 0, includeMovie: true });
  }

  getRecentHistory(pageSize = 50) {
    return this.get('/api/v3/history', {
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
      includeMovie: true,
    });
  }

}

module.exports = RadarrClient;
module.exports.RadarrConnectionError = require('./ArrClient').ArrConnectionError;
