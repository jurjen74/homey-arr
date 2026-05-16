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
