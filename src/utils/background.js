// Runs a notification (usually an email) without making the response wait for it or depend on it. A failure
// is logged and handed to `onFailure` (so it can be recorded where an administrator can see it), never reported
// to the caller; the call itself starts immediately.
const sendInBackground = (label, send, onFailure) => {
  const report = (error) => {
    console.error(`${label} email delivery failed:`, error?.message || error)
    const hookFailed = failure => console.error(`${label} failure hook failed:`, failure?.message || failure)
    try { Promise.resolve(onFailure?.(error)).catch(hookFailed) } catch (failure) { hookFailed(failure) }
  }
  try { Promise.resolve(send()).catch(report) } catch (error) { report(error) }
}

module.exports = { sendInBackground }
