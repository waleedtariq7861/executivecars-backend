const { toInspectionSafeObject } = require('./inspectionReport')
const { hasMetReserve } = require('./auctionOutcome')

// What a used-car listing shows to the public and to signed-in customers. Built from an allow-list, so a field
// added to the model later (an owner, an e-mail address, an internal note) is never exposed by accident.
const PUBLIC_PRODUCT_FIELDS = [
  '_id', 'make', 'model', 'variant', 'year', 'km', 'price', 'engine', 'fuel', 'transmission', 'color',
  'city', 'registrationCity', 'bodyType', 'assemblyType', 'condition', 'verificationStatus',
  'inspectionStatus', 'inspectionScore', 'hasInspectionReport', 'inspectionReportAccessPath',
  'images', 'description', 'status', 'listingType', 'createdAt', 'updatedAt',
]

const MEMBER_AUCTION_FIELDS = [
  '_id', 'make', 'model', 'variant', 'year', 'km', 'engine', 'fuel',
  'transmission', 'color', 'city', 'registrationCity', 'bodyType',
  'assemblyType', 'condition', 'verificationStatus', 'inspectionStatus',
  'inspectionScore', 'hasInspectionReport', 'inspectionReportAccessPath', 'images', 'basePrice',
  'minimumBidIncrement', 'currentBid', 'bidCount',
  'auctionStart', 'auctionEnd', 'description', 'status', 'createdAt', 'updatedAt',
]

const allowed = (source, fields) => Object.fromEntries(
  fields.filter(field => source[field] !== undefined).map(field => [field, source[field]]),
)

const toPublicProductObject = product => allowed(
  toInspectionSafeObject(product, { reportPath: `/documents/products/${product._id}/report` }),
  PUBLIC_PRODUCT_FIELDS,
)

const maskBidderName = name => {
  const normalized = String(name || '').trim()
  return normalized ? `${normalized.slice(0, 2)}***` : 'Bidder'
}

/**
 * An auction as another bidder may see it. The reserve price itself is secret: bidders learn only whether
 * there is a reserve and whether the current bid has reached it. Other bidders' names are masked.
 */
const toMemberAuctionObject = (car, memberId) => {
  const source = toInspectionSafeObject(car, { reportPath: `/documents/auctions/${car._id}/report` })
  const safe = allowed(source, MEMBER_AUCTION_FIELDS)
  safe.hasReserve = Boolean(car.reservePrice)
  safe.reserveMet = hasMetReserve(car)
  const bidder = source.highestBidder
  const bidderId = bidder?._id || bidder
  if (bidderId) {
    const isCurrentMember = String(bidderId) === String(memberId)
    safe.highestBidder = {
      ...(isCurrentMember ? { _id: bidderId } : {}),
      name: isCurrentMember ? 'You' : maskBidderName(bidder?.name),
    }
  }
  return safe
}

module.exports = { toPublicProductObject, toMemberAuctionObject, maskBidderName, PUBLIC_PRODUCT_FIELDS, MEMBER_AUCTION_FIELDS }
