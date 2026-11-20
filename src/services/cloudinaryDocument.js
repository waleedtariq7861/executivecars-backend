const { Readable } = require('stream')
const { cloudinary } = require('../config/cloudinary')

const FETCH_TIMEOUT_MS = 15000
const SIGNED_LINK_SECONDS = 60

const failure = (status, message) => Object.assign(new Error(message), { status })

const unreachable = reason => {
  console.warn(JSON.stringify({ event: 'document_fetch_failure', ...reason }))
  return failure(502, 'Document storage is not reachable')
}

// An answer that is not going to be used must still be released, or its connection stays tied up.
const release = response => response.body?.cancel().catch(() => {})

// Fetches a private (authenticated) Cloudinary file on the server, so the browser never sees Cloudinary's address,
// signature or download headers. Resolves once the first bytes have arrived, so every failure up to that point can
// still be answered with a proper status. Rejects with an error carrying the HTTP status to answer with.
// `signal` lets the caller stop the work, for example when the browser has already left.
const openCloudinaryDocument = async (asset, { signal } = {}) => {
  const url = cloudinary.utils.private_download_url(asset.key, String(asset.extension || '').replace(/^\./, ''), {
    resource_type: asset.resourceType || 'raw',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + SIGNED_LINK_SECONDS,
  })

  // The timeout covers the wait for the first bytes only. Once they have arrived it is cleared, so a slow client
  // downloading a large report is never cut off half way.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const stop = () => controller.abort()
  if (signal?.aborted) stop()
  else signal?.addEventListener('abort', stop, { once: true })

  try {
    let response
    try {
      response = await fetch(url, { signal: controller.signal })
    } catch {
      throw unreachable({ reason: 'unreachable' })
    }
    if (response.status === 404) {
      await release(response)
      throw failure(404, 'Document is not available')
    }
    if (!response.ok || !response.body) {
      await release(response)
      throw unreachable({ status: response.status })
    }

    const reader = response.body.getReader()
    let first
    try {
      first = await reader.read()
    } catch {
      throw unreachable({ reason: 'broken_before_first_byte' })
    }

    // The first piece is already in hand; the rest is read on demand. Destroying the stream always releases the
    // upstream body, even if nothing was read from it yet.
    let pending = first.done ? null : first.value
    let finished = first.done
    const stream = new Readable({
      read() {
        if (pending) {
          const chunk = pending
          pending = null
          this.push(chunk)
        } else if (finished) {
          this.push(null)
        } else {
          reader.read().then(({ done, value }) => {
            if (done) { finished = true; this.push(null) } else this.push(value)
          }, error => this.destroy(error))
        }
      },
      destroy(error, callback) {
        reader.cancel().catch(() => {})
        callback(error)
      },
    })

    // fetch decodes a compressed body itself while content-length still names the compressed size, so a length is only
    // passed on for an uncompressed answer.
    const encoding = (response.headers.get('content-encoding') || 'identity').toLowerCase()
    const length = Number(response.headers.get('content-length'))
    const contentLength = encoding === 'identity' && Number.isFinite(length) && length > 0 ? length : null
    return { stream, contentLength }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

module.exports = { openCloudinaryDocument }
