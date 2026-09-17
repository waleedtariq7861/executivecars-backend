const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const Product = require('../src/models/Product')
const {
  chat, chatHealth, configuredModel, resetChatCapabilityCache,
} = require('../src/controllers/chatController')

const responseRecorder = () => {
  const record = { statusCode: 200, body: null }
  return {
    record,
    response: {
      status(code) { record.statusCode = code; return this },
      json(body) { record.body = body; return this },
    },
  }
}

test('chat sends the environment-configured model to Groq', async () => {
  const originalPost = axios.post
  const originalKey = process.env.GROQ_API_KEY
  const originalModel = process.env.GROQ_MODEL
  let requestBody
  process.env.GROQ_API_KEY = 'test-key'
  process.env.GROQ_MODEL = 'tool-capable-test-model'
  resetChatCapabilityCache()
  axios.post = async (url, body) => {
    requestBody = body
    return { data: { choices: [{ finish_reason: 'stop', message: { content: 'Hello from the configured model.' } }] } }
  }
  try {
    const { record, response } = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Hello' }] } }, response)
    assert.equal(configuredModel(), 'tool-capable-test-model')
    assert.equal(requestBody.model, 'tool-capable-test-model')
    assert.equal(record.statusCode, 200)
    assert.deepEqual(record.body, { reply: 'Hello from the configured model.' })
  } finally {
    axios.post = originalPost
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    if (originalModel === undefined) delete process.env.GROQ_MODEL
    else process.env.GROQ_MODEL = originalModel
    resetChatCapabilityCache()
  }
})

test('chat reports an unavailable configured model without leaking provider detail', async () => {
  const originalPost = axios.post
  const originalKey = process.env.GROQ_API_KEY
  const originalWarn = console.warn
  process.env.GROQ_API_KEY = 'test-key'
  resetChatCapabilityCache()
  console.warn = () => {}
  axios.post = async () => {
    const error = new Error('provider detail must not be returned')
    error.response = { status: 404, data: { error: { code: 'model_not_found', message: 'private provider detail' } } }
    throw error
  }
  try {
    const { record, response } = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Hello' }] } }, response)
    assert.equal(record.statusCode, 503)
    assert.equal(record.body.message, 'AI assistant model is unavailable')
    assert.equal(record.body.code, 'model_unavailable')
    assert.match(record.body.requestId, /^[0-9a-f-]{36}$/)
  } finally {
    axios.post = originalPost
    console.warn = originalWarn
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    resetChatCapabilityCache()
  }
})

test('chat executes used-car and protected-auction tools before returning a reply', async () => {
  const originalPost = axios.post
  const originalFind = Product.find
  const originalKey = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'test-key'
  resetChatCapabilityCache()
  const calls = []
  const chain = {
    select() { return this }, sort() { return this }, limit() { return this },
    async lean() { return [{ year: 2022, make: 'Honda', model: 'City', price: 5000000, km: 30000, transmission: 'Auto', fuel: 'Petrol', color: 'White' }] },
  }
  Product.find = () => chain
  axios.post = async (url, body) => {
    calls.push(body)
    if (calls.length === 1) return { data: { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] } }
    if (calls.length === 2) return { data: { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'used-1', function: { name: 'search_used_cars', arguments: '{"make":"Honda"}' } },
      { id: 'auction-1', function: { name: 'get_active_auctions', arguments: '{}' } },
    ] } }] } }
    return { data: { choices: [{ finish_reason: 'stop', message: { content: 'I found a Honda City. Auction details require active membership.' } }] } }
  }
  try {
    const { record, response } = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Show Honda cars and auctions' }] } }, response)
    assert.equal(record.statusCode, 200)
    assert.match(record.body.reply, /Honda City/)
    const toolMessages = calls[2].messages.filter(message => message.role === 'tool')
    assert.match(toolMessages[0].content, /2022 Honda City/)
    assert.match(toolMessages[1].content, /signed-in members with an active auction membership/)
  } finally {
    axios.post = originalPost
    Product.find = originalFind
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    resetChatCapabilityCache()
  }
})

test('chat rejects malformed tool JSON with a stable response', async () => {
  const originalPost = axios.post
  const originalKey = process.env.GROQ_API_KEY
  const originalWarn = console.warn
  process.env.GROQ_API_KEY = 'test-key'
  resetChatCapabilityCache()
  console.warn = () => {}
  let call = 0
  axios.post = async () => {
    call += 1
    if (call === 1) return { data: { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] } }
    return { data: { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad-1', function: { name: 'search_used_cars', arguments: '{bad json' } }] } }] } }
  }
  try {
    const { record, response } = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Show cars' }] } }, response)
    assert.equal(record.statusCode, 502)
    assert.equal(record.body.code, 'invalid_response')
    assert.equal(record.body.message, 'AI service returned an invalid response')
  } finally {
    axios.post = originalPost
    console.warn = originalWarn
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    resetChatCapabilityCache()
  }
})

test('chat rejects an empty provider choices array', async () => {
  const originalPost = axios.post
  const originalKey = process.env.GROQ_API_KEY
  const originalWarn = console.warn
  process.env.GROQ_API_KEY = 'test-key'
  resetChatCapabilityCache()
  console.warn = () => {}
  axios.post = async () => ({ data: { choices: [] } })
  try {
    const { record, response } = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Hello' }] } }, response)
    assert.equal(record.statusCode, 502)
    assert.equal(record.body.code, 'invalid_response')
  } finally {
    axios.post = originalPost
    console.warn = originalWarn
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    resetChatCapabilityCache()
  }
})

for (const scenario of [
  { name: 'timeout', error: Object.assign(new Error('timeout detail'), { code: 'ECONNABORTED' }), status: 503, code: 'timeout' },
  { name: 'rate limit', error: Object.assign(new Error('rate detail'), { response: { status: 429, data: { error: { message: 'private' } } } }), status: 503, code: 'rate_limited' },
  { name: 'provider 5xx', error: Object.assign(new Error('provider detail'), { response: { status: 500, data: { error: { message: 'private' } } } }), status: 502, code: 'provider_failure' },
]) {
  test(`chat maps ${scenario.name} without leaking provider details`, async () => {
    const originalPost = axios.post
    const originalKey = process.env.GROQ_API_KEY
    const originalWarn = console.warn
    process.env.GROQ_API_KEY = 'test-key'
    resetChatCapabilityCache()
    let safeLog = ''
    console.warn = message => { safeLog = message }
    axios.post = async () => { throw scenario.error }
    try {
      const { record, response } = responseRecorder()
      await chat({ get: () => 'qa-request-1', body: { messages: [{ role: 'user', content: 'private prompt' }] } }, response)
      assert.equal(record.statusCode, scenario.status)
      assert.equal(record.body.code, scenario.code)
      assert.equal(record.body.requestId, 'qa-request-1')
      assert.doesNotMatch(JSON.stringify(record.body), /private|detail|prompt/)
      assert.doesNotMatch(safeLog, /private|detail|prompt|test-key/)
      assert.match(safeLog, new RegExp(scenario.code))
    } finally {
      axios.post = originalPost
      console.warn = originalWarn
      if (originalKey === undefined) delete process.env.GROQ_API_KEY
      else process.env.GROQ_API_KEY = originalKey
      resetChatCapabilityCache()
    }
  })
}

test('missing key uses deterministic fallback only in explicit demo mode', async () => {
  const originalKey = process.env.GROQ_API_KEY
  const originalMode = process.env.APP_MODE
  const originalNodeEnv = process.env.NODE_ENV
  delete process.env.GROQ_API_KEY
  process.env.APP_MODE = 'demo'
  process.env.NODE_ENV = 'test'
  try {
    const demo = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'How do auctions work?' }] } }, demo.response)
    assert.equal(demo.record.statusCode, 200)
    assert.match(demo.record.body.reply, /active auction membership/)

    process.env.APP_MODE = 'production'
    process.env.NODE_ENV = 'production'
    const production = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Hello' }] } }, production.response)
    assert.equal(production.record.statusCode, 503)
    assert.equal(production.record.body.code, 'not_configured')
  } finally {
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    if (originalMode === undefined) delete process.env.APP_MODE
    else process.env.APP_MODE = originalMode
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    resetChatCapabilityCache()
  }
})

test('chat health validates the exact configured model once and returns cached public capability', async () => {
  const originalPost = axios.post
  const originalKey = process.env.GROQ_API_KEY
  const originalModel = process.env.GROQ_MODEL
  process.env.GROQ_API_KEY = 'test-key'
  process.env.GROQ_MODEL = 'health-test-model'
  resetChatCapabilityCache()
  let calls = 0
  let probeBody
  axios.post = async (url, body) => {
    calls += 1
    probeBody = body
    return { data: { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] } }
  }
  try {
    const first = responseRecorder()
    const second = responseRecorder()
    await chatHealth({}, first.response)
    await chatHealth({}, second.response)
    assert.equal(calls, 1)
    assert.equal(probeBody.model, 'health-test-model')
    assert.equal(probeBody.tool_choice, 'none')
    assert.deepEqual(first.record.body, { configured: true, providerReachable: true, modelUsable: true, demoFallback: false, status: 'available' })
    assert.deepEqual(second.record.body, first.record.body)
  } finally {
    axios.post = originalPost
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
    if (originalModel === undefined) delete process.env.GROQ_MODEL
    else process.env.GROQ_MODEL = originalModel
    resetChatCapabilityCache()
  }
})
