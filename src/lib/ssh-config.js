// The managed ~/.ssh/config block: render, upsert, remove.

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MARKER = 'setup-ssh-over-ssm-action'
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const beginMarker = (alias) => `# >>> ${MARKER}: ${alias} >>>`
const endMarker = (alias) => `# <<< ${MARKER}: ${alias} <<<`

const blockPattern = (alias) =>
  new RegExp(
    `(?:^|\\n)[ \\t]*${escapeRegExp(beginMarker(alias))}[\\s\\S]*?${escapeRegExp(endMarker(alias))}[ \\t]*(?=\\n|$)`,
    'g',
  )

const readIfPresent = async (file) => {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export const ensureSshDir = async (sshDir) => {
  await mkdir(sshDir, { recursive: true, mode: 0o700 })
  await chmod(sshDir, 0o700)
}

export const stripBlock = (contents, alias) => contents.replace(blockPattern(alias), '')

export const findConflictingHost = (contents, alias) => {
  for (const line of contents.split('\n')) {
    const match = /^[ \t]*Host[ \t]+(.+?)[ \t]*$/i.exec(line)
    if (match && match[1].split(/[ \t]+/).includes(alias)) return line.trim()
  }
  return null
}

export const renderBlock = ({
  hostAlias,
  instanceId,
  osUser,
  port,
  region,
  identityFile,
  knownHostsFile,
  controlPath,
}) =>
  [
    beginMarker(hostAlias),
    `Host ${hostAlias}`,
    `  HostName ${instanceId}`,
    `  User ${osUser}`,
    `  Port ${port}`,
    `  IdentityFile ${identityFile}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    `  UserKnownHostsFile ${knownHostsFile}`,
    '  ServerAliveInterval 30',
    ...(controlPath
      ? ['  ControlMaster auto', `  ControlPath ${controlPath}`, '  ControlPersist 8h']
      : []),
    // ssh runs ProxyCommand itself, once per connection, and pipes stdin/stdout through it. The AWS CLI is
    // what orchestrates session-manager-plugin to turn the StartSession WebSocket into that byte stream, so
    // this cannot be replaced by an SDK call. --region is explicit so it does not depend on ambient env
    // at connection time.
    `  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region ${region}"`,
    endMarker(hostAlias),
  ].join('\n')

const writeAtomic = async (file, contents) => {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  await writeFile(temp, contents, { mode: 0o600 })
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export const upsertBlock = async ({ sshConfigPath, hostAlias, block }) => {
  const existing = (await readIfPresent(sshConfigPath)) ?? ''
  const withoutOurs = stripBlock(existing, hostAlias)

  const conflict = findConflictingHost(withoutOurs, hostAlias)
  if (conflict) {
    throw new Error(
      `Host alias "${hostAlias}" is already defined in ${sshConfigPath} ("${conflict}"). ` +
        'Choose a different value for the "host-alias" input so this action does not overwrite an existing host.',
    )
  }

  const prefix = withoutOurs.trim() ? `${withoutOurs.replace(/\n*$/, '')}\n\n` : ''
  await writeAtomic(sshConfigPath, `${prefix}${block}\n`)
  await chmod(sshConfigPath, 0o600)
}

export const removeBlock = async ({ sshConfigPath, hostAlias }) => {
  const existing = await readIfPresent(sshConfigPath)
  if (existing === null) return false

  const stripped = stripBlock(existing, hostAlias)
  if (stripped === existing) return false

  const normalised = stripped.replace(/^\n+/, '')
  await writeAtomic(sshConfigPath, normalised.trim() ? `${normalised.replace(/\n*$/, '')}\n` : '')
  await chmod(sshConfigPath, 0o600)
  return true
}
