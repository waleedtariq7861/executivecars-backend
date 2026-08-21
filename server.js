// Backwards-compatible launcher. The maintained application entry is server/index.js.
const backend = require('./server/index')

if (require.main === module) {
  backend.start().catch(error => {
    console.error('Server startup failed:', error.message)
    process.exit(1)
  })
}

module.exports = backend
