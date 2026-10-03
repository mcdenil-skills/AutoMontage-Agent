const test = require('node:test');
const { checkMasterMedia } = require('./helpers/master-media-check');
for (const rotation of [0, 90, 270, 180]) {
  test(`real source master publishes upright ${rotation}° with synchronized audio`, { timeout: 180000 },
    (t) => checkMasterMedia(t, { rotation }));
}
for (const rotation of [90, 270, 180]) {
  test(`real source master strips a simulated retained ${rotation}° matrix`, { timeout: 180000 },
    (t) => checkMasterMedia(t, { rotation, retainedMatrix: true }));
}
