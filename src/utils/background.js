// Runs a notification (usually an email) without making the response wait for it or depend on it. A failure
// is logged, never reported to the caller; the call itself starts immediately.
const sendInBackground = (label, send) => {
  const report = error => console.error(`${label} email delivery failed:`, error?.message || error)
  try { Promise.resolve(send()).catch(report) } catch (error) { report(error) }
}

module.exports = { sendInBackground }
