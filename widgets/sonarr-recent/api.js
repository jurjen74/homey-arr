'use strict';

module.exports = {
  async getRecent({ homey, query }) {
    const count        = Math.max(1, Math.min(20, parseInt(query.count, 10) || 5));
    const uniqueSeries = query.uniqueSeries === 'true';

    const devices = homey.drivers.getDriver('sonarr').getDevices();
    if (!devices.length) throw new Error('No Sonarr device found');

    return devices[0].getRecentEpisodes(count, uniqueSeries);
  },
};
