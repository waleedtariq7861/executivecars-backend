// Backward-compatible entry point. The complete, production-gated seed lives in seedDemo.
const mongoose = require('mongoose')
const { seedDemo } = require('./seedDemo')

seedDemo()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(`Demo seed failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })
