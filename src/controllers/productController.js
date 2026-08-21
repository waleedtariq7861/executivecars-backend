const Product = require('../models/Product')
const { escapeRegex, handleControllerError } = require('../utils/http')
const { strictNumber } = require('../utils/inputValidation')

const getProducts = async (req, res) => {
  try {
    const { make, fuel, transmission, min_price, max_price, search } = req.query
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
    res.json(products)
  } catch (err) {
    handleControllerError(res, err, 'Could not load used cars')
  }
}

const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found' })
    res.json(product)
  } catch (err) {
    handleControllerError(res, err, 'Could not load used car')
  }
}

module.exports = { getProducts, getProductById }
