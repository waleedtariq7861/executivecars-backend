// Test-only: the request limiters count per process and the suites sign up and sign in far more often than one
// visitor would, so every limiter is replaced by a pass-through before the routes load. The failed-sign-in
// throttle, which lives in MongoDB, is real and is tested for real.
const path = require.resolve('../../src/middleware/rateLimits')
const real = require(path)
const passThrough = (req, res, next) => next()
require.cache[path].exports = Object.fromEntries(Object.keys(real).map(name => [name, passThrough]))
