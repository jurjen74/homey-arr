'use strict';

const Homey = require('homey');
const SonarrClient = require('../../lib/SonarrClient');

const DISK_LOW_THRESHOLD_GB = 10;

class SonarrDriver extends Homey.Driver {

  async onInit() {
    // --- Triggers ---
    this._triggerHealthChanged     = this.homey.flow.getDeviceTriggerCard('health_changed');
    this._triggerHealthResolved    = this.homey.flow.getDeviceTriggerCard('health_resolved');
    this._triggerEpisodeDownloaded = this.homey.flow.getDeviceTriggerCard('episode_downloaded');
    this._triggerDownloadFailed    = this.homey.flow.getDeviceTriggerCard('download_failed');
    this._triggerQueueEmpty        = this.homey.flow.getDeviceTriggerCard('queue_became_empty');
    this._triggerSeriesAdded       = this.homey.flow.getDeviceTriggerCard('series_added');
    this._triggerEpisodeAiring     = this.homey.flow.getDeviceTriggerCard('episode_airing_today');
    this._triggerDiskSpaceLow      = this.homey.flow.getDeviceTriggerCard('disk_space_low');

    // --- Conditions ---
    this.homey.flow
      .getConditionCard('is_healthy')
      .registerRunListener((args) => args.device.getCapabilityValue('alarm_generic') === false);

    this.homey.flow
      .getConditionCard('queue_is_empty')
      .registerRunListener((args) => args.device.getCapabilityValue('sonarr_queue_count') === 0);

    this.homey.flow
      .getConditionCard('disk_space_below')
      .registerRunListener((args) => {
        const freeGb = args.device.getCapabilityValue('sonarr_disk_free_gb') || 0;
        return freeGb < args.threshold;
      });

    this.homey.flow
      .getConditionCard('series_is_monitored')
      .registerRunListener((args) => args.device.isSeriesMonitored(args.series.id))
      .registerArgumentAutocompleteListener('series', (query, args) =>
        args.device.getSeriesAutocomplete(query),
      );

    this.homey.flow
      .getConditionCard('series_is_monitored_by_name')
      .registerRunListener((args) => {
        if (!args.droptoken) return false;
        const id = args.device.getSeriesIdByTitle(args.droptoken);
        return args.device.isSeriesMonitored(id);
      });

    // --- Actions ---
    this.homey.flow
      .getActionCard('search_missing')
      .registerRunListener((args) => args.device.searchMissing());

    this.homey.flow
      .getActionCard('search_series')
      .registerRunListener((args) => args.device.searchSeries(args.series.id))
      .registerArgumentAutocompleteListener('series', (query, args) =>
        args.device.getSeriesAutocomplete(query),
      );

    this.homey.flow
      .getActionCard('search_series_by_name')
      .registerRunListener(async (args) => {
        if (!args.droptoken) throw new Error('No series name provided');
        const id = args.device.getSeriesIdByTitle(args.droptoken);
        if (id == null) throw new Error(`Series not found: ${args.droptoken}`);
        return args.device.searchSeries(id);
      });

    this.homey.flow
      .getActionCard('retry_failed_download')
      .registerRunListener((args) => args.device.retryFailedDownload(args.droptoken));

    this.homey.flow
      .getActionCard('search_episode')
      .registerRunListener((args) => args.device.searchEpisode(args.droptoken));

    this.homey.flow
      .getActionCard('refresh_series')
      .registerRunListener((args) => args.device.refreshSeries());

    this.homey.flow
      .getActionCard('trigger_backup')
      .registerRunListener((args) => args.device.triggerBackup());

    this.homey.flow
      .getActionCard('pause_downloads')
      .registerRunListener((args) => args.device.setDownloadClientsEnabled(false));

    this.homey.flow
      .getActionCard('resume_downloads')
      .registerRunListener((args) => args.device.setDownloadClientsEnabled(true));

    this.log('SonarrDriver has been initialized');
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

      const client = new SonarrClient(host, apiKey);
      serverStatus = await client.getSystemStatus();

      return {
        appName: serverStatus.appName,
        version: serverStatus.version,
      };
    });

    session.setHandler('list_devices', async () => {
      if (!serverStatus) {
        const client = new SonarrClient(host, apiKey);
        serverStatus = await client.getSystemStatus();
      }

      return [
        {
          name: `Sonarr (${serverStatus.appName || host})`,
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

  triggerEpisodeDownloaded(device, tokens) {
    this._triggerEpisodeDownloaded.trigger(device, tokens).catch(this.error);
  }

  triggerDownloadFailed(device, tokens) {
    this._triggerDownloadFailed.trigger(device, tokens).catch(this.error);
  }

  triggerQueueEmpty(device) {
    this._triggerQueueEmpty.trigger(device, {}).catch(this.error);
  }

  triggerSeriesAdded(device, tokens) {
    this._triggerSeriesAdded.trigger(device, tokens).catch(this.error);
  }

  triggerEpisodeAiring(device, tokens) {
    this._triggerEpisodeAiring.trigger(device, tokens).catch(this.error);
  }

  triggerDiskSpaceLow(device, freeGb) {
    this._triggerDiskSpaceLow.trigger(device, { free_gb: freeGb }).catch(this.error);
  }

  get diskLowThreshold() {
    return DISK_LOW_THRESHOLD_GB;
  }

}

module.exports = SonarrDriver;
