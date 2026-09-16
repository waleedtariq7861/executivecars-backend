const { readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = resolve(__dirname, '..')
const sourceRoots = ['server', 'src', 'scripts', 'test']

const javascriptFiles = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return javascriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : []
  })

const files = sourceRoots.flatMap(directory => javascriptFiles(join(root, directory)))
let failed = false

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}

if (failed) process.exit(1)
process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`)
