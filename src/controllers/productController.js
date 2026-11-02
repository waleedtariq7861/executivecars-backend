const Product = require('../models/Product')
const { escapeRegex, handleControllerError, queryText } = require('../utils/http')
const { strictNumber } = require('../utils/inputValidation')
const { toPublicProductObject } = require('../utils/publicDto')

const getProducts = async (req, res) => {
  try {
    const make = queryText(req.query.make, 'make')
    const fuel = queryText(req.query.fuel, 'fuel')
    const transmission = queryText(req.query.transmission, 'transmission')
    const min_price = queryText(req.query.min_price, 'min_price')
    const max_price = queryText(req.query.max_price, 'max_price')
    const search = queryText(req.query.search, 'search')
    const filter = { status: 'available' }

    if (make)         filter.make = new RegExp(escapeRegex(make), 'i')
    if (fuel)         filter.fuel = fuel
    if (transmission) filter.transmission = transmission
    if (min_price || max_price) {
      filter.price = {}
      if (min_price) {
        let min
        try { min = strictNumber('min_price', min_price, { min: 0 }) } catch { return res.status(400).json({ message: 'min_price must be a positive number' }) }
        filter.price.$gte = min
      }
      if (max_price) {
        let max
        try { max = strictNumber('max_price', max_price, { min: 0 }) } catch { return res.status(400).json({ message: 'max_price must be a positive number' }) }
        filter.price.$lte = max
      }
    }
    if (search) {
      const matcher = new RegExp(escapeRegex(search), 'i')
      filter.$or = [{ make: matcher }, { model: matcher }]
    }

    const products = await Product.find(filter).sort({ createdAt: -1 })
    res.json(products.map(toPublicProductObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load used cars')
  }
}

const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found' })
    res.json(toPublicProductObject(product))
  } catch (err) {
    handleControllerError(res, err, 'Could not load used car')
  }
}

module.exports = { getProducts, getProductById }
