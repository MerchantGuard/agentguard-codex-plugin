'use strict';
// Model the file IPC boundary in unit tests, reusing the actual worker resolver
// with synthetic transports. The production activation helper cannot fetch.
const {activate: activateRuntime} = require('../runtime/activate.cjs');
async function activate(key, options) {
  return activateRuntime(key, {...options, request: async message => {
    const policy = require('../runtime/policy-file.cjs').readPolicy(options.data).policy;
    const license = await require('../runtime/worker-session.cjs').refreshWorkerSession({...options, policy,
      sessionId: message.sessionId, forceActivation: true, getPolicy: options.getPolicy || (async () => ({status: 204}))});
    return {license};
  }});
}
module.exports = {activate};
