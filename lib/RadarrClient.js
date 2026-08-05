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

  // Returns only the fields needed by the slow poll — peak parse memory is one item, not the full list.
  getMoviesSlim() {
    return this.getArray('/api/v3/movie', {}, (m) => ({
      id:     m.id,
      title:  m.title  || '',
      year:   m.year   || 0,
      studio: m.studio || '',
    }));
  }

  getMovieById(id) {
    return this.get(`/api/v3/movie/${id}`);
  }

  // Override to always include embedded movie objects (Radarr-specific).
  getRecentHistory(pageSize = 50, includeDetails = false, eventType = null, page = 1) {
    return this.get('/api/v3/history', {
      page,
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
