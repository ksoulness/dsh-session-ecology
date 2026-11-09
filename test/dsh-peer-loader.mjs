import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

function findDshHostNodeModules() {
  const directCandidates = []
  if (process.env.DSH_HOST_NODE_MODULES) {
    directCandidates.push(process.env.DSH_HOST_NODE_MODULES.trim())
  }
  if (process.platform === 'win32') {
    directCandidates.push(
      path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'npm',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'node_modules'
      )
    )
  }
  for (const dir of directCandidates) {
    if (dir && fs.existsSync(dir)) return dir
  }
  try {
    const globalRoot = execSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (globalRoot) {
      const candidate = path.join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}

const dshHostNodeModules = findDshHostNodeModules()

if (dshHostNodeModules) {
  const parentUrl = pathToFileURL(path.join(dshHostNodeModules, '_peer_anchor_.mjs')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/')) {
        try {
          return nextResolve(specifier, { ...context, parentURL: parentUrl })
        } catch {}
      }
      return nextResolve(specifier, context)
    },
  })
}
