'use strict';

const Homey = require('homey');
const { runtimeText, heapText } = require('./lib/diagnostics');

// At most one timeline notification about memory per day, however many warnings Homey sends.
const MEMORY_NOTICE_KEY = 'lastMemoryNotice';
const MEMORY_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // The heap limit differs per Homey model and cannot be looked up anywhere; with this line a
    // diagnostics report states it.
    this.log(`MyApp has been initialized — v${this.homey.manifest.version}, ${runtimeText()}`);

    // Homey sends these before it stops an app for using too much. Nothing can be logged once
    // that happens, so say now what the app was holding.
    this.homey.on('memwarn', (data) => this._onResourceWarning('memory', data));
    this.homey.on('cpuwarn', (data) => this._onResourceWarning('CPU', data));
  }

  _onResourceWarning(kind, data) {
    try {
      const devices = this._devices();
      const libraries = devices.map((device) => device.describeLibrary()).join('; ') || 'no devices';
      const line = `Homey ${kind} warning ${data?.count ?? '?'} of ${data?.limit ?? '?'} — ${heapText()}; ${libraries}`;

      // A single CPU warning some ten seconds after start is the cost of starting up — seen on
      // a healthy run on a Homey Pro (Early 2023) — so it is a log line, not an error.
      if (kind !== 'memory') {
        this.log(line);
        return;
      }
      this.error(line);
      for (const device of devices) device.releaseMemory();
      this._notifyMemoryWarning(data).catch((err) => this.error('Memory notification failed:', err.message));
    } catch (err) {
      // A warning handler that throws would turn a warning into the crash it warns about.
      this.error(`Handling the ${kind} warning failed:`, err.message);
    }
  }

  async _notifyMemoryWarning(data) {
    const last = Number(this.homey.settings.get(MEMORY_NOTICE_KEY)) || 0;
    if (Date.now() - last < MEMORY_NOTICE_INTERVAL_MS) return;
    this.homey.settings.set(MEMORY_NOTICE_KEY, Date.now());
    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('notification.memory_warning', {
        count: data?.count ?? '?',
        limit: data?.limit ?? '?',
      }),
    });
  }

  // Every device of this app that has finished initialising.
  _devices() {
    const devices = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (typeof device.describeLibrary === 'function') devices.push(device);
      }
    }
    return devices;
  }

};
