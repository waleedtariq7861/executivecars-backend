const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const adminOnly  = require('../middleware/adminOnly')
const { carUpload } = require('../config/cloudinary')
const {
  getStats,
  getBookings, updateBookingStatus, deleteBooking,
  getMembers, deleteMember,
  createCar, getAdminCars, updateCar, deleteCar, getAuctionResult, closeAuction,
  createProduct, getAdminProducts, updateProduct, deleteProduct,
} = require('../controllers/adminController')
const datasetUpload = require('../middleware/datasetUpload')
const { importDataset, getDatasetImports, getDatasetSummary, exportTrainingRecords } = require('../controllers/datasetController')
const { predictionServiceHealth, getModelVersions, trainModel, activateModelVersion, rollbackModelVersion } = require('../controllers/modelController')

router.use(protect, adminOnly)

router.get('/stats', getStats)

router.get('/bookings',           getBookings)
router.patch('/bookings/:id',     updateBookingStatus)
router.delete('/bookings/:id',    deleteBooking)

router.post('/dataset-imports', datasetUpload.single('dataset'), importDataset)
router.get('/dataset-imports', getDatasetImports)
router.get('/dataset-summary', getDatasetSummary)
router.get('/dataset-records/export', exportTrainingRecords)

router.get('/model-health', predictionServiceHealth)
router.get('/model-versions', getModelVersions)
router.post('/model-train', trainModel)
router.post('/model-versions/:version/activate', activateModelVersion)
router.post('/model-rollback', rollbackModelVersion)

router.get('/members',            getMembers)
router.delete('/members/:id',     deleteMember)

router.post('/cars',             carUpload, createCar)
router.get('/cars',              getAdminCars)
router.put('/cars/:id',          updateCar)
router.get('/cars/:id/results',  getAuctionResult)
router.post('/cars/:id/close',   closeAuction)
router.delete('/cars/:id',       deleteCar)

router.post('/products',          carUpload, createProduct)
router.get('/products',           getAdminProducts)
router.put('/products/:id',       updateProduct)
router.delete('/products/:id',    deleteProduct)

module.exports = router
