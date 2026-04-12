'use strict';

const Homey = require('homey');
const RadarrClient = require('../../lib/RadarrClient');

const DISK_LOW_THRESHOLD_GB = 10;

class RadarrDriver extends Homey.Driver {

  async onInit() {
    // --- Triggers ---
    this._triggerHealthChanged     = this.homey.flow.getDeviceTriggerCard('radarr_health_changed');
    this._triggerHealthResolved    = this.homey.flow.getDeviceTriggerCard('radarr_health_resolved');
    this._triggerMovieDownloaded   = this.homey.flow.getDeviceTriggerCard('movie_downloaded');
    this._triggerDownloadFailed    = this.homey.flow.getDeviceTriggerCard('radarr_download_failed');
    this._triggerQueueEmpty        = this.homey.flow.getDeviceTriggerCard('radarr_queue_became_empty');
    this._triggerMovieAdded        = this.homey.flow.getDeviceTriggerCard('movie_added');
    this._triggerMovieReleasing    = this.homey.flow.getDeviceTriggerCard('movie_releasing_today');
    this._triggerDiskSpaceLow      = this.homey.flow.getDeviceTriggerCard('radarr_disk_space_low');

    // --- Conditions ---
    this.homey.flow
      .getConditionCard('radarr_is_healthy')
      .registerRunListener((args) => args.device.getCapabilityValue('alarm_generic') === false);

    this.homey.flow
      .getConditionCard('radarr_queue_is_empty')
      .registerRunListener((args) => args.device.getCapabilityValue('radarr_queue_count') === 0);

    this.homey.flow
      .getConditionCard('radarr_disk_space_below')
      .registerRunListener((args) => {
        const freeGb = args.device.getCapabilityValue('radarr_disk_free_gb') || 0;
        return freeGb < args.threshold;
      });

    this.homey.flow
      .getConditionCard('movie_is_monitored')
      .registerRunListener((args) => args.device.isMovieMonitored(args.movie.id))
      .registerArgumentAutocompleteListener('movie', (query, args) =>
        args.device.getMovieAutocomplete(query),
      );

    this.homey.flow
      .getConditionCard('movie_is_monitored_by_name')
      .registerRunListener((args) => {
        if (!args.droptoken) return false;
        const id = args.device.getMovieIdByTitle(args.droptoken);
        return args.device.isMovieMonitored(id);
      });

    // --- Actions ---
    this.homey.flow
      .getActionCard('radarr_search_missing')
      .registerRunListener((args) => args.device.searchMissing());

    this.homey.flow
      .getActionCard('search_movie')
      .registerRunListener((args) => args.device.searchMovie(args.movie.id))
      .registerArgumentAutocompleteListener('movie', (query, args) =>
        args.device.getMovieAutocomplete(query),
      );

    this.homey.flow
      .getActionCard('search_movie_by_name')
      .registerRunListener(async (args) => {
        if (!args.droptoken) throw new Error('No movie name provided');
        const id = args.device.getMovieIdByTitle(args.droptoken);
        if (id == null) throw new Error(`Movie not found: ${args.droptoken}`);
        return args.device.searchMovie(id);
      });

    this.homey.flow
      .getActionCard('radarr_retry_failed_download')
      .registerRunListener((args) => args.device.retryFailedDownload(args.droptoken));

    this.homey.flow
      .getActionCard('refresh_movies')
      .registerRunListener((args) => args.device.refreshMovies());

    this.homey.flow
      .getActionCard('radarr_trigger_backup')
      .registerRunListener((args) => args.device.triggerBackup());

    this.homey.flow
      .getActionCard('radarr_pause_downloads')
      .registerRunListener((args) => args.device.setDownloadClientsEnabled(false));

    this.homey.flow
      .getActionCard('radarr_resume_downloads')
      .registerRunListener((args) => args.device.setDownloadClientsEnabled(true));

    this.log('RadarrDriver has been initialized');
  }

  async onPair(session) {
    let host = '';
    let apiKey = '';
    let serverStatus = null;

    session.setHandler('test_connection', async ({ host: rawHost, apiKey: rawKey }) => {
      host = rawHost.trim().replace(/\/$/, '');
      apiKey = rawKey.trim();

      if (!host) throw new Error('Host URL is required');
      if (!apiKey) throw new Error('API key is required');

      const client = new RadarrClient(host, apiKey);
      serverStatus = await client.getSystemStatus();

      return {
        appName: serverStatus.appName,
        version: serverStatus.version,
      };
    });

    session.setHandler('list_devices', async () => {
      if (!serverStatus) {
        const client = new RadarrClient(host, apiKey);
        serverStatus = await client.getSystemStatus();
      }

      return [
        {
          name: `Radarr (${serverStatus.appName || host})`,
          data: {
            id: serverStatus.instanceName || serverStatus.urlBase || host,
          },
          settings: {
            host,
            apiKey,
            pollInterval: 60,
          },
        },
      ];
    });
  }

  // --- Flow trigger helpers (called from device.js) ---

  triggerHealthChanged(device, tokens) {
    this._triggerHealthChanged.trigger(device, tokens).catch(this.error);
  }

  triggerHealthResolved(device) {
    this._triggerHealthResolved.trigger(device, {}).catch(this.error);
  }

  triggerMovieDownloaded(device, tokens) {
    this._triggerMovieDownloaded.trigger(device, tokens).catch(this.error);
  }

  triggerDownloadFailed(device, tokens) {
    this._triggerDownloadFailed.trigger(device, tokens).catch(this.error);
  }

  triggerQueueEmpty(device) {
    this._triggerQueueEmpty.trigger(device, {}).catch(this.error);
  }

  triggerMovieAdded(device, tokens) {
    this._triggerMovieAdded.trigger(device, tokens).catch(this.error);
  }

  triggerMovieReleasingToday(device, tokens) {
    this._triggerMovieReleasing.trigger(device, tokens).catch(this.error);
  }

  triggerDiskSpaceLow(device, freeGb) {
    this._triggerDiskSpaceLow.trigger(device, { free_gb: freeGb }).catch(this.error);
  }

  get diskLowThreshold() {
    return DISK_LOW_THRESHOLD_GB;
  }

}

module.exports = RadarrDriver;
