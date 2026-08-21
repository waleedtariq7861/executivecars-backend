const router = require('express').Router()
const { catalog, findVehicle, specification } = require('../data/vehicleCatalog')
router.get('/', (req, res) => res.json(catalog))
router.get('/specification', (req, res) => {
  const spec = specification(req.query)
  if (!spec) return res.status(404).json({ message: 'No verified specification is available for this selection.' })
  return res.json(spec)
})
router.get('/years', (req, res) => {
  const vehicle = findVehicle(req.query)
  return res.json({ years: vehicle?.years || [] })
})
module.exports = router
