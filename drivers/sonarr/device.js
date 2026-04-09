'use strict';

const Homey = require('homey');
const SonarrClient = require('../../lib/SonarrClient');

const MS_PER_SECOND = 1000;

class SonarrDevice extends Homey.Device {

  async onInit() {
    this._client = this._buildClient();
    this._pollTimer = null;

    // Health tracking
    this._previousStatus = null;

    // Disk tracking
    this._previousDiskFreeGb = null;

    // Queue tracking
    this._previousQueueCount = null;

    // Series tracking — populated silently on first poll, triggers fire from second poll onward
    this._knownSeriesIds = null;

    // History tracking — events seen since app start; reset daily
    this._lastHistoryPoll = new Date().toISOString();
    this._seenHistoryIds = new Set();

    // Airing-today tracking — {episodeId}-{YYYY-MM-DD} so it fires once per episode per day
    this._firedAiringKeys = new Set();
    this._airingKeyDate = null; // date string of when the set was last reset

    // Series cache for autocomplete
    this._cachedSeries = [];

    await this.driver.ready();
    this._startPolling();
    this.log('SonarrDevice initialized:', this.getName());
  }

  async onSettings({ newSettings }) {
    this._client = new SonarrClient(newSettings.host, newSettings.apiKey);
    this._restartPolling();
  }

  async onDeleted() {
    this._stopPolling();
  }

  // --- Polling ---

  _buildClient() {
    const { host, apiKey } = this.getSettings();
    return new SonarrClient(host, apiKey);
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
        this._updateSeries(),
        this._updateUpcoming(),
        this._updateHistory(),
        this._updateAiringToday(),
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

    await this.setCapabilityValue('sonarr_status', status);

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

    await this.setCapabilityValue('sonarr_disk_free_gb', freeGb);

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

    await this.setCapabilityValue('sonarr_queue_count', count);

    if (this._previousQueueCount !== null && this._previousQueueCount > 0 && count === 0) {
      this.driver.triggerQueueEmpty(this);
    }
    this._previousQueueCount = count;
  }

  async _updateMissing() {
    const missing = await this._client.getWantedMissing();
    await this.setCapabilityValue('sonarr_missing_count', missing.totalRecords || 0);
  }

  async _updateSeries() {
    const series = await this._client.getSeries();
    if (!Array.isArray(series)) return;

    await this.setCapabilityValue('sonarr_series_count', series.length);

    // Refresh autocomplete cache
    this._cachedSeries = series;

    const currentIds = new Set(series.map((s) => s.id));

    if (this._knownSeriesIds === null) {
      // First poll — populate silently, no triggers
      this._knownSeriesIds = currentIds;
      return;
    }

    for (const s of series) {
      if (!this._knownSeriesIds.has(s.id)) {
        this.driver.triggerSeriesAdded(this, {
          series:  s.title,
          network: s.network || '',
          year:    s.year || 0,
        });
      }
    }
    this._knownSeriesIds = currentIds;
  }

  async _updateUpcoming() {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 7);

    const episodes = await this._client.getCalendar(
      now.toISOString().split('T')[0],
      end.toISOString().split('T')[0],
    );
    await this.setCapabilityValue('sonarr_upcoming_count', Array.isArray(episodes) ? episodes.length : 0);
  }

  async _updateHistory() {
    const since = this._lastHistoryPoll;
    this._lastHistoryPoll = new Date().toISOString();

    const records = await this._client.getHistorySince(since);
    if (!Array.isArray(records)) return;

    for (const record of records) {
      if (this._seenHistoryIds.has(record.id)) continue;
      this._seenHistoryIds.add(record.id);

      if (record.eventType === 'downloadFolderImported') {
        this.driver.triggerEpisodeDownloaded(this, {
          series:         record.series?.title || '',
          episode:        record.episode?.title || '',
          season_number:  record.episode?.seasonNumber || 0,
          episode_number: record.episode?.episodeNumber || 0,
          quality:        record.quality?.quality?.name || '',
          source_title:   record.sourceTitle || '',
        });
      }

      if (record.eventType === 'downloadFailed') {
        this.driver.triggerDownloadFailed(this, {
          series:         record.series?.title || '',
          episode:        record.episode?.title || '',
          season_number:  record.episode?.seasonNumber || 0,
          episode_number: record.episode?.episodeNumber || 0,
          source_title:   record.sourceTitle || '',
          quality:        record.quality?.quality?.name || '',
          message:        record.data?.message || 'Unknown reason',
          history_id:     record.id || 0,
          episode_id:     record.episodeId || 0,
        });
      }
    }
  }

  async _updateAiringToday() {
    const today = new Date().toISOString().split('T')[0];

    // Reset fired set when the date rolls over
    if (this._airingKeyDate !== today) {
      this._firedAiringKeys = new Set();
      this._airingKeyDate = today;
    }

    const episodes = await this._client.getCalendar(today, today);
    if (!Array.isArray(episodes)) return;

    for (const ep of episodes) {
      const key = `${ep.id}-${today}`;
      if (this._firedAiringKeys.has(key)) continue;
      this._firedAiringKeys.add(key);

      this.driver.triggerEpisodeAiring(this, {
        series:         ep.series?.title || '',
        episode:        ep.title || '',
        season_number:  ep.seasonNumber || 0,
        episode_number: ep.episodeNumber || 0,
        air_time:       ep.airDateUtc || today,
        network:        ep.series?.network || '',
        runtime:        ep.series?.runtime || ep.runtime || 0,
        has_file:       ep.hasFile || false,
      });
    }
  }

  // --- Autocomplete helpers ---

  getSeriesAutocomplete(query) {
    const lq = (query || '').toLowerCase();
    return this._cachedSeries
      .filter((s) => !lq || s.title.toLowerCase().includes(lq))
      .map((s) => ({ id: s.id, name: s.title }));
  }

  // Used when a string tag (e.g. from series_added trigger) is used instead of autocomplete
  getSeriesIdByTitle(title) {
    if (!title) return null;
    const lq = title.toLowerCase();
    const s = this._cachedSeries.find((s) => s.title.toLowerCase() === lq);
    return s ? s.id : null;
  }

  isSeriesMonitored(seriesId) {
    if (seriesId == null) return false;
    const s = this._cachedSeries.find((s) => s.id === seriesId);
    return s ? s.monitored : false;
  }

  // --- Flow action handlers ---

  async retryFailedDownload(historyId) {
    await this._client.markHistoryFailed(historyId);
    this.log('Marked history', historyId, 'as failed — Sonarr will search for alternative');
  }

  async searchEpisode(episodeId) {
    await this._client.sendCommand('EpisodeSearch', { episodeIds: [episodeId] });
    this.log('Triggered EpisodeSearch for episodeId:', episodeId);
  }

  async searchMissing() {
    await this._client.sendCommand('MissingEpisodeSearch');
    this.log('Triggered MissingEpisodeSearch');
  }

  async searchSeries(seriesId) {
    await this._client.sendCommand('SeriesSearch', { seriesId });
    this.log('Triggered SeriesSearch for seriesId:', seriesId);
  }

  async refreshSeries() {
    await this._client.sendCommand('RefreshSeries');
    this.log('Triggered RefreshSeries');
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

module.exports = SonarrDevice;
