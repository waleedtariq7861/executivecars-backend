require('dotenv').config()

const crypto = require('crypto')
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Product = require('../src/models/Product')
const Car = require('../src/models/Car')
const Booking = require('../src/models/Booking')
const Bid = require('../src/models/Bid')
const OtpChallenge = require('../src/models/OtpChallenge')
const MembershipPayment = require('../src/models/MembershipPayment')

const DEMO_PREFIX = 'executive-cars-demo:'
const key = name => `${DEMO_PREFIX}${name}`
const DEMO_OTP = '246810'

const requireDemoSeed = () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seeding is disabled in production')
  if (process.env.ENABLE_DEMO_SEED !== 'true') throw new Error('Set ENABLE_DEMO_SEED=true to seed development demo data')
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required to create the development OTP challenge')
}

const demoAccounts = () => ({
  admin: { name: 'Executive Cars Admin', email: 'admin@executivecars.pk', password: 'Admin@12345', role: 'admin', demoKey: key('admin') },
  premium: {
    name: 'Waleed Tariq', email: 'member@executivecars.pk', password: 'Member@12345', phone: '+92 300 1112233', city: 'Islamabad', role: 'user',
    subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), membershipSource: 'demo', demoKey: key('premium-member'),
  },
  regular: {
    name: 'Demo User', email: 'user@executivecars.pk', password: 'User@12345', phone: '+92 300 2223344', city: 'Rawalpindi', role: 'user',
    subscriptionStatus: 'inactive', subscriptionExpiry: undefined, membershipSource: undefined, demoKey: key('regular-user'),
  },
  bidder: {
    name: 'Hamza Ali', email: 'bidder@executivecars.pk', password: 'Bidder@12345', phone: '+92 300 3334455', city: 'Lahore', role: 'user',
    subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), membershipSource: 'demo', demoKey: key('bidder'),
  },
})

const syncAccount = async (Model, account) => {
  const existing = await Model.findOne({ email: account.email })
  // Migrate only the narrowly identifiable local admin created by server/index.js
  // before this full demo seed existed. Every other untagged account is protected.
  const isLegacyLocalAdmin = Model === Admin
    && account.email === 'admin@executivecars.pk'
    && existing?.name === 'Local Admin'
    && existing?.role === 'admin'
  if (existing && !String(existing.demoKey || '').startsWith(DEMO_PREFIX) && !isLegacyLocalAdmin) {
    throw new Error(`Refusing to overwrite an existing non-demo account: ${account.email}`)
  }
  const record = existing || new Model()
  Object.assign(record, account)
  if (!existing || !(await record.matchPassword(account.password))) record.password = account.password
  await record.save()
  return record
}

const syncRecord = (Model, demoKey, fields) => Model.findOneAndUpdate(
  { demoKey },
  { $set: { ...fields, demoKey } },
  { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
)

const otpDigest = (email, otp) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${email}:${otp}`).digest('hex')

const seedDemo = async () => {
  requireDemoSeed()
  if (mongoose.connection.readyState === 0) await connectDB()
  const accounts = demoAccounts()
  const admin = await syncAccount(Admin, accounts.admin)
  const waleed = await syncAccount(Member, accounts.premium)
  const regular = await syncAccount(Member, accounts.regular)
  const hamza = await syncAccount(Member, accounts.bidder)
  const now = new Date()
  const day = 24 * 60 * 60 * 1000
  await Promise.all([waleed, hamza].map(member => syncRecord(MembershipPayment, key(`membership:${member.email}`), {
    memberId: member._id, amount: 4999, currency: 'PKR', plan: 'annual_auction_membership', paymentMode: 'demo', status: 'completed',
  })))

  const productSpecs = [
    ['new-corolla', { make: 'Toyota', model: 'Corolla', variant: 'Altis X 1.8 CVT-i', year: 2024, km: 1800, price: 6950000, engine: '1800', fuel: 'Petrol', transmission: 'Auto', color: 'White', city: 'Islamabad', registrationCity: 'Unregistered', bodyType: 'Sedan', assemblyType: 'Local', condition: 'Excellent', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 96, listingType: 'new', ownerId: waleed._id, sellerEmail: waleed.email, description: 'Low-mileage showroom-condition local Corolla.' }],
    ['used-swift', { make: 'Suzuki', model: 'Swift', variant: 'GL CVT', year: 2021, km: 47000, price: 3650000, engine: '1200', fuel: 'Petrol', transmission: 'Auto', color: 'Grey', city: 'Rawalpindi', registrationCity: 'Islamabad', bodyType: 'Hatchback', assemblyType: 'Local', condition: 'Good', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 88, listingType: 'used', ownerId: regular._id, sellerEmail: regular.email, description: 'Well-kept automatic Swift with current inspection report.' }],
    ['used-city', { make: 'Honda', model: 'City', variant: 'Aspire 1.5 CVT', year: 2022, km: 32000, price: 5150000, engine: '1500', fuel: 'Petrol', transmission: 'Auto', color: 'Silver', city: 'Lahore', registrationCity: 'Punjab', bodyType: 'Sedan', assemblyType: 'Local', condition: 'Excellent', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 92, listingType: 'used', ownerId: hamza._id, sellerEmail: hamza.email, description: 'One-owner Honda City with documented service history.' }],
    ['used-sportage', { make: 'Kia', model: 'Sportage', variant: 'Alpha', year: 2022, km: 28000, price: 7350000, engine: '2000', fuel: 'Petrol', transmission: 'Auto', color: 'Blue', city: 'Karachi', registrationCity: 'Sindh', bodyType: 'SUV', assemblyType: 'Local', condition: 'Excellent', verificationStatus: 'pending', inspectionStatus: 'pending', listingType: 'used', ownerId: waleed._id, sellerEmail: waleed.email, description: 'Family SUV awaiting final inspection report.' }],
    ['used-yaris', { make: 'Toyota', model: 'Yaris', variant: 'ATIV X CVT 1.5', year: 2023, km: 16500, price: 4900000, engine: '1500', fuel: 'Petrol', transmission: 'Auto', color: 'Black', city: 'Islamabad', registrationCity: 'Islamabad', bodyType: 'Sedan', assemblyType: 'Local', condition: 'Excellent', verificationStatus: 'verified', inspectionStatus: 'not_available', listingType: 'used', ownerId: regular._id, sellerEmail: regular.email, description: 'Low-mileage Yaris suitable for a first family car.' }],
  ]
  const products = Object.fromEntries(await Promise.all(productSpecs.map(async ([name, fields]) => [name, await syncRecord(Product, key(`product:${name}`), { ...fields, status: 'available', images: [] })])))

  const auctionSpecs = [
    ['live-civic', { make: 'Honda', model: 'Civic', variant: 'Oriel 1.8 i-VTEC CVT', year: 2020, km: 61000, engine: '1800', fuel: 'Petrol', transmission: 'Auto', color: 'Black', city: 'Islamabad', registrationCity: 'Islamabad', bodyType: 'Sedan', assemblyType: 'Local', condition: 'Good', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 89, basePrice: 4550000, reservePrice: 4800000, currentBid: 4850000, minimumBidIncrement: 50000, auctionStart: new Date(now - day), auctionEnd: new Date(now.getTime() + day), status: 'active', ownerId: waleed._id, sellerEmail: waleed.email, description: 'Live demo auction: verified Civic with service record.', images: [] }],
    ['upcoming-fortuner', { make: 'Toyota', model: 'Fortuner', variant: 'Sigma 4 2.8', year: 2021, km: 52000, engine: '2800', fuel: 'Diesel', transmission: 'Auto', color: 'White', city: 'Lahore', registrationCity: 'Punjab', bodyType: 'SUV', assemblyType: 'Local', condition: 'Excellent', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 94, basePrice: 14500000, reservePrice: 15300000, currentBid: 14500000, minimumBidIncrement: 100000, auctionStart: new Date(now.getTime() + day), auctionEnd: new Date(now.getTime() + 3 * day), status: 'active', ownerId: hamza._id, sellerEmail: hamza.email, description: 'Upcoming demo auction: premium Fortuner.', images: [] }],
    ['closed-alto-sold', { make: 'Suzuki', model: 'Alto', variant: 'VXL AGS', year: 2022, km: 24000, engine: '660', fuel: 'Petrol', transmission: 'Auto', color: 'Pearl White', city: 'Rawalpindi', registrationCity: 'Punjab', bodyType: 'Hatchback', assemblyType: 'Local', condition: 'Excellent', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 91, basePrice: 2450000, reservePrice: 2550000, currentBid: 2650000, minimumBidIncrement: 50000, auctionStart: new Date(now.getTime() - 4 * day), auctionEnd: new Date(now.getTime() - day), status: 'ended', ownerId: regular._id, sellerEmail: regular.email, description: 'Closed sold demo auction: reserve met.', images: [] }],
    ['closed-corolla-unsold', { make: 'Toyota', model: 'Corolla', variant: 'GLi Automatic 1.3', year: 2018, km: 98000, engine: '1300', fuel: 'Petrol', transmission: 'Auto', color: 'Silver', city: 'Karachi', registrationCity: 'Sindh', bodyType: 'Sedan', assemblyType: 'Local', condition: 'Fair', verificationStatus: 'verified', inspectionStatus: 'report_available', inspectionScore: 78, basePrice: 3350000, reservePrice: 4000000, currentBid: 3500000, minimumBidIncrement: 50000, auctionStart: new Date(now.getTime() - 6 * day), auctionEnd: new Date(now.getTime() - 2 * day), status: 'ended', ownerId: regular._id, sellerEmail: regular.email, description: 'Closed unsold demo auction: reserve was not met.', images: [] }],
  ]
  const auctions = Object.fromEntries(await Promise.all(auctionSpecs.map(async ([name, fields]) => [name, await syncRecord(Car, key(`auction:${name}`), { ...fields, highestBidder: name === 'upcoming-fortuner' ? undefined : (name === 'closed-alto-sold' || name === 'live-civic' ? waleed._id : hamza._id), bidCount: name === 'live-civic' ? 3 : name === 'closed-alto-sold' ? 2 : name === 'closed-corolla-unsold' ? 1 : 0 })])))

  const bidSpecs = [
    ['live-1', auctions['live-civic']._id, waleed._id, 4650000], ['live-2', auctions['live-civic']._id, hamza._id, 4750000], ['live-3', auctions['live-civic']._id, waleed._id, 4850000],
    ['sold-1', auctions['closed-alto-sold']._id, hamza._id, 2550000], ['sold-2', auctions['closed-alto-sold']._id, waleed._id, 2650000],
    ['unsold-1', auctions['closed-corolla-unsold']._id, hamza._id, 3500000],
  ]
  await Promise.all(bidSpecs.map(([name, carId, bidderId, amount]) => syncRecord(Bid, key(`bid:${name}`), { carId, bidderId, amount })))

  const bookingDate = offset => new Date(now.getTime() + offset * day).toISOString().slice(0, 10)
  const bookingSpecs = [
    ['pending', waleed, { carMake: 'Honda', carModel: 'Civic', carYear: '2020', mileage: '61000', engineCC: '1800', date: bookingDate(2), time: '10:00 AM - 12:00 PM', branch: 'Islamabad Showroom', status: 'pending', notes: 'Awaiting inspection confirmation.' }],
    ['confirmed', hamza, { carMake: 'Toyota', carModel: 'Fortuner', carYear: '2021', mileage: '52000', engineCC: '2800', date: bookingDate(3), time: '12:00 PM - 2:00 PM', branch: 'Lahore Showroom', status: 'confirmed', notes: 'Customer confirmed appointment by phone.' }],
    ['completed', waleed, { carMake: 'Suzuki', carModel: 'Alto', carYear: '2022', mileage: '24000', engineCC: '660', date: bookingDate(-3), time: '10:00 AM - 12:00 PM', branch: 'Rawalpindi Inspection Bay', status: 'completed', notes: 'Inspection completed; report issued.' }],
    ['cancelled', regular, { carMake: 'Kia', carModel: 'Sportage', carYear: '2022', mileage: '28000', engineCC: '2000', date: bookingDate(-1), time: '2:00 PM - 4:00 PM', branch: 'Karachi Showroom', status: 'cancelled', notes: 'Cancelled by customer before arrival.' }],
  ]
  await Promise.all(bookingSpecs.map(([name, member, details]) => syncRecord(Booking, key(`booking:${name}`), {
    memberId: member._id, name: member.name, email: member.email, phone: member.phone, ...details,
  })))
  await OtpChallenge.findOneAndUpdate(
    { email: waleed.email },
    { $set: { email: waleed.email, otpDigest: otpDigest(waleed.email, DEMO_OTP), expiresAt: new Date(now.getTime() + 30 * 60 * 1000), verified: false, attempts: 0, demoKey: key('otp:waleed') } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  )
  await Member.findByIdAndUpdate(waleed._id, { $set: { savedCars: [products['new-corolla']._id, products['used-city']._id, products['used-sportage']._id] } })

  return {
    admin: admin.email,
    accounts: 4,
    cars: await Product.countDocuments({ demoKey: { $regex: `^${DEMO_PREFIX}` } }),
    auctions: await Car.countDocuments({ demoKey: { $regex: `^${DEMO_PREFIX}` } }),
    bids: await Bid.countDocuments({ demoKey: { $regex: `^${DEMO_PREFIX}` } }),
    inspections: await Booking.countDocuments({ demoKey: { $regex: `^${DEMO_PREFIX}` } }),
    savedCars: 3,
  }
}

const resetDemo = async () => {
  requireDemoSeed()
  if (mongoose.connection.readyState === 0) await connectDB()
  const filter = { demoKey: { $regex: `^${DEMO_PREFIX}` } }
  const [bids, cars, products, bookings, otps, memberships, members, admins] = await Promise.all([
    Bid.deleteMany(filter), Car.deleteMany(filter), Product.deleteMany(filter), Booking.deleteMany(filter), OtpChallenge.deleteMany(filter), MembershipPayment.deleteMany(filter), Member.deleteMany(filter), Admin.deleteMany(filter),
  ])
  return { bids: bids.deletedCount, cars: cars.deletedCount, products: products.deletedCount, bookings: bookings.deletedCount, otps: otps.deletedCount, memberships: memberships.deletedCount, members: members.deletedCount, admins: admins.deletedCount }
}

const run = async () => {
  try {
    const result = process.argv.includes('--reset') ? await resetDemo() : await seedDemo()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(`Demo seed failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  }
}

if (require.main === module) run()

module.exports = { DEMO_OTP, seedDemo, resetDemo }
