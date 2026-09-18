'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const LICENSE_KEY = 'ag_SYNTHETIC_TEST_PAID_LICENSE';

// Existing policy, budget, recovery and packaging regressions exercise the
// paid behavior. Seed the SDK's documented local cache instead of networking.
function seedPaidLicense(home, key = LICENSE_KEY) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const status = {valid: true, tier: 'growth', seats: 50,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    features: {maxActiveSeats: 50}};
  fs.writeFileSync(path.join(home, `license-${fingerprint}.json`),
    JSON.stringify({fetchedAt: Date.now(), status}) + '\n', {mode: 0o600});
  return key;
}
module.exports = {LICENSE_KEY, seedPaidLicense};
