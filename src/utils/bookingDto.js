const toBookingObject = booking => {
  const output = typeof booking?.toObject === 'function' ? booking.toObject() : { ...booking }
  const id = output._id
  output.hasCnicDocument = Boolean(output.cnicDocument?.key)
  output.hasRegistrationDocument = Boolean(output.registrationDocument?.key)
  if (output.hasCnicDocument) output.cnicDocumentAccessPath = `/documents/bookings/${id}/cnic`
  if (output.hasRegistrationDocument) output.registrationDocumentAccessPath = `/documents/bookings/${id}/registration`
  delete output.cnicDocument
  delete output.registrationDocument
  delete output.cnicImageUrl
  delete output.regDocUrl
  return output
}

module.exports = { toBookingObject }
