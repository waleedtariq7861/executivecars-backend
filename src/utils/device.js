// A short, human description of a browser from its user-agent header ("Chrome on Windows"). Deliberately coarse:
// it is only there so a person can recognise their own devices in a list.
const describeDevice = (userAgent) => {
  const text = String(userAgent || '')
  if (!text) return 'Unknown device'
  const browser = /Edg\//.test(text) ? 'Edge'
    : /OPR\/|Opera/.test(text) ? 'Opera'
      : /Firefox\//.test(text) ? 'Firefox'
        : /Chrome\/|CriOS\//.test(text) ? 'Chrome'
          : /Safari\//.test(text) ? 'Safari' : 'Browser'
  const system = /Windows/.test(text) ? 'Windows'
    : /Android/.test(text) ? 'Android'
      : /iPhone|iPad|iPod/.test(text) ? 'iOS'
        : /Mac OS X|Macintosh/.test(text) ? 'macOS'
          : /Linux|X11/.test(text) ? 'Linux' : 'an unknown system'
  return `${browser} on ${system}`
}

module.exports = { describeDevice }
