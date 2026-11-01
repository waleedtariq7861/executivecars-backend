const appMode = env => String(env.APP_MODE || (env.NODE_ENV === 'production' ? 'production' : 'demo')).trim().toLowerCase()
const isDemoMode = (env = process.env) => appMode(env) === 'demo' && env.NODE_ENV !== 'production'

const placeholderSecret = value => !value || value.length < 32 || /your_|change[-_ ]?me|local-development|example/i.test(value)

const SESSION_SETTINGS = [
  'SESSION_CUSTOMER_IDLE_DAYS', 'SESSION_CUSTOMER_ABSOLUTE_DAYS', 'SESSION_ADMIN_IDLE_MINUTES', 'SESSION_ADMIN_ABSOLUTE_HOURS',
]

const validateRuntimeConfig = (env = process.env) => {
  const mode = appMode(env)
  for (const name of SESSION_SETTINGS) {
    if (env[name] !== undefined && env[name] !== '' && !(Number(env[name]) > 0)) throw new Error(`${name} must be a positive number`)
  }
  if (env.SESSION_COOKIE_SAMESITE && !['strict', 'lax'].includes(String(env.SESSION_COOKIE_SAMESITE).toLowerCase())) {
    throw new Error('SESSION_COOKIE_SAMESITE must be strict or lax')
  }
  if (env.AUTH_VERIFICATION_CUTOFF && Number.isNaN(new Date(env.AUTH_VERIFICATION_CUTOFF).getTime())) {
    throw new Error('AUTH_VERIFICATION_CUTOFF must be a valid date, for example 2026-11-02T00:00:00Z')
  }
  if (env.HIBP_ENABLED && !['true', 'false'].includes(String(env.HIBP_ENABLED).toLowerCase())) {
    throw new Error('HIBP_ENABLED must be true or false')
  }
  const emailMode = String(env.EMAIL_DELIVERY_MODE || 'smtp').trim().toLowerCase()
  if (!['demo', 'production'].includes(mode)) throw new Error('APP_MODE must be demo or production')
  if (env.ENABLE_HOSTED_DEMO_MEMBERSHIP !== undefined && !['true', 'false'].includes(env.ENABLE_HOSTED_DEMO_MEMBERSHIP)) {
    throw new Error('ENABLE_HOSTED_DEMO_MEMBERSHIP must be true or false')
  }
  if (env.ENABLE_HOSTED_DEMO_MEMBERSHIP === 'true' &&
    (mode !== 'production' || env.NODE_ENV !== 'production' || env.PAYMENT_MODE !== 'disabled')) {
    throw new Error('Hosted membership simulation requires production runtime and PAYMENT_MODE=disabled')
  }
  if (!['development', 'smtp', 'resend'].includes(emailMode)) throw new Error('EMAIL_DELIVERY_MODE must be development, smtp, or resend')
  if (emailMode === 'resend' && (!String(env.RESEND_API_KEY || '').trim() ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(env.RESEND_FROM_EMAIL || '').trim()))) {
    throw new Error('Resend email delivery requires RESEND_API_KEY and a valid RESEND_FROM_EMAIL')
  }
  if (mode === 'demo' && env.NODE_ENV === 'production') throw new Error('APP_MODE=demo cannot run with NODE_ENV=production')
  if (mode === 'production') {
    if (env.NODE_ENV !== 'production') throw new Error('APP_MODE=production requires NODE_ENV=production')
    if (emailMode === 'development') throw new Error('Production mode cannot use development email delivery')
    if (env.REQUIRE_CLOUDINARY === 'true' && [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET]
      .some(value => !value || /^(your_|local-development)/i.test(value))) {
      throw new Error('Durable uploads require all three Cloudinary credentials')
    }
    if (env.ENABLE_DEMO_SEED === 'true') throw new Error('Production mode cannot enable demo data seeding')
    if (env.PAYMENT_MODE === 'demo') throw new Error('Production mode cannot expose demo membership payments')
    if (placeholderSecret(String(env.JWT_SECRET || ''))) throw new Error('Production mode requires a non-placeholder JWT_SECRET of at least 32 characters')
    const origins = [env.CLIENT_URL, ...(env.CLIENT_URLS || '').split(',')].map(value => String(value || '').trim()).filter(Boolean)
    if (!origins.length || origins.some(origin => !origin.startsWith('https://') || /localhost|127\.0\.0\.1/i.test(origin))) {
      throw new Error('Production mode requires at least one HTTPS client origin and forbids localhost origins')
    }
  }
  return { appMode: mode, demo: isDemoMode(env) }
}

module.exports = { appMode, isDemoMode, validateRuntimeConfig }
