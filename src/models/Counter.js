const mongoose = require('mongoose')

// Gap-free-per-year sequences (invoice numbers). `findOneAndUpdate` with $inc is atomic.
const counterSchema = new mongoose.Schema({ _id: { type: String }, seq: { type: Number, default: 0 } }, { versionKey: false })

const Counter = mongoose.model('Counter', counterSchema)

const nextSequence = async (name, session) => (
  await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true, session })
).seq

module.exports = Counter
module.exports.nextSequence = nextSequence
