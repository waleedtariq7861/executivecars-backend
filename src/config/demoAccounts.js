const demoValue = (name, fallback) => String(process.env[name] || fallback).trim()

const demoAccounts = () => ({
  admin: { name: 'Executive Cars Admin', email: demoValue('DEMO_ADMIN_EMAIL', 'admin@executivecars.pk').toLowerCase(), password: demoValue('DEMO_ADMIN_PASSWORD', 'Admin@12345'), role: 'admin' },
  premium: {
    name: 'Waleed Tariq', email: demoValue('DEMO_MEMBER_EMAIL', 'member@executivecars.pk').toLowerCase(), password: demoValue('DEMO_MEMBER_PASSWORD', 'Member@12345'), phone: '+92 300 1112233', city: 'Islamabad', role: 'user',
    subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), membershipSource: 'demo',
  },
  regular: {
    name: 'Demo User', email: demoValue('DEMO_USER_EMAIL', 'user@executivecars.pk').toLowerCase(), password: demoValue('DEMO_USER_PASSWORD', 'User@12345'), phone: '+92 300 2223344', city: 'Rawalpindi', role: 'user',
    subscriptionStatus: 'inactive', subscriptionExpiry: undefined, membershipSource: undefined,
  },
  bidder: {
    name: 'Hamza Ali', email: demoValue('DEMO_BIDDER_EMAIL', 'bidder@executivecars.pk').toLowerCase(), password: demoValue('DEMO_BIDDER_PASSWORD', 'Bidder@12345'), phone: '+92 300 3334455', city: 'Lahore', role: 'user',
    subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), membershipSource: 'demo',
  },
})

module.exports = { demoAccounts }
