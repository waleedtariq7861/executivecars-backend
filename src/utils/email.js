const axios = require('axios')
const nodemailer = require('nodemailer')

const { isDemoMode } = require('../config/runtime')

const sendEmail = async ({ to, subject, html }) => {
  const mode = String(process.env.EMAIL_DELIVERY_MODE || 'smtp').trim().toLowerCase()

  if (mode === 'resend') {
    const apiKey = String(process.env.RESEND_API_KEY || '').trim()
    const sender = String(process.env.RESEND_FROM_EMAIL || '').trim()
    if (!apiKey || !sender) throw new Error('Resend email delivery requires RESEND_API_KEY and RESEND_FROM_EMAIL')

    try {
      const { data } = await axios.post('https://api.resend.com/emails', {
        from: `Executive Cars <${sender}>`,
        to: [to],
        subject,
        html,
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      })
      if (!data?.id) throw new Error('Resend did not confirm email acceptance')
      return data
    } catch (error) {
      const status = error.response?.status
      throw new Error(status ? `Resend email request failed (HTTP ${status})` : 'Resend email request failed')
    }
  }

  if (mode !== 'smtp' && mode !== 'development') throw new Error('Unsupported email delivery mode')
  if (mode === 'development' && !isDemoMode()) throw new Error('Development email delivery requires demo mode')
  const transporter = mode === 'development'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: (process.env.EMAIL_APP_PASSWORD || process.env.EMAIL_PASS || '').replace(/\s+/g, ''),
        },
      })
  return transporter.sendMail({
    from: `"Executive Cars" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  })
}

const sendOTPEmail = async (to, otp) => {
  await sendEmail({
    to,
    subject: 'Your Executive Cars Verification Code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Verify Your Email Address</h2>
          <p style="color: #64748b;">Use the code below to complete your seller booking request.</p>
          <div style="background: #fff; border: 2px solid #3b82f6; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #1e40af;">${escapeHtml(otp)}</span>
          </div>
          <p style="color: #94a3b8; font-size: 13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
      </div>
    `,
  })
}

const sendVerificationCodeEmail = async (to, { name, code }) => {
  await sendEmail({
    to,
    subject: 'Verify your Executive Cars email address',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Verify your email address</h2>
          <p style="color: #64748b;">Hi ${escapeHtml(name || 'there')}, enter this code on Executive Cars to confirm your email address.</p>
          <div style="background: #fff; border: 2px solid #3b82f6; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #1e40af;">${escapeHtml(code)}</span>
          </div>
          <p style="color: #94a3b8; font-size: 13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone. If you did not create an account, ignore this email.</p>
        </div>
      </div>
    `,
  })
}

const sendBookingConfirmationEmail = async (to, name, date, branch) => {
  const formatted = new Date(date).toLocaleDateString('en-PK', { year: 'numeric', month: 'long', day: 'numeric' })
  await sendEmail({
    to,
    subject: 'Your Inspection Booking is Confirmed — Executive Cars',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Booking Received, ${escapeHtml(name)}!</h2>
          <p style="color: #64748b;">Your inspection slot has been booked. Here are your details:</p>
          <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Inspection Date</p>
            <p style="margin: 0 0 16px; color: #0f172a; font-weight: 700;">${escapeHtml(formatted)}</p>
            <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Branch</p>
            <p style="margin: 0; color: #0f172a; font-weight: 700;">${escapeHtml(branch)}</p>
          </div>
          <p style="color: #64748b;">Our team will review your booking. You will receive an update when its status changes.</p>
          <p style="color: #94a3b8; font-size: 13px; margin-top: 24px;">Our team will contact you when your booking has been reviewed.</p>
        </div>
      </div>
    `,
  })
}

const sendPasswordResetCodeEmail = async (to, { name, code }) => {
  await sendEmail({
    to,
    subject: 'Your Executive Cars password reset code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-radius: 0 0 12px 12px;">
          <h2 style="margin-top: 0;">Reset your password</h2>
          <p style="color: #64748b; line-height: 1.6;">Hi ${escapeHtml(name || 'there')}, enter this code on Executive Cars to choose a new password.</p>
          <div style="background: #fff; border: 2px solid #3b82f6; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #1e40af;">${escapeHtml(code)}</span>
          </div>
          <p style="color: #94a3b8; font-size: 13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone. If you did not ask to reset your password, ignore this email: your password has not changed.</p>
        </div>
      </div>
    `,
  })
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

// Sent after every password change so a change the owner did not make is noticed. It carries no link that
// signs anyone in, only the way to start a reset.
const sendPasswordChangedEmail = async (to, { name, reason = 'change', at = new Date() } = {}) => {
  const clientUrl = String(process.env.CLIENT_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
  const how = reason === 'reset' ? 'using a password reset code' : 'from your account settings'
  const when = new Date(at).toUTCString()
  await sendEmail({
    to,
    subject: 'Your Executive Cars password was changed',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-radius: 0 0 12px 12px;">
          <h2 style="margin-top: 0;">Your password was changed</h2>
          <p style="color: #64748b; line-height: 1.6;">Hi ${escapeHtml(name || 'there')}, the password for your Executive Cars account was changed ${how} on ${escapeHtml(when)}. You were signed out of your other sessions.</p>
          <p style="color: #64748b; line-height: 1.6;">If this was you, no action is needed. If it was not, <a href="${escapeHtml(clientUrl)}/forgot-password" style="color: #2563eb;">reset your password now</a> and contact us.</p>
        </div>
      </div>
    `,
  })
}

const sendInvoiceEmail = async (to, invoice) => {
  const money = value => `${invoice.currency} ${Number(value).toLocaleString('en-PK')}`
  await sendEmail({
    to,
    subject: `Invoice ${invoice.invoiceNumber} from Executive Cars`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-radius: 0 0 12px 12px;">
          <h2 style="margin-top: 0;">Payment received</h2>
          <p style="color: #64748b; line-height: 1.6;">Hi ${escapeHtml(invoice.buyer?.name || 'there')}, thank you. Your invoice is below; you can open it any time from <em>My payments</em> in your account.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 6px 0; color: #64748b;">Invoice</td><td style="text-align: right; font-weight: 700;">${escapeHtml(invoice.invoiceNumber)}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;">${escapeHtml(invoice.lineItems?.[0]?.description || 'Item')}</td><td style="text-align: right;">${escapeHtml(money(invoice.total))}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;">Paid with</td><td style="text-align: right;">${escapeHtml(invoice.payment?.methodLabel || '')}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;">Reference</td><td style="text-align: right;">${escapeHtml(invoice.payment?.reference || '')}</td></tr>
          </table>
          ${invoice.sandbox ? '<p style="color: #b45309; font-size: 13px;">This was a sandbox payment: no real money was charged.</p>' : ''}
        </div>
      </div>
    `,
  })
}

module.exports = { sendOTPEmail, sendVerificationCodeEmail, sendBookingConfirmationEmail, sendPasswordResetCodeEmail, sendPasswordChangedEmail, sendInvoiceEmail }
