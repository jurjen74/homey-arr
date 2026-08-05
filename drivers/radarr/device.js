'use strict';

const Homey = require('homey');
const RadarrClient = require('../../lib/RadarrClient');
const { localDate, daysSince, effectiveDate } = require('../../lib/localDate');
const { collectNewHistory } = require('../../lib/historyPager');

const MS_PER_SECOND = 1000;
const CACHE_TTL_MS  = 5 * 60 * 1000; // per-item and list caches live for 5 minutes

// Device-store key for releasing-today dedupe state: { date: 'YYYY-MM-DD', keys: string[] }
const RELEASING_STORE_KEY = 'releasingKeys';

// History paging. A single fixed page silently loses events when a burst exceeds it, so walk
// back until reaching records already handled. Page size stays small because each raw response
// is large; pages are sequential, so peak memory is one page no matter how far this walks.
const HISTORY_PAGE_SIZE = 15;
const HISTORY_MAX_PAGES = 14;

// Cap on the processed-id set. Must stay above HISTORY_PAGE_SIZE * HISTORY_MAX_PAGES, so an id
// dropped by trimming can never come back in a fetch and re-fire.
const SEEN_HISTORY_MAX = 1000;

// An upgrade writes the file-deletion when it commits to replacing, and the import lands once
// the file is actually in place — so the two are adjacent by id but can be far apart in time.
// Measured: Sonarr 1-8 s, Radarr 43-1579 s (median 288 s, max 26 min), because a movie takes far
// longer to move than an episode. At a 60 s poll that means 94% of Radarr upgrades straddle a
// boundary — the deletion is consumed in one batch and the import in a later one — so carrying
// the deletion across polls is the primary mechanism here, not a safety net.
// Sized well above the observed maximum: a 4K remux on slow storage can take longer still.
const UPGRADE_HINT_TTL_MS = 2 * 60 * 60 * 1000;

class RadarrDevice extends Homey.Device {

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

    // Movie tracking — populated silently on first slow poll, triggers fire from second onward
    this._knownMovieIds = null;

    // History tracking — null until first poll (pre-populate without triggering)
    this._seenHistoryIds = null;

    // movieId → timestamp of an 'Upgrade' file deletion, used to mark the import that
    // follows it as a replacement rather than a new item.
    this._upgradeHints = new Map();

    // Releasing-today tracking — {movieId}-{YYYY-MM-DD} so it fires once per movie per day.
    // Restored from the device store so an app restart mid-day does not re-announce every movie
    // that already fired. Stale (previous-day) state is discarded by the date check in
    // _updateUpcoming, so it does not need pruning here.
    const storedReleasing = this.getStoreValue(RELEASING_STORE_KEY);
    this._firedReleasingKeys = new Set(Array.isArray(storedReleasing?.keys) ? storedReleasing.keys : []);
    this._releasingKeyDate = storedReleasing?.date ?? null;

    // Per-item movie cache: id → { data: {id,title,year,monitored,studio,images}, cachedAt }
    this._movieCache = new Map();

    // Slim title-list cache for autocomplete / title-lookup (populated by slow poll or on demand)
    this._movieListCache = null; // { entries: [{id, title, year}], cachedAt }

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

    // Slow poll: movie list for count + triggers. Runs immediately at startup so posters are
    // available on first widget render, then refreshes every 30 minutes.
    this._updateMovies().catch((err) => this.error('Movie refresh failed:', err.message));
    this._slowPollInterval = this.homey.setInterval(
      () => this._updateMovies().catch((err) => this.error('Movie refresh failed:', err.message)),
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

  // --- Per-item movie cache ---

  async _getMovieById(id) {
    if (id == null) return null;
    const entry = this._movieCache.get(id);
    if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) return entry.data;
    try {
      const raw  = await this._client.getMovieById(id);
      const data = {
        id:        raw.id,
        title:     raw.title     || '',
        year:      raw.year      || 0,
        monitored: raw.monitored || false,
        studio:    raw.studio    || '',
        posterUrl: (raw.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '',
      };
      this._movieCache.set(id, { data, cachedAt: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  // Slim title list — used only for autocomplete and title-based lookups.
  async _getMovieList() {
    if (this._movieListCache && Date.now() - this._movieListCache.cachedAt < CACHE_TTL_MS) {
      return this._movieListCache.entries;
    }
    try {
      const entries = await this._client.getMoviesSlim();
      this._movieListCache = { entries, cachedAt: Date.now() };
      return entries;
    } catch {
      return this._movieListCache?.entries || [];
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

  // Slow poll — runs at startup +60 s then every 30 minutes (staggered 30 s after Sonarr).
  // Fetches the full movie list for count + new-movie detection, then discards the bulk data.
  // Also warms the slim title-list cache so autocomplete does not need a separate fetch.
  async _updateMovies() {
    const entries = await this._client.getMoviesSlim();
    if (!Array.isArray(entries)) return;

    await this.setCapabilityValue('radarr_movie_count', entries.length);

    // Already slim — store directly as the list cache.
    this._movieListCache = { entries, cachedAt: Date.now() };

    const currentIds = new Set(entries.map((m) => m.id));

    if (this._knownMovieIds === null) {
      this._knownMovieIds = currentIds;
      return;
    }

    for (const m of entries) {
      if (!this._knownMovieIds.has(m.id)) {
        this.driver.triggerMovieAdded(this, {
          movie:  m.title,
          year:   m.year,
          studio: m.studio,
        });
      }
    }
    this._knownMovieIds = currentIds;
  }

  async _updateUpcoming() {
    const now = new Date();
    const end = new Date(now);
    // UTC arithmetic: setDate()/getDate() work in the host's local zone, so adding days across
    // the host's own DST transition shifts the result by an hour and can move the resulting
    // date by a day. Everything here is compared against UTC instants, so keep it in UTC.
    end.setUTCDate(end.getUTCDate() + 14);

    // Fetch window stays anchored to the UTC date — always at or before the start of the user's
    // local today, so the local-day comparison below never looks for a movie already dropped.
    const utcToday   = now.toISOString().split('T')[0];
    const localToday = localDate(this._timezone(), now);

    const raw = await this._client.getCalendar(utcToday, end.toISOString().split('T')[0]);

    // Slim to only the fields we use — keeps the in-memory calendar lean.
    this._cachedCalendar = Array.isArray(raw) ? raw.map((m) => ({
      id:              m.id,
      title:           m.title           || '',
      year:            m.year            || 0,
      studio:          m.studio          || '',
      hasFile:         m.hasFile         || false,
      digitalRelease:  m.digitalRelease  || '',
      physicalRelease: m.physicalRelease || '',
      inCinemas:       m.inCinemas       || '',
      posterUrl:       (m.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '',
    })) : [];

    const sevenDaysAhead = new Date(now);
    sevenDaysAhead.setUTCDate(now.getUTCDate() + 7);
    const upcomingCount = this._cachedCalendar.filter((m) => {
      const rd = m.digitalRelease || m.physicalRelease || m.inCinemas;
      return rd && new Date(rd) <= sevenDaysAhead;
    }).length;
    await this.setCapabilityValue('radarr_upcoming_count', upcomingCount);

    // Releasing-today trigger — derived from the calendar we just fetched, no second API call.
    // Rolls over at the user's local midnight rather than 00:00 UTC. Unlike Sonarr's airDateUtc,
    // Radarr's release fields are date-only values stamped at midnight UTC, not real instants —
    // converting them to local time would shift a release a day earlier west of UTC. So compare
    // the stored date prefix against the local date instead.
    if (this._releasingKeyDate !== localToday) {
      this._firedReleasingKeys = new Set();
      this._releasingKeyDate   = localToday;
    }

    let fired = false;
    for (const m of this._cachedCalendar) {
      const releaseType = m.digitalRelease?.startsWith(localToday)  ? 'Digital'
        : m.physicalRelease?.startsWith(localToday) ? 'Physical'
        : m.inCinemas?.startsWith(localToday)       ? 'Cinema'
        : '';
      if (!releaseType) continue;

      const key = `${m.id}-${localToday}`;
      if (this._firedReleasingKeys.has(key)) continue;
      this._firedReleasingKeys.add(key);
      fired = true;

      this.driver.triggerMovieReleasingToday(this, {
        movie:        m.title,
        year:         m.year,
        release_type: releaseType,
        studio:       m.studio,
        has_file:     m.hasFile,
      });
    }

    // Persist only on polls that actually fired — a handful per day, not one write per minute.
    // Written after the triggers so a failed write cannot suppress an announcement; the cost is
    // that a crash inside this window re-announces, which is the pre-existing behaviour anyway.
    if (fired) {
      await this.setStoreValue(RELEASING_STORE_KEY, {
        date: localToday,
        keys: [...this._firedReleasingKeys],
      }).catch((err) => this.error('Persisting releasing keys failed:', err.message));
    }
  }

  async _updateHistory() {
    const firstPoll = this._seenHistoryIds === null;
    if (firstPoll) this._seenHistoryIds = new Set();

    // Oldest first, so triggers fire in the order the events actually happened.
    const records = await collectNewHistory({
      fetchPage: (page) => this._client.getRecentHistory(HISTORY_PAGE_SIZE, false, null, page),
      isSeen:    (id) => this._seenHistoryIds.has(id),
      pageSize:  HISTORY_PAGE_SIZE,
      // Nothing is seen yet on the first poll, so paging would walk to the bound for no reason.
      maxPages:  firstPoll ? 1 : HISTORY_MAX_PAGES,
    });

    if (firstPoll) {
      // Treat anything older than 5 minutes as already handled, so a restart does not replay old
      // events while a download that finished just before it still fires.
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      for (const r of records) {
        if (r.date < cutoff) this._seenHistoryIds.add(r.id);
      }
    }

    // Records are oldest-first, so a deletion is registered before the import it precedes.
    const nowMs = Date.now();
    for (const [key, ts] of this._upgradeHints) {
      if (nowMs - ts > UPGRADE_HINT_TTL_MS) this._upgradeHints.delete(key);
    }
    for (const r of records) {
      if (r.eventType === 'movieFileDeleted' && r.data?.reason === 'Upgrade' && r.movieId) {
        this._upgradeHints.set(r.movieId, nowMs);
      }
    }

    for (const record of records) {
      if (this._seenHistoryIds.has(record.id)) continue;
      this._seenHistoryIds.add(record.id);

      const movie = record.movie || {};
      // Deliberately NOT the calendar's digital-first precedence. For "how long has this been
      // available", the right anchor is the most recent date already passed: a film in cinemas
      // with a digital date months out would otherwise report a large negative age, letting a
      // cam rip satisfy a "less than N days" condition.
      const releaseDate = effectiveDate([movie.digitalRelease, movie.physicalRelease, movie.inCinemas]);

      if (record.eventType === 'downloadFolderImported' || record.eventType === 'movieFolderImported') {
        // Consume it: a lingering hint must not mark a later, genuine first import.
        const isUpgrade = this._upgradeHints.delete(record.movieId);

        this.driver.triggerMovieDownloaded(this, {
          movie:              movie.title || '',
          year:               movie.year  || 0,
          quality:            record.quality?.quality?.name || '',
          source_title:       record.sourceTitle || '',
          release_date:       releaseDate,
          days_since_release: daysSince(releaseDate),
          is_upgrade:         isUpgrade,
        });
      }

      if (record.eventType === 'downloadFailed') {
        this.driver.triggerDownloadFailed(this, {
          movie:        movie.title || '',
          year:         movie.year  || 0,
          source_title: record.sourceTitle || '',
          quality:      record.quality?.quality?.name || '',
          message:      record.data?.message || 'Unknown reason',
          history_id:   record.id || 0,
          movie_id:     record.movieId || 0,
        });
      }
    }

    this._trimSeenHistory();
  }

  // --- Autocomplete helpers ---

  async getMovieAutocomplete(query) {
    const lq   = (query || '').toLowerCase();
    const list = await this._getMovieList();
    return list
      .filter((m) => !lq || m.title.toLowerCase().includes(lq))
      .map((m) => ({ id: m.id, name: `${m.title} (${m.year || '?'})` }));
  }

  // Bounded, because the set is only ever consulted against recently fetched records.
  _trimSeenHistory() {
    if (this._seenHistoryIds.size <= SEEN_HISTORY_MAX) return;
    const newest = [...this._seenHistoryIds].sort((a, b) => b - a).slice(0, SEEN_HISTORY_MAX);
    this._seenHistoryIds = new Set(newest);
  }

  async getMovieIdByTitle(title) {
    if (!title) return null;
    const lq   = title.toLowerCase();
    const list = await this._getMovieList();
    const m    = list.find((m) => m.title.toLowerCase() === lq);
    return m ? m.id : null;
  }

  async isMovieMonitored(movieId) {
    if (movieId == null) return false;
    const m = await this._getMovieById(movieId);
    return m ? m.monitored : false;
  }

  // --- Widget data helpers (normalized shape shared with SonarrDevice) ---

  // Calendar response includes full movie data (images, title) — no separate fetch needed.
  getUpcomingItems(days = 7, count = 20) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + days);

    return this._cachedCalendar
      .filter((m) => {
        const rd = m.digitalRelease || m.physicalRelease || m.inCinemas;
        return rd && new Date(rd) <= cutoff;
      })
      .slice(0, count)
      .map((m) => ({
        title:       m.title,
        subtitle:    '',
        badge:       m.year ? String(m.year) : '',
        releaseDate: m.digitalRelease || m.physicalRelease || m.inCinemas || '',
        hasFile:     m.hasFile,
        posterUrl:   m.posterUrl,
      }));
  }

  // History response includes full movie data via RadarrClient's includeMovie:true — no cache needed.
  async getRecentItems(count = 5) {
    const history = await this._client.getRecentHistory(count * 2, false, 3);
    const records = (history.records || []).filter(
      (r) => r.eventType === 'downloadFolderImported',
    );

    const seen   = new Set();
    const result = [];

    for (const r of records) {
      const { movieId } = r;
      const key = movieId != null ? `m${movieId}` : `t${r.sourceTitle}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const movie  = r.movie || {};
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
