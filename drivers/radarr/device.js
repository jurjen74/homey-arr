'use strict';

const Homey = require('homey');
const RadarrClient = require('../../lib/RadarrClient');

const MS_PER_SECOND = 1000;

class RadarrDevice extends Homey.Device {

  async onInit() {
    this._client = this._buildClient();
    this._pollTimer = null;


    // Health tracking
    this._previousStatus = null;

    // Disk tracking
    this._previousDiskFreeGb = null;

    // Queue tracking
    this._previousQueueCount = null;

    // Movie tracking — populated silently on first poll, triggers fire from second poll onward
    this._knownMovieIds = null;

    // History tracking — null until first poll (pre-populate without triggering)
    this._seenHistoryIds = null;

    // Releasing-today tracking — {movieId}-{YYYY-MM-DD} so it fires once per movie per day
    this._firedReleasingKeys = new Set();
    this._releasingKeyDate = null;

    // Movie cache for autocomplete
    this._cachedMovies = [];

    // Calendar cache for widget
    this._cachedCalendar = [];

    await this.driver.ready();
    this._startPolling();
    this.log('RadarrDevice initialized:', this.getName());
  }

  async onSettings({ newSettings }) {
    this._client = new RadarrClient(newSettings.host, newSettings.apiKey);
    this._restartPolling();
  }

  async onDeleted() {
    this._stopPolling();
  }

  // --- Polling ---

  _buildClient() {
    const { host, apiKey } = this.getSettings();
    return new RadarrClient(host, apiKey);
  }

  _startPolling() {
    const intervalSec = this.getSetting('pollInterval') || 60;
    this._poll();
    this._pollTimer = this.homey.setInterval(() => this._poll(), intervalSec * MS_PER_SECOND);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _restartPolling() {
    this._stopPolling();
    this._startPolling();
  }

  async _poll() {
    try {
      await Promise.all([
        this._updateHealth(),
        this._updateDiskSpace(),
        this._updateQueue(),
        this._updateMissing(),
        this._updateMovies(),
        this._updateUpcoming(),
        this._updateHistory(),
        this._updateReleasingToday(),
      ]);

      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      this.error('Poll failed:', err.message);
      await this.setUnavailable(err.message);
    }
  }

  // --- Capability updaters ---

  async _updateHealth() {
    const items = await this._client.getHealth();
    let status;
    let worstItem = null;

    if (!items.length) {
      status = 'healthy';
    } else {
      worstItem = items.find((i) => i.type === 'error') || items[0];
      status = worstItem.type === 'error' ? 'error' : 'warning';
    }

    await this.setCapabilityValue('alarm_generic', status !== 'healthy');

    if (this._previousStatus !== null && this._previousStatus !== status) {
      this.driver.triggerHealthChanged(this, {
        status,
        message: worstItem ? worstItem.message : '',
        source:  worstItem ? worstItem.source  : '',
      });
      if (status === 'healthy') {
        this.driver.triggerHealthResolved(this);
      }
    }
    this._previousStatus = status;
  }

  async _updateDiskSpace() {
    const disks = await this._client.getDiskSpace();
    const totalFreeBytes = disks.reduce((sum, d) => sum + (d.freeSpace || 0), 0);
    const freeGb = Math.round((totalFreeBytes / 1e9) * 10) / 10;

    await this.setCapabilityValue('radarr_disk_free_gb', freeGb);

    const threshold = this.driver.diskLowThreshold;
    if (
      this._previousDiskFreeGb !== null &&
      this._previousDiskFreeGb >= threshold &&
      freeGb < threshold
    ) {
      this.driver.triggerDiskSpaceLow(this, freeGb);
    }
    this._previousDiskFreeGb = freeGb;
  }

  async _updateQueue() {
    const queue = await this._client.getQueue();
    const count = queue.totalRecords || 0;

    await this.setCapabilityValue('radarr_queue_count', count);

    if (this._previousQueueCount !== null && this._previousQueueCount > 0 && count === 0) {
      this.driver.triggerQueueEmpty(this);
    }
    this._previousQueueCount = count;
  }

  async _updateMissing() {
    const missing = await this._client.getWantedMissing();
    await this.setCapabilityValue('radarr_missing_count', missing.totalRecords || 0);
  }

  async _updateMovies() {
    const movies = await this._client.getMovies();
    if (!Array.isArray(movies)) return;

    await this.setCapabilityValue('radarr_movie_count', movies.length);

    // Refresh autocomplete cache
    this._cachedMovies = movies;

    const currentIds = new Set(movies.map((m) => m.id));

    if (this._knownMovieIds === null) {
      // First poll — populate silently, no triggers
      this._knownMovieIds = currentIds;
      return;
    }

    for (const m of movies) {
      if (!this._knownMovieIds.has(m.id)) {
        this.driver.triggerMovieAdded(this, {
          movie:  m.title,
          year:   m.year || 0,
          studio: m.studio || '',
        });
      }
    }
    this._knownMovieIds = currentIds;
  }

  async _updateUpcoming() {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 14);

    const movies = await this._client.getCalendar(
      now.toISOString().split('T')[0],
      end.toISOString().split('T')[0],
    );

    this._cachedCalendar = Array.isArray(movies) ? movies : [];

    const sevenDaysAhead = new Date(now);
    sevenDaysAhead.setDate(now.getDate() + 7);
    const upcomingCount = this._cachedCalendar.filter((m) => {
      const rd = m.digitalRelease || m.physicalRelease || m.inCinemas;
      return rd && new Date(rd) <= sevenDaysAhead;
    }).length;
    await this.setCapabilityValue('radarr_upcoming_count', upcomingCount);
  }

  async _updateHistory() {
    const history = await this._client.getRecentHistory(100, true);
    const records = Array.isArray(history?.records) ? history.records : [];

    // First run: pre-populate records older than 5 minutes so they don't re-trigger
    // after a restart. Records within the last 5 minutes are treated as new.
    if (this._seenHistoryIds === null) {
      this._seenHistoryIds = new Set();
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      for (const r of records) {
        if (r.date < cutoff) this._seenHistoryIds.add(r.id);
      }
    }

    for (const record of records) {
      if (this._seenHistoryIds.has(record.id)) continue;
      this._seenHistoryIds.add(record.id);

      const movie = record.movie || {};

      if (record.eventType === 'downloadFolderImported' || record.eventType === 'movieFolderImported') {
        this.driver.triggerMovieDownloaded(this, {
          movie:        movie.title || '',
          year:         movie.year || 0,
          quality:      record.quality?.quality?.name || '',
          source_title: record.sourceTitle || '',
        });
      }

      if (record.eventType === 'downloadFailed') {
        this.driver.triggerDownloadFailed(this, {
          movie:        movie.title || '',
          year:         movie.year || 0,
          source_title: record.sourceTitle || '',
          quality:      record.quality?.quality?.name || '',
          message:      record.data?.message || 'Unknown reason',
          history_id:   record.id || 0,
          movie_id:     record.movieId || 0,
        });
      }
    }
  }

  async _updateReleasingToday() {
    const today = new Date().toISOString().split('T')[0];

    if (this._releasingKeyDate !== today) {
      this._firedReleasingKeys = new Set();
      this._releasingKeyDate = today;
    }

    const movies = await this._client.getCalendar(today, today);
    if (!Array.isArray(movies)) return;

    for (const m of movies) {
      // Determine which release type is today
      const releaseType = m.digitalRelease?.startsWith(today)  ? 'Digital'
        : m.physicalRelease?.startsWith(today) ? 'Physical'
        : m.inCinemas?.startsWith(today)       ? 'Cinema'
        : '';

      const key = `${m.id}-${today}`;
      if (this._firedReleasingKeys.has(key)) continue;
      this._firedReleasingKeys.add(key);

      this.driver.triggerMovieReleasingToday(this, {
        movie:        m.title || '',
        year:         m.year || 0,
        release_type: releaseType,
        studio:       m.studio || '',
        has_file:     m.hasFile || false,
      });
    }
  }

  // --- Autocomplete helpers ---

  getMovieAutocomplete(query) {
    const lq = (query || '').toLowerCase();
    return this._cachedMovies
      .filter((m) => !lq || m.title.toLowerCase().includes(lq))
      .map((m) => ({ id: m.id, name: `${m.title} (${m.year || '?'})` }));
  }

  getMovieIdByTitle(title) {
    if (!title) return null;
    const lq = title.toLowerCase();
    const m = this._cachedMovies.find((m) => m.title.toLowerCase() === lq);
    return m ? m.id : null;
  }

  isMovieMonitored(movieId) {
    if (movieId == null) return false;
    const m = this._cachedMovies.find((m) => m.id === movieId);
    return m ? m.monitored : false;
  }

  // --- Widget data helpers (normalized shape shared with SonarrDevice) ---

  getUpcomingItems(days = 7, count = 20) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    return this._cachedCalendar
      .filter((m) => {
        const rd = m.digitalRelease || m.physicalRelease || m.inCinemas;
        return rd && new Date(rd) <= cutoff;
      })
      .slice(0, count)
      .map((m) => {
        const poster = (m.images || []).find((i) => i.coverType === 'poster');
        const releaseDate = m.digitalRelease || m.physicalRelease || m.inCinemas || '';
        return {
          title:       m.title || '',
          subtitle:    '',
          badge:       m.year ? String(m.year) : '',
          releaseDate,
          hasFile:     m.hasFile || false,
          posterUrl:   poster?.remoteUrl || '',
        };
      });
  }

  async getRecentItems(count = 5) {
    const history = await this._client.getRecentHistory(count * 5);
    const records = (history.records || []).filter(
      (r) => r.eventType === 'downloadFolderImported',
    );

    const seen = new Set();
    const result = [];

    for (const r of records) {
      const movieId = r.movieId;
      const key = movieId != null ? `m${movieId}` : `t${r.sourceTitle}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const movie = r.movie || {};
      const poster = (movie.images || []).find((i) => i.coverType === 'poster');

      result.push({
        title:    movie.title || '',
        subtitle: '',
        badge:    movie.year ? String(movie.year) : '',
        date:     r.date || '',
        quality:  r.quality?.quality?.name || '',
        posterUrl: poster?.remoteUrl || '',
      });

      if (result.length >= count) break;
    }
    return result;
  }

  // --- Flow action handlers ---

  async searchMissing() {
    await this._client.sendCommand('MissingMoviesSearch');
    this.log('Triggered MissingMoviesSearch');
  }

  async searchMovie(movieId) {
    await this._client.sendCommand('MoviesSearch', { movieIds: [movieId] });
    this.log('Triggered MoviesSearch for movieId:', movieId);
  }

  async refreshMovies() {
    await this._client.sendCommand('RefreshMovie');
    this.log('Triggered RefreshMovie');
  }

  async retryFailedDownload(historyId) {
    await this._client.markHistoryFailed(historyId);
    this.log('Marked history', historyId, 'as failed — Radarr will search for alternative');
  }

  async triggerBackup() {
    await this._client.sendCommand('Backup');
    this.log('Triggered Backup');
  }

  async setDownloadClientsEnabled(enabled) {
    const clients = await this._client.getDownloadClients();
    await Promise.all(
      clients.map((c) => this._client.updateDownloadClient(c.id, { ...c, enable: enabled })),
    );
    this.log(`Download clients ${enabled ? 'resumed' : 'paused'}`);
  }

}

module.exports = RadarrDevice;
