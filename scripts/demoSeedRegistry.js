const mongoose = require('mongoose')

// Which documents the demo seed created. Keeping this list here, instead of tagging every production model
// with a demo field, lets the seed be repeated and reset safely without touching real data.
const demoSeedEntrySchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true },
  modelName: { type: String, required: true },
  docId:     { type: mongoose.Schema.Types.ObjectId, required: true },
}, { timestamps: true })

module.exports = mongoose.models.DemoSeedEntry || mongoose.model('DemoSeedEntry', demoSeedEntrySchema)
