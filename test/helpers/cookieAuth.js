// Test-only bridge between the suites' convenient `Authorization: Bearer <token>` calls and the real
// authentication, which is an HttpOnly session cookie plus a CSRF token and an allowed Origin.
// The application has no test mode: this file makes the suites send what a browser would send, and lets
// them read the session token back from a sign-in response (`response.body.token`) as a browser could not.
const Test = require('supertest/lib/test')
const TestAgent = require('supertest/lib/agent')
const methods = require('methods')
const { sessionCookieName, csrfTokenForSession } = require('../../src/utils/session')

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])
// Requests made through request.agent() are a real browser session: they keep cookies and never get the token.
for (const method of methods) {
  const original = TestAgent.prototype[method]
  if (method === 'query' || typeof original !== 'function') continue
  TestAgent.prototype[method] = function viaAgent(...args) {
    const test = original.apply(this, args)
    test._viaAgent = true
    return test
  }
}

const originalSet = Test.prototype.set
const originalEnd = Test.prototype.end

Test.prototype.set = function set(field, value) {
  if (typeof field === 'string' && field.toLowerCase() === 'authorization' && typeof value === 'string' && value.startsWith('Bearer ')) {
    this._sessionToken = value.slice(7)
    return originalSet.call(this, 'Cookie', `${sessionCookieName()}=${this._sessionToken}`)
  }
  return originalSet.call(this, field, value)
}

Test.prototype.end = function end(callback) {
  if (this._sessionToken && !SAFE.has(String(this.method).toUpperCase())) {
    if (!this.header?.['X-CSRF-Token'] && !this.header?.['x-csrf-token']) originalSet.call(this, 'X-CSRF-Token', csrfTokenForSession(this._sessionToken))
    if (!this.header?.Origin && !this.header?.origin) originalSet.call(this, 'Origin', process.env.CLIENT_URL)
  }
  return originalEnd.call(this, (error, response) => {
    const header = response?.headers?.['set-cookie']
    if (!this._viaAgent && header && response.body && typeof response.body === 'object') {
      const match = [].concat(header).map(line => line.match(new RegExp(`^${sessionCookieName()}=([^;]+)`))).find(Boolean)
      if (match) response.body.token = decodeURIComponent(match[1])
    }
    callback(error, response)
  })
}
