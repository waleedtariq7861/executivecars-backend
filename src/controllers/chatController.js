const axios = require('axios')
const { randomUUID } = require('crypto')
const Product = require('../models/Product')
const { isDemoMode } = require('../config/runtime')
const { escapeRegex } = require('../utils/http')

const DEFAULT_MODEL = 'openai/gpt-oss-20b'
const configuredModel = () => String(process.env.GROQ_MODEL || DEFAULT_MODEL).trim()
const capabilityCacheMs = () => Math.max(30_000, Number(process.env.CHAT_CAPABILITY_CACHE_MS) || 300_000)
let capabilityCache = null

const SYSTEM_PROMPT = `You are the AI assistant for Executive Cars, a premium used car showroom at Stadium Road, Rawalpindi, Pakistan. Help customers concisely and professionally.

You have two tools available:
- search_used_cars: use whenever the user asks about buying a car, browsing inventory, specific makes/models, or price ranges
- get_active_auctions: use whenever the user asks about auctions, live bidding, or auction cars

Key facts (no tool needed):
- Selling and inspection: sign in with the unified account, then open /seller/book-inspection. Enter contact and vehicle details, optionally upload CNIC and registration documents, and choose a preferred date, time, and branch in the form. Verify the booking email with a six-digit OTP and submit. The request starts pending review; track its status at /seller/bookings. Approval uses the same account, not separate seller credentials. Do not claim that a scheduling email link is sent or promise an approval time or fee terms.
- Auction membership: PKR 4,999/year. Bids are binding.
- Price Predictor: AI price estimation for Pakistani car market at /price-predictor
- Login: unified at /login for buyers, sellers, and auction members
- Contact: info@executivecars.pk

Keep answers short and to the point. The chat widget supports plain text only: do not use Markdown tables, headings, bold markers, or HTML. Use short sentences and simple bullet lines when a list is useful. If unsure, direct to info@executivecars.pk.`

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_used_cars',
      description: 'Search available used cars for direct purchase. Use when user asks about buying cars, available inventory, a specific make/model, or a price range.',
      parameters: {
        type: 'object',
        properties: {
          make:      { type: 'string',  description: 'Car brand, e.g. Toyota, Honda, Suzuki' },
          model:     { type: 'string',  description: 'Car model, e.g. Corolla, Civic, Alto' },
          price_min: { type: 'number',  description: 'Minimum price in PKR' },
          price_max: { type: 'number',  description: 'Maximum price in PKR' },
          year_min:  { type: 'number',  description: 'Minimum manufacture year' },
          limit:     { type: 'number',  description: 'Max results (default 5, max 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_active_auctions',
      description: 'Get all currently active auction listings with current bids and time remaining. Use when user asks about auctions or auction cars.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
]

async function runSearchUsedCars({ make, model, price_min, price_max, year_min, limit = 5 }) {
  const query = { status: 'available' }
  if (make) query.make = new RegExp(escapeRegex(make), 'i')
  if (model) query.model = new RegExp(escapeRegex(model), 'i')
  if (price_min || price_max) {
    query.price = {}
    if (price_min) query.price.$gte = price_min
    if (price_max) query.price.$lte = price_max
  }
  if (year_min) query.year = { $gte: year_min }

  const cars = await Product.find(query)
    .select('make model year km price transmission fuel color')
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 10))
    .lean()

  if (cars.length === 0) return 'No used cars found matching those criteria.'

  return cars
    .map(c =>
      `• ${c.year} ${c.make} ${c.model} — PKR ${c.price.toLocaleString()} | ${c.km.toLocaleString()} km | ${c.transmission} | ${c.fuel}${c.color ? ` | ${c.color}` : ''}`
    )
    .join('\n')
}

async function runGetActiveAuctions() {
  return 'Live auction inventory and bid details are available only to signed-in members with an active auction membership. Open the Auction Portal to view them.'
}

async function executeTool(name, args) {
  try {
    if (name === 'search_used_cars')    return await runSearchUsedCars(args)
    if (name === 'get_active_auctions') return await runGetActiveAuctions()
    return 'Unknown tool.'
  } catch {
    return 'Could not retrieve that information right now. Please try again later.'
  }
}

const groqPost = (body) =>
  axios.post('https://api.groq.com/openai/v1/chat/completions', body, {
    headers: {
      Authorization:  `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  })

class InvalidProviderResponse extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidProviderResponse'
  }
}

const providerChoice = response => {
  const choice = response?.data?.choices?.[0]
  if (!choice?.message || typeof choice.message !== 'object') {
    throw new InvalidProviderResponse('Provider response did not contain a message choice')
  }
  return choice
}

const providerReply = response => {
  const content = providerChoice(response).message.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new InvalidProviderResponse('Provider response did not contain reply content')
  }
  return content.trim()
}

const errorCategory = err => {
  const status = Number(err.response?.status)
  const providerCode = err.response?.data?.error?.code
  if (err instanceof InvalidProviderResponse || err instanceof SyntaxError) return 'invalid_response'
  if (providerCode === 'model_not_found' || status === 404) return 'model_unavailable'
  if (status === 429) return 'rate_limited'
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'timeout'
  if (status >= 500) return 'provider_failure'
  if (err.response) return 'provider_rejected'
  return 'network_error'
}

const publicError = category => {
  if (category === 'model_unavailable') return { status: 503, code: category, message: 'AI assistant model is unavailable' }
  if (category === 'invalid_response') return { status: 502, code: category, message: 'AI service returned an invalid response' }
  if (category === 'provider_failure' || category === 'provider_rejected') return { status: 502, code: category, message: 'AI service error' }
  return { status: 503, code: category, message: 'AI assistant is temporarily unavailable' }
}

const requestIdFor = req => {
  const supplied = String(req.get?.('x-request-id') || '').trim()
  return /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID()
}

const sendChatError = (res, category, requestId) => {
  const error = publicError(category)
  console.warn(JSON.stringify({ event: 'chat_provider_failure', requestId, category }))
  return res.status(error.status).json({ message: error.message, code: error.code, requestId })
}

const resetChatCapabilityCache = () => { capabilityCache = null }

const validateChatCapability = async ({ force = false } = {}) => {
  if (!process.env.GROQ_API_KEY) {
    const demoFallback = isDemoMode()
    return {
      configured: false, providerReachable: false, modelUsable: false, demoFallback,
      status: demoFallback ? 'available' : 'unavailable',
    }
  }

  const cacheKey = `${configuredModel()}:${process.env.GROQ_API_KEY}`
  if (!force && capabilityCache?.key === cacheKey && Date.now() - capabilityCache.checkedAt < capabilityCacheMs()) {
    return capabilityCache.value
  }

  let value
  try {
    const response = await groqPost({
      model: configuredModel(),
      messages: [{ role: 'user', content: 'Reply OK.' }],
      tools: TOOLS,
      tool_choice: 'none',
      max_tokens: 100,
      temperature: 0,
    })
    providerReply(response)
    value = { configured: true, providerReachable: true, modelUsable: true, demoFallback: false, status: 'available', category: null }
  } catch (err) {
    const category = errorCategory(err)
    value = {
      configured: true,
      providerReachable: !['timeout', 'network_error', 'provider_failure'].includes(category),
      modelUsable: false,
      demoFallback: false,
      status: 'unavailable',
      category,
    }
  }
  capabilityCache = { key: cacheKey, checkedAt: Date.now(), value }
  return value
}

const chatHealth = async (req, res) => {
  const capability = await validateChatCapability()
  const { category, ...publicCapability } = capability
  return res.status(capability.status === 'available' ? 200 : 503).json(publicCapability)
}

const chat = async (req, res) => {
  const requestId = requestIdFor(req)
  try {
    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ message: 'messages array is required' })
    }

    const history = messages
      .filter(m => m.role && m.content && ['user', 'assistant'].includes(m.role))
      .slice(-20)

    if (!process.env.GROQ_API_KEY) {
      if (!isDemoMode()) {
        return res.status(503).json({ message: 'AI assistant is not configured', code: 'not_configured', requestId })
      }
      const latest = history.at(-1)?.content || ''
      if (/auction|bid|bidding/i.test(latest)) {
        return res.json({ reply: await runGetActiveAuctions() })
      }
      if (/car|buy|available|inventory|price/i.test(latest)) {
        const inventory = await runSearchUsedCars({ limit: 5 })
        return res.json({ reply: inventory })
      }
      return res.json({
        reply: 'I can help you browse used cars, check live auctions, explain the selling process, or guide you to the Price Predictor.',
      })
    }

    const capability = await validateChatCapability()
    if (!capability.modelUsable) {
      return sendChatError(res, capability.category || 'model_unavailable', requestId)
    }

    const groqMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history]

    // First call — model may decide to call a tool
    const res1 = await groqPost({
      model: configuredModel(),
      messages: groqMessages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 600,
      temperature: 0.7,
    })

    const choice1 = providerChoice(res1)

    if (choice1.finish_reason === 'tool_calls') {
      if (!Array.isArray(choice1.message.tool_calls) || choice1.message.tool_calls.length === 0) {
        throw new InvalidProviderResponse('Provider declared tool calls without any tool call')
      }
      // Execute all requested tools in parallel
      const toolResults = await Promise.all(
        choice1.message.tool_calls.map(async tc => {
          if (!tc?.id || !tc.function?.name) throw new InvalidProviderResponse('Provider returned an incomplete tool call')
          const args = JSON.parse(tc.function.arguments || '{}')
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new InvalidProviderResponse('Tool arguments must be an object')
          const result = await executeTool(tc.function.name, args)
          return { tool_call_id: tc.id, role: 'tool', content: result }
        })
      )

      // Second call with tool results injected
      const res2 = await groqPost({
        model:    configuredModel(),
        messages: [...groqMessages, choice1.message, ...toolResults],
        max_tokens: 600,
        temperature: 0.7,
      })

      return res.json({ reply: providerReply(res2) })
    }

    return res.json({ reply: providerReply(res1) })
  } catch (err) {
    return sendChatError(res, errorCategory(err), requestId)
  }
}

module.exports = { chat, chatHealth, configuredModel, validateChatCapability, resetChatCapabilityCache }
