'use strict';

function findDevice(homey, deviceId) {
  for (const driverName of ['sonarr', 'radarr']) {
    try {
      const devices = homey.drivers.getDriver(driverName).getDevices();
      if (deviceId) {
        // d.getId() returns the Homey-internal UUID (matches Homey.getDeviceIds() in the widget)
        const found = devices.find((d) => d.getId() === deviceId);
        if (found) return found;
      } else if (devices.length) {
        return devices[0];
      }
    } catch {
      // driver not loaded — skip
    }
  }
  return null;
}

module.exports = {
  async getRecent({ homey, query }) {
    const count       = Math.max(1, Math.min(20, parseInt(query.count, 10) || 5));
    const uniqueTitle = query.uniqueTitle === 'true';
    const deviceId    = query.deviceId || null;

    const device = findDevice(homey, deviceId);
    if (!device) throw new Error('No Arr device found');

    return device.getRecentItems(count, uniqueTitle);
  },
};
