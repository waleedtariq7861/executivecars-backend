const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const { chat, configuredModel } = require('../src/controllers/chatController')

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
  }
})

test('chat reports an unavailable configured model without leaking provider detail', async () => {
  const originalPost = axios.post
  const originalKey = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'test-key'
  axios.post = async () => {
    const error = new Error('provider detail must not be returned')
    error.response = { status: 404, data: { error: { code: 'model_not_found', message: 'private provider detail' } } }
    throw error
  }
  try {
    const { record, response } = responseRecorder()
    await chat({ body: { messages: [{ role: 'user', content: 'Hello' }] } }, response)
    assert.equal(record.statusCode, 503)
    assert.deepEqual(record.body, { message: 'AI assistant model is unavailable' })
  } finally {
    axios.post = originalPost
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
  }
})
