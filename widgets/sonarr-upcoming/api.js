'use strict';

module.exports = {
  async getUpcoming({ homey, query }) {
    const days  = Math.max(1, Math.min(14, parseInt(query.days,  10) || 7));
    const count = Math.max(1, Math.min(20, parseInt(query.count, 10) || 5));

    const devices = homey.drivers.getDriver('sonarr').getDevices();
    if (!devices.length) throw new Error('No Sonarr device found');

    return devices[0].getUpcomingEpisodes(days, count);
  },
};
