'use strict';

const ArrClient = require('./ArrClient');

/**
 * Sonarr-specific API client. Extends ArrClient with series/episode endpoints.
 */
class SonarrClient extends ArrClient {

  constructor(host, apiKey) {
    super(host, apiKey, 'Sonarr');
  }

  getSeries() {
    return this.get('/api/v3/series');
  }

  // Returns only the fields needed by the slow poll — peak parse memory is one item, not the full list.
  getSeriesSlim() {
    return this.getArray('/api/v3/series', {}, (s) => ({
      id:        s.id,
      title:     s.title   || '',
      network:   s.network || '',
      year:      s.year    || 0,
      posterUrl: (s.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '',
    }));
  }

  getSeriesById(id) {
    return this.get(`/api/v3/series/${id}`);
  }

  // Fetches history with embedded series objects — avoids a full library fetch for the widget.
  getRecentHistoryWithSeries(pageSize = 10, eventType = null) {
    return this.get('/api/v3/history', {
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
      includeSeries: true,
      ...(eventType != null ? { eventType } : {}),
    });
  }

}

module.exports = SonarrClient;
// Re-export for any callers that import the error class from here
module.exports.SonarrConnectionError = require('./ArrClient').ArrConnectionError;
