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
  async getUpcoming({ homey, query }) {
    const days     = Math.max(1, Math.min(14, parseInt(query.days,     10) || 7));
    const count    = Math.max(1, Math.min(20, parseInt(query.count,    10) || 5));
    const deviceId = query.deviceId || null;

    const device = findDevice(homey, deviceId);
    if (!device) throw new Error('No Arr device found');

    return device.getUpcomingItems(days, count);
  },
};
