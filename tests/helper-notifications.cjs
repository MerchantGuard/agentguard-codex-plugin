'use strict';
// Preload isolation before any test imports the runtime. Environment variables
// reach hooks and detached workers; an in-process execFile stub cannot do that.
module.exports = require('./helper-test-env.cjs');
