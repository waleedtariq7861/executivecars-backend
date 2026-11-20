// File names shown to the person who opens a private document. They are built only from safe ASCII so that
// neither car data nor stored metadata can break out of the Content-Disposition header.
const slug = value => String(value ?? '')
  .normalize('NFKD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const safeExtension = extension => (/^\.[a-z0-9]{1,5}$/i.test(String(extension || '')) ? extension : '')

const reportFileName = ({ make, model, year } = {}) => {
  const parts = [make, model, year].map(slug).filter(Boolean)
  return [...parts, 'inspection-report'].join('-') + '.pdf'
}

const bookingDocumentFileName = (kind, asset) => `${kind}-document${safeExtension(asset?.extension)}`

// Only printable ASCII may reach a header (a character above U+00FF would make Node throw), and neither a quote nor a
// backslash may end the quoted value.
const contentDisposition = fileName => `inline; filename="${String(fileName).replace(/[^\x20-\x7e]|["\\]/g, '')}"`

module.exports = { reportFileName, bookingDocumentFileName, contentDisposition }
