const axios = require('axios')
const Product = require('../models/Product')
const { escapeRegex, handleControllerError } = require('../utils/http')

const DEFAULT_MODEL = 'openai/gpt-oss-20b'
const configuredModel = () => String(process.env.GROQ_MODEL || DEFAULT_MODEL).trim()

const SYSTEM_PROMPT = `You are the AI assistant for Executive Cars, a premium used car showroom at Stadium Road, Rawalpindi, Pakistan. Help customers concisely and professionally.

You have two tools available:
- search_used_cars: use whenever the user asks about buying a car, browsing inventory, specific makes/models, or price ranges
- get_active_auctions: use whenever the user asks about auctions, live bidding, or auction cars

Key facts (no tool needed):
- Selling: 3-step process — fill vehicle details, book inspection (OTP-verified email), receive seller credentials within 1–2 business days. No upfront fee; commission only on sale.
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

const chat = async (req, res) => {
  try {
    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ message: 'messages array is required' })
    }

    const history = messages
      .filter(m => m.role && m.content && ['user', 'assistant'].includes(m.role))
      .slice(-20)

    if (!process.env.GROQ_API_KEY) {
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

    const choice1 = res1.data.choices[0]

    if (choice1.finish_reason === 'tool_calls') {
      // Execute all requested tools in parallel
      const toolResults = await Promise.all(
        choice1.message.tool_calls.map(async tc => {
          const args   = JSON.parse(tc.function.arguments || '{}')
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

      return res.json({ reply: res2.data.choices[0].message.content })
    }

    res.json({ reply: choice1.message.content })
  } catch (err) {
    if (err.response) {
      const providerCode = err.response?.data?.error?.code
      const unavailable = providerCode === 'model_not_found' || err.response.status === 404
      return res.status(unavailable ? 503 : 502).json({
        message: unavailable ? 'AI assistant model is unavailable' : 'AI service error',
      })
    }
    handleControllerError(res, err, 'AI assistant is unavailable')
  }
}

module.exports = { chat, configuredModel }
