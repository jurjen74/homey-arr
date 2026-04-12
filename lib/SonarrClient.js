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

}

module.exports = SonarrClient;
// Re-export for any callers that import the error class from here
module.exports.SonarrConnectionError = require('./ArrClient').ArrConnectionError;
