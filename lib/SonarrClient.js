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

  // One episode, fetched on demand when a trigger fires. Deliberately not taken from the history
  // record's embedded episode object: whether /api/v3/history embeds it without `includeEpisode`
  // is undocumented, and relying on it fails silently (empty title, unknown age) if it ever stops.
  // A single small request on a download event costs far less than requesting the embed on every
  // poll, and the per-item cache collapses repeats within a burst.
  getEpisodeById(id) {
    return this.get(`/api/v3/episode/${id}`);
  }

  // Slim history for the fast poll — parses each record individually and extracts only
  // the fields needed for trigger detection. Sonarr embeds full series+episode objects
  // in every history record by default, making the raw response ~2 MB for 15 records.
  getRecentHistorySlim(pageSize = 15) {
    return this.getRecords('/api/v3/history', {
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
    }, (r) => ({
      id:          r.id,
      date:        r.date        || '',
      eventType:   r.eventType   || '',
      seriesId:    r.seriesId    || 0,
      episodeId:   r.episodeId   || 0,
      sourceTitle: r.sourceTitle || '',
      quality:     { quality: { name: r.quality?.quality?.name || '' } },
      data:        { message: r.data?.message || '' },
    }));
  }

  // Widget history — embeds series title and poster only; parses per-record to keep peak low
  // even when fetching large page sizes (up to 500 for uniqueSeries mode).
  getRecentHistoryWithSeries(pageSize = 10, eventType = null) {
    return this.getRecords('/api/v3/history', {
      pageSize,
      sortKey: 'date',
      sortDirection: 'descending',
      includeSeries: true,
      ...(eventType != null ? { eventType } : {}),
    }, (r) => ({
      id:          r.id,
      eventType:   r.eventType   || '',
      seriesId:    r.seriesId    || 0,
      episodeId:   r.episodeId   || 0,
      sourceTitle: r.sourceTitle || '',
      date:        r.date        || '',
      quality:     { quality: { name: r.quality?.quality?.name || '' } },
      data:        { importedPath: r.data?.importedPath || '' },
      series: {
        title:     r.series?.title || '',
        posterUrl: (r.series?.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '',
      },
    }));
  }

}

module.exports = SonarrClient;
// Re-export for any callers that import the error class from here
module.exports.SonarrConnectionError = require('./ArrClient').ArrConnectionError;
