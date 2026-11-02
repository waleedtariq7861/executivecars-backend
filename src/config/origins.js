// The browser origins allowed to call the API and to open a live-auction socket.
const configuredOrigins = [process.env.CLIENT_URL, ...(process.env.CLIENT_URLS || '').split(',')]
  .map(value => value?.trim().replace(/\/$/, ''))
  .filter(Boolean)

if (process.env.NODE_ENV !== 'production') {
  configuredOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173')
}

const allowedOrigins = [...new Set(configuredOrigins)]

module.exports = { allowedOrigins }
