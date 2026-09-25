const appMode = env => String(env.APP_MODE || (env.NODE_ENV === 'production' ? 'production' : 'demo')).trim().toLowerCase()
const isDemoMode = (env = process.env) => appMode(env) === 'demo' && env.NODE_ENV !== 'production'

const placeholderSecret = value => !value || value.length < 32 || /your_|change[-_ ]?me|local-development|example/i.test(value)

const validateRuntimeConfig = (env = process.env) => {
  const mode = appMode(env)
  if (!['demo', 'production'].includes(mode)) throw new Error('APP_MODE must be demo or production')
  if (mode === 'demo' && env.NODE_ENV === 'production') throw new Error('APP_MODE=demo cannot run with NODE_ENV=production')
  if (mode === 'production') {
    if (env.NODE_ENV !== 'production') throw new Error('APP_MODE=production requires NODE_ENV=production')
    if (env.EMAIL_DELIVERY_MODE === 'development') throw new Error('Production mode cannot use development email delivery')
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
