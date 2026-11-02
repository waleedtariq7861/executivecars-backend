const hasInspectionReport = record => Boolean(String(record?.inspectionDocument?.key || '').trim())

const toInspectionSafeObject = (record, { reportPath } = {}) => {
  const output = typeof record?.toObject === 'function' ? record.toObject() : { ...record }
  const available = hasInspectionReport(output)

  output.hasInspectionReport = available
  // Provider identifiers are never part of a public or member-facing vehicle DTO.
  // Controllers expose an authorization endpoint instead when the current caller
  // is entitled to the document.
  delete output.inspectionDocument
  if (available) {
    output.inspectionStatus = 'report_available'
    if (reportPath) output.inspectionReportAccessPath = reportPath
  }

  return output
}

module.exports = { hasInspectionReport, toInspectionSafeObject }
