// A SAMPLE inspection report as a PDF, for the platform's sample catalogue.
//
// These vehicles are sample listings: nobody physically inspected them. The report says so on every page, in plain words,
// and its findings are illustrative: they follow the condition stated in the listing, not an examination. It must never
// be presented as a real inspection.
const PDFDocument = require('pdfkit')

const GROUPS = [
  ['Exterior', ['Paint and panel finish', 'Glass and mirrors', 'Lights and indicators', 'Underbody and chassis']],
  ['Interior', ['Seats and upholstery', 'Dashboard and controls', 'Air conditioning', 'Seat belts and airbags']],
  ['Engine and transmission', ['Engine start and idle', 'Fluid leaks', 'Belts and hoses', 'Gear changes']],
  ['Running gear', ['Suspension', 'Steering', 'Brakes', 'Tyres']],
  ['Electrical', ['Battery and charging', 'Power windows and locks', 'Instrument warnings']],
  ['Road test', ['Acceleration and braking', 'Noise and vibration', 'Straight-line tracking']],
]

// Items that wear first. How many of them show wear follows the condition in the listing.
const WEAR_ORDER = ['Tyres', 'Seats and upholstery', 'Brakes', 'Paint and panel finish', 'Suspension', 'Belts and hoses', 'Battery and charging']
const WEAR_BY_CONDITION = { Excellent: { minor: 1, attention: 0 }, Good: { minor: 3, attention: 0 }, Fair: { minor: 4, attention: 2 } }

const OK = 'Good'
const MINOR = 'Minor wear'
const ATTENTION = 'Needs attention'

const findings = vehicle => {
  const wear = WEAR_BY_CONDITION[vehicle.condition] || WEAR_BY_CONDITION.Good
  const outcome = {}
  WEAR_ORDER.slice(0, wear.minor + wear.attention).forEach((item, index) => {
    outcome[item] = index < wear.attention ? ATTENTION : MINOR
  })
  return GROUPS.map(([group, items]) => [group, items.map(item => [item, outcome[item] || OK])])
}

const COLOURS = { [OK]: '#1f6f43', [MINOR]: '#8a5a00', [ATTENTION]: '#a12622' }
const money = value => `PKR ${Number(value).toLocaleString('en-US')}`

const rowsOf = (vehicle, extra) => [
  ['Vehicle', `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.variant ? ` ${vehicle.variant}` : ''}`],
  ['Mileage (as listed)', `${Number(vehicle.km).toLocaleString('en-US')} km`],
  ['Engine', `${vehicle.engine} cc, ${vehicle.fuel}, ${vehicle.transmission}`],
  ['Body and colour', [vehicle.bodyType, vehicle.color].filter(Boolean).join(', ')],
  ['Located in', vehicle.city || ''],
  ['Registered in', vehicle.registrationCity || ''],
  ['Assembly', vehicle.assemblyType || ''],
  ['Condition stated in the listing', vehicle.condition || ''],
  ...extra,
]

/**
 * @param {object} vehicle   the listing's fields (make, model, year, km, engine, ...)
 * @param {{ reference: string, now: Date, compress?: boolean }} options
 * @returns {Promise<Buffer>}
 */
const buildSampleReport = (vehicle, { reference, now, compress = true }) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({
    size: 'A4', margin: 48, bufferPages: true, compress,
    info: { Title: `Sample inspection report ${reference}`, Author: 'Executive Cars', Subject: 'SAMPLE inspection report: this vehicle was not physically inspected', CreationDate: now },
  })
  const chunks = []
  doc.on('data', chunk => chunks.push(chunk))
  doc.on('end', () => resolve(Buffer.concat(chunks)))
  doc.on('error', reject)

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text('Executive Cars', left, 48)
  doc.font('Helvetica').fontSize(12).fillColor('#444444').text('Vehicle inspection report: SAMPLE', left, doc.y + 2)

  const bannerTop = doc.y + 10
  doc.font('Helvetica-Bold').fontSize(10)
  const bannerText = 'SAMPLE REPORT FOR DEMONSTRATION. This vehicle was not physically inspected. The findings below are illustrative: they follow the condition stated in the listing and are not the result of an examination. Do not rely on this report to decide on a purchase.'
  const bannerHeight = doc.heightOfString(bannerText, { width: width - 20 }) + 16
  doc.rect(left, bannerTop, width, bannerHeight).fill('#fdecea')
  doc.fillColor('#a12622').text(bannerText, left + 10, bannerTop + 8, { width: width - 20 })
  doc.y = bannerTop + bannerHeight + 14

  // A row's label and value are placed at an explicit height, so a page break has to be decided before either is drawn.
  const roomFor = height => {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom - 24) doc.addPage()
  }
  const section = title => {
    roomFor(60)
    doc.moveDown(0.4)
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111').text(title, left, doc.y)
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor('#cccccc').lineWidth(0.5).stroke()
    doc.y += 8
  }
  const row = (label, value, color = '#111111') => {
    roomFor(16)
    const y = doc.y
    doc.font('Helvetica').fontSize(10).fillColor('#555555').text(label, left, y, { width: width * 0.5 })
    doc.font('Helvetica-Bold').fillColor(color).text(String(value), left + width * 0.5, y, { width: width * 0.5, align: 'left' })
    doc.y = Math.max(doc.y, y + 14)
  }

  section('Vehicle')
  for (const [label, value] of rowsOf(vehicle, [
    ['Report reference', reference],
    ['Report date', now.toISOString().slice(0, 10)],
    ['Listed price', money(vehicle.price ?? vehicle.basePrice)],
  ])) row(label, value)

  for (const [group, items] of findings(vehicle)) {
    section(group)
    for (const [item, result] of items) row(item, result, COLOURS[result])
  }

  section('Records')
  row('Odometer reading', 'As listed, not verified')
  row('Accident, flood and tampering history', 'Not checked')
  row('Registration and ownership documents', 'Not checked')

  section('About this report')
  doc.font('Helvetica').fontSize(9).fillColor('#444444').text(
    'Executive Cars created this document to show what an inspection report looks like on the platform. The vehicle, its photograph and its condition are sample content. A real inspection report would be produced after a physical examination and would replace this document.',
    left, doc.y, { width },
  )

  const range = doc.bufferedPageRange()
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index)
    doc.page.margins.bottom = 0
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#a12622').text(
      `SAMPLE: not a real inspection. ${reference}. Page ${index + 1} of ${range.count}`,
      left, doc.page.height - 34, { width, align: 'center', lineBreak: false },
    )
  }
  doc.end()
})

module.exports = { buildSampleReport, findings, OK, MINOR, ATTENTION }
