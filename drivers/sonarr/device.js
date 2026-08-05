'use strict';

const Homey = require('homey');
const SonarrClient = require('../../lib/SonarrClient');
const { localDate, daysSince } = require('../../lib/localDate');

const MS_PER_SECOND = 1000;
const CACHE_TTL_MS  = 5 * 60 * 1000; // per-item and list caches live for 5 minutes

// Device-store key for airing-today dedupe state: { date: 'YYYY-MM-DD', keys: string[] }
const AIRING_STORE_KEY = 'airingKeys';

// Upper bound on the on-demand episode cache. Comfortably above a single bulk-import burst.
const EPISODE_CACHE_MAX = 250;

class SonarrDevice extends Homey.Device {

  async onInit() {
    this._client = this._buildClient();
    this._pollTimer        = null;
    this._slowPollInterval = null;

    // Health tracking
    this._previousStatus = null;

    // Disk tracking
    this._previousDiskFreeGb = null;

    // Queue tracking
    this._previousQueueCount = null;

    // Series tracking — populated silently on first slow poll, triggers fire from second onward
    this._knownSeriesIds = null;

    // History tracking — null until first poll (pre-populate without triggering)
    this._seenHistoryIds = null;

    // Airing-today tracking — {episodeId}-{YYYY-MM-DD} so it fires once per episode per day.
    // Restored from the device store so an app restart mid-day does not re-announce every
    // episode that already fired. Stale (previous-day) state is discarded by the date check
    // in _updateUpcoming, so it does not need pruning here.
    const storedAiring = this.getStoreValue(AIRING_STORE_KEY);
    this._firedAiringKeys = new Set(Array.isArray(storedAiring?.keys) ? storedAiring.keys : []);
    this._airingKeyDate = storedAiring?.date ?? null;

    // Per-item series cache: id → { data: {id,title,monitored,year,network,posterUrl}, cachedAt }
    this._seriesCache = new Map();

    // Per-item episode cache: id → { data: {id,title,airDateUtc,seasonNumber,episodeNumber}, cachedAt }
    this._episodeCache = new Map();

    // Slim title-list cache for autocomplete / title-lookup (populated by slow poll or on demand)
    this._seriesListCache = null; // { entries: [{id, title, network, year, posterUrl}], cachedAt }

    // seriesId → posterUrl, populated by slow poll — used as fallback when the calendar's
    // embedded series object doesn't include images (varies by Sonarr version).
    this._seriesPosterUrls = null;

    // Calendar cache for widget
    this._cachedCalendar = [];

    // Capability migration: add alarm_generic, remove legacy sonarr_status
    if (!this.hasCapability('alarm_generic')) {
      await this.addCapability('alarm_generic');
    }
    if (this.hasCapability('sonarr_status')) {
      await this.removeCapability('sonarr_status');
    }

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

  // The user's IANA zone, as configured on the Homey itself. Guarded so a missing clock manager
  // degrades to UTC instead of breaking the poll — but log it once, because that fallback
  // silently restores the 00:00-UTC firing this whole date path exists to avoid.
  _timezone() {
    try {
      return this.homey.clock.getTimezone();
    } catch (err) {
      if (!this._timezoneWarned) {
        this._timezoneWarned = true;
        this.error('Timezone unavailable — "today" falls back to UTC:', err.message);
      }
      return '';
    }
  }

  _startPolling() {
    const intervalSec = this.getSetting('pollInterval') || 60;
    this._poll().catch((err) => this.error('Initial poll failed:', err.message));
    this._pollTimer = this.homey.setInterval(() => this._poll(), intervalSec * MS_PER_SECOND);

    // Slow poll: series list for count + triggers. Runs immediately at startup so posters are
    // available on first widget render, then refreshes every 30 minutes.
    this._updateSeries().catch((err) => this.error('Series refresh failed:', err.message));
    this._slowPollInterval = this.homey.setInterval(
      () => this._updateSeries().catch((err) => this.error('Series refresh failed:', err.message)),
      30 * 60 * MS_PER_SECOND,
    );
  }

  _stopPolling() {
    if (this._pollTimer)        { this.homey.clearInterval(this._pollTimer);        this._pollTimer = null; }
    if (this._slowPollInterval) { this.homey.clearInterval(this._slowPollInterval); this._slowPollInterval = null; }
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
        this._updateUpcoming(),
        this._updateHistory(),
      ]);

      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      this.error('Poll failed:', err.message);
      await this.setUnavailable(err.message);
    }
  }

  // --- Per-item series cache ---

  async _getSeriesById(id) {
    if (id == null) return null;
    const entry = this._seriesCache.get(id);
    if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) return entry.data;
    try {
      const raw  = await this._client.getSeriesById(id);
      const data = {
        id:        raw.id,
        title:     raw.title     || '',
        monitored: raw.monitored || false,
        year:      raw.year      || 0,
        network:   raw.network   || '',
        posterUrl: (raw.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '',
      };
      this._seriesCache.set(id, { data, cachedAt: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  // Fetched on demand when a download/failure trigger fires, so the tokens do not depend on
  // whether /api/v3/history embeds the episode object. Bounded, unlike the series cache: a
  // library has tens of series but thousands of episodes, and a bulk import touches many at once.
  async _getEpisodeById(id) {
    if (!id) return null;
    const entry = this._episodeCache.get(id);
    if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) return entry.data;
    try {
      const raw  = await this._client.getEpisodeById(id);
      const data = {
        id:            raw.id,
        title:         raw.title      || '',
        airDateUtc:    raw.airDateUtc || '',
        // Left undefined rather than defaulted, so the caller can tell "absent" from season 0.
        seasonNumber:  raw.seasonNumber,
        episodeNumber: raw.episodeNumber,
      };
      if (this._episodeCache.size >= EPISODE_CACHE_MAX) this._pruneEpisodeCache();
      this._episodeCache.set(id, { data, cachedAt: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  // Drop expired entries; if that frees nothing (a burst filled the cache inside one TTL),
  // clear outright rather than let it grow without bound.
  _pruneEpisodeCache() {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key, entry] of this._episodeCache) {
      if (entry.cachedAt < cutoff) this._episodeCache.delete(key);
    }
    if (this._episodeCache.size >= EPISODE_CACHE_MAX) this._episodeCache.clear();
  }

  // Slim title list — used only for autocomplete and title-based lookups.
  async _getSeriesList() {
    if (this._seriesListCache && Date.now() - this._seriesListCache.cachedAt < CACHE_TTL_MS) {
      return this._seriesListCache.entries;
    }
    try {
      const entries = await this._client.getSeriesSlim();
      this._seriesListCache = { entries, cachedAt: Date.now() };
      return entries;
    } catch {
      return this._seriesListCache?.entries || [];
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

  // Slow poll — runs at startup +30 s then every 30 minutes.
  // Fetches the full series list for count + new-series detection, then discards the bulk data.
  // Also warms the slim title-list cache so autocomplete does not need a separate fetch.
  async _updateSeries() {
    const entries = await this._client.getSeriesSlim();
    if (!Array.isArray(entries)) return;

    await this.setCapabilityValue('sonarr_series_count', entries.length);

    // Already slim — store directly as the list cache and build the poster lookup map.
    this._seriesListCache  = { entries, cachedAt: Date.now() };
    this._seriesPosterUrls = new Map(entries.map((s) => [s.id, s.posterUrl]));

    const currentIds = new Set(entries.map((s) => s.id));

    if (this._knownSeriesIds === null) {
      this._knownSeriesIds = currentIds;
      return;
    }

    for (const s of entries) {
      if (!this._knownSeriesIds.has(s.id)) {
        this.driver.triggerSeriesAdded(this, {
          series:  s.title,
          network: s.network,
          year:    s.year,
        });
      }
    }
    this._knownSeriesIds = currentIds;
  }

  async _updateUpcoming() {
    const now = new Date();
    const end = new Date(now);
    // UTC arithmetic: setDate()/getDate() work in the host's local zone, so adding days across
    // the host's own DST transition shifts the result by an hour and can move the resulting
    // date by a day. Everything here is compared against UTC instants, so keep it in UTC.
    end.setUTCDate(end.getUTCDate() + 14);

    // Fetch window stays anchored to the UTC date. It is always at or before the start of the
    // user's local today, in every offset, so the local-day comparison below never looks for an
    // episode the window has already dropped.
    const utcToday   = now.toISOString().split('T')[0];
    const timezone   = this._timezone();
    const localToday = localDate(timezone, now);

    const raw = await this._client.getCalendar(utcToday, end.toISOString().split('T')[0]);

    // Slim to only the fields we use — keeps the in-memory calendar lean.
    this._cachedCalendar = Array.isArray(raw) ? raw.map((ep) => ({
      id:            ep.id,
      seriesId:      ep.seriesId      || 0,
      airDateUtc:    ep.airDateUtc    || '',
      title:         ep.title         || '',
      seasonNumber:  ep.seasonNumber  || 0,
      episodeNumber: ep.episodeNumber || 0,
      hasFile:       ep.hasFile       || false,
      runtime:       ep.runtime       || 0,
      series: {
        title:     ep.series?.title   || '',
        network:   ep.series?.network || '',
        runtime:   ep.series?.runtime || 0,
        // Try calendar's embedded series images — may be absent depending on Sonarr version.
        // getUpcomingItems() falls back to _seriesPosterUrls at read time so the widget gets
        // posters as soon as the slow poll finishes, without waiting for the calendar to refresh.
        posterUrl: (ep.series?.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '',
      },
    })) : [];

    const sevenDaysAhead = new Date(now);
    sevenDaysAhead.setUTCDate(now.getUTCDate() + 7);
    const upcomingCount = this._cachedCalendar.filter(
      (ep) => ep.airDateUtc && new Date(ep.airDateUtc) <= sevenDaysAhead,
    ).length;
    await this.setCapabilityValue('sonarr_upcoming_count', upcomingCount);

    // Airing-today trigger — derived from the calendar we just fetched, no second API call.
    // "Today" is the user's local day, so the card fires at their own midnight rather than at
    // 00:00 UTC (which lands at 01:00/02:00 local in CET/CEST, and on the previous evening in
    // the Americas). airDateUtc is a real broadcast instant, so it converts to local time.
    if (this._airingKeyDate !== localToday) {
      this._firedAiringKeys = new Set();
      this._airingKeyDate   = localToday;
    }

    let fired = false;
    for (const ep of this._cachedCalendar) {
      if (!ep.airDateUtc) continue;
      if (localDate(timezone, new Date(ep.airDateUtc)) !== localToday) continue;
      const key = `${ep.id}-${localToday}`;
      if (this._firedAiringKeys.has(key)) continue;
      this._firedAiringKeys.add(key);
      fired = true;

      this.driver.triggerEpisodeAiring(this, {
        series:         ep.series.title,
        episode:        ep.title,
        season_number:  ep.seasonNumber,
        episode_number: ep.episodeNumber,
        air_time:       ep.airDateUtc,
        network:        ep.series.network,
        runtime:        ep.series.runtime || ep.runtime,
        has_file:       ep.hasFile,
      });
    }

    // Persist only on polls that actually fired — a handful per day, not one write per minute.
    // Written after the triggers so a failed write cannot suppress an announcement; the cost is
    // that a crash inside this window re-announces, which is the pre-existing behaviour anyway.
    if (fired) {
      await this.setStoreValue(AIRING_STORE_KEY, {
        date: localToday,
        keys: [...this._firedAiringKeys],
      }).catch((err) => this.error('Persisting airing keys failed:', err.message));
    }
  }

  async _updateHistory() {
    const history = await this._client.getRecentHistorySlim(15);
    const records = Array.isArray(history?.records) ? history.records : [];

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

      const series  = await this._getSeriesById(record.seriesId);
      const seMatch = (record.sourceTitle || '').match(/[Ss](\d+)[Ee](\d+)/);
      const episode = (await this._getEpisodeById(record.episodeId)) || {};

      // Prefer Sonarr's own numbering over the release-name regex, which yields 0 for
      // daily-dated and absolute-numbered releases. `??` rather than `||` so season 0
      // (specials) is kept instead of falling through to the regex.
      const seasonNumber  = episode.seasonNumber  ?? (seMatch ? parseInt(seMatch[1], 10) : 0);
      const episodeNumber = episode.episodeNumber ?? (seMatch ? parseInt(seMatch[2], 10) : 0);

      if (record.eventType === 'downloadFolderImported' || record.eventType === 'seriesFolderImported') {
        this.driver.triggerEpisodeDownloaded(this, {
          series:         series?.title || '',
          episode:        episode.title || '',
          season_number:  seasonNumber,
          episode_number: episodeNumber,
          quality:        record.quality?.quality?.name || '',
          source_title:   record.sourceTitle || '',
          air_date:       episode.airDateUtc || '',
          days_since_air: daysSince(episode.airDateUtc),
        });
      }

      if (record.eventType === 'downloadFailed') {
        this.driver.triggerDownloadFailed(this, {
          series:         series?.title || '',
          episode:        episode.title || '',
          season_number:  seasonNumber,
          episode_number: episodeNumber,
          source_title:   record.sourceTitle || '',
          quality:        record.quality?.quality?.name || '',
          message:        record.data?.message || 'Unknown reason',
          history_id:     record.id || 0,
          episode_id:     record.episodeId || 0,
        });
      }
    }
  }

  // --- Autocomplete helpers ---

  async getSeriesAutocomplete(query) {
    const lq   = (query || '').toLowerCase();
    const list = await this._getSeriesList();
    return list
      .filter((s) => !lq || s.title.toLowerCase().includes(lq))
      .map((s) => ({ id: s.id, name: s.title }));
  }

  async getSeriesIdByTitle(title) {
    if (!title) return null;
    const lq   = title.toLowerCase();
    const list = await this._getSeriesList();
    const s    = list.find((s) => s.title.toLowerCase() === lq);
    return s ? s.id : null;
  }

  async isSeriesMonitored(seriesId) {
    if (seriesId == null) return false;
    const s = await this._getSeriesById(seriesId);
    return s ? s.monitored : false;
  }

  // --- Widget data helpers ---

  // Normalized shape consumed by the shared arr-upcoming widget.
  // Uses ep.series.images from the calendar response — no separate series fetch needed.
  getUpcomingItems(days = 7, count = 20) {
    const pad = (n) => String(n).padStart(2, '0');
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + days);
    return this._cachedCalendar
      .filter((ep) => ep.airDateUtc && new Date(ep.airDateUtc) <= cutoff)
      .slice(0, count)
      .map((ep) => ({
        title:       ep.series.title,
        subtitle:    ep.title,
        badge:       `S${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}`,
        releaseDate: ep.airDateUtc,
        hasFile:     ep.hasFile,
        posterUrl:   ep.series.posterUrl || this._seriesPosterUrls?.get(ep.seriesId) || '',
      }));
  }

  // Legacy — kept for backward compatibility; prefer getUpcomingItems().
  getUpcomingEpisodes(days = 7, count = 20) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + days);
    return this._cachedCalendar
      .filter((ep) => ep.airDateUtc && new Date(ep.airDateUtc) <= cutoff)
      .slice(0, count)
      .map((ep) => ({
        series:    ep.series.title,
        title:     ep.title,
        season:    ep.seasonNumber,
        episode:   ep.episodeNumber,
        airDate:   ep.airDateUtc,
        hasFile:   ep.hasFile,
        network:   ep.series.network,
        posterUrl: ep.series.posterUrl || this._seriesPosterUrls?.get(ep.seriesId) || '',
      }));
  }

  // Normalized shape consumed by the shared arr-recent widget.
  async getRecentItems(count = 5, uniqueSeries = false) {
    const pad = (n) => String(n).padStart(2, '0');
    const episodes = await this.getRecentEpisodes(count, uniqueSeries);
    return episodes.map((ep) => ({
      title:    ep.series,
      subtitle: ep.title,
      badge:    (ep.season || ep.episode) ? `S${pad(ep.season)}E${pad(ep.episode)}` : '',
      date:     ep.date,
      quality:  ep.quality,
      posterUrl: ep.posterUrl,
    }));
  }

  async getRecentEpisodes(count = 5, uniqueSeries = false) {
    // includeSeries embeds the series object (title, images) in each record so we never
    // need to fetch the full series library for the widget.
    const history = await this._client.getRecentHistoryWithSeries(
      uniqueSeries ? 500 : count * 2,
      3, // eventType 3 = downloadFolderImported
    );
    const records = (history.records || []).filter(
      (r) => r.eventType === 'downloadFolderImported',
    );

    const seen       = new Set();
    const seenSeries = new Set();
    const result     = [];

    for (const r of records) {
      const { seriesId } = r;
      const key = r.episodeId != null ? `e${r.episodeId}` : `s${seriesId}-${r.sourceTitle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (uniqueSeries && seriesId != null) {
        if (seenSeries.has(seriesId)) continue;
        seenSeries.add(seriesId);
      }

      const series = r.series || {};

      const seMatch = (r.sourceTitle || '').match(/[Ss](\d+)[Ee](\d+)/);
      const season  = seMatch ? parseInt(seMatch[1], 10) : 0;
      const episode = seMatch ? parseInt(seMatch[2], 10) : 0;

      let title = '';
      if (r.data?.importedPath) {
        const filename   = r.data.importedPath.split(/[\\/]/).pop() || '';
        const titleMatch = filename.match(/[Ss]\d+[Ee]\d+\s*-\s*(.+?)(?:\s+(?:WEBDL|WEBRip|BluRay|HDTV|AMZN|DSNP|NF|\d{3,4}p|x264|x265|H\.?264|H\.?265|HEVC))/i);
        title = titleMatch ? titleMatch[1].trim() : '';
      }

      result.push({
        series:    series.title || '',
        title,
        season,
        episode,
        date:      r.date || '',
        quality:   r.quality?.quality?.name || '',
        posterUrl: series.posterUrl || '',
      });
      if (result.length >= count) break;
    }
    return result;
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
