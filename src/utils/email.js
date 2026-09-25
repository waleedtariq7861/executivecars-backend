const nodemailer = require('nodemailer')

const { isDemoMode } = require('../config/runtime')
const developmentDelivery = isDemoMode() && process.env.EMAIL_DELIVERY_MODE === 'development'
const transporter = developmentDelivery
  ? nodemailer.createTransport({ jsonTransport: true })
  : nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: (process.env.EMAIL_APP_PASSWORD || process.env.EMAIL_PASS || '').replace(/\s+/g, ''),
      },
    })

const sendOTPEmail = async (to, otp) => {
  await transporter.sendMail({
    from: `"Executive Cars" <${process.env.EMAIL_USER}>`,
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
            <span style="font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #1e40af;">${otp}</span>
          </div>
          <p style="color: #94a3b8; font-size: 13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
      </div>
    `,
  })
}

const sendSellerCredentials = async (to, name, password) => {
  await transporter.sendMail({
    from: `"Executive Cars" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Your Executive Cars Seller Account is Ready',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Welcome, ${name}!</h2>
          <p style="color: #64748b;">Your inspection booking has been <strong>approved</strong>. Your seller account has been created.</p>
          <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Login Email</p>
            <p style="margin: 0 0 16px; color: #0f172a; font-weight: 700;">${to}</p>
            <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Temporary Password</p>
            <p style="margin: 0; color: #1e40af; font-weight: 700; font-size: 18px; letter-spacing: 2px;">${password}</p>
          </div>
          <p style="color: #94a3b8; font-size: 13px;">Please log in and change your password from your profile settings.</p>
          <a href="${process.env.CLIENT_URL}/login" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 8px;">Login to Seller Portal</a>
        </div>
      </div>
    `,
  })
}

const sendBookingConfirmationEmail = async (to, name, date, branch) => {
  const formatted = new Date(date).toLocaleDateString('en-PK', { year: 'numeric', month: 'long', day: 'numeric' })
  await transporter.sendMail({
    from: `"Executive Cars" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Your Inspection Booking is Confirmed — Executive Cars',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Booking Received, ${name}!</h2>
          <p style="color: #64748b;">Your inspection slot has been booked. Here are your details:</p>
          <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Inspection Date</p>
            <p style="margin: 0 0 16px; color: #0f172a; font-weight: 700;">${formatted}</p>
            <p style="margin: 0 0 8px; color: #64748b; font-size: 13px;">Branch</p>
            <p style="margin: 0; color: #0f172a; font-weight: 700;">${branch}</p>
          </div>
          <p style="color: #64748b;">Our team will review your booking. You will receive an update when its status changes.</p>
          <p style="color: #94a3b8; font-size: 13px; margin-top: 24px;">If you have any questions, reply to this email or contact us at info@executivecars.pk</p>
        </div>
      </div>
    `,
  })
}

const sendPasswordResetEmail = async (to, resetUrl) => {
  await transporter.sendMail({
    from: `"Executive Cars" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Reset your Executive Cars password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <div style="background: #0f172a; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Executive <span style="color: #3b82f6;">Cars</span></h1>
        </div>
        <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-radius: 0 0 12px 12px;">
          <h2 style="margin-top: 0;">Reset your password</h2>
          <p style="color: #64748b; line-height: 1.6;">Use the button below within 30 minutes. If you did not request a reset, ignore this email.</p>
          <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 700; margin: 12px 0;">Choose a new password</a>
          <p style="color: #94a3b8; font-size: 12px; word-break: break-all;">${resetUrl}</p>
        </div>
      </div>
    `,
  })
}

module.exports = { sendOTPEmail, sendSellerCredentials, sendBookingConfirmationEmail, sendPasswordResetEmail }
