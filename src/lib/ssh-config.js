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

// ssh parses the whole config before it uses any of it, so an unquoted space is not a bad directive, it
// is a syntax error that takes every host in the file down with it. A bare % starts a token (%d, %h, %C)
// and fails to expand on a home directory like /home/user%40corp. Quoting carries both; readInputs rejects
// the characters it cannot carry.
export const quoteSshPath = (value) => `"${value.replaceAll('%', '%%')}"`

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
    `  IdentityFile ${quoteSshPath(identityFile)}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    `  UserKnownHostsFile ${quoteSshPath(knownHostsFile)}`,
    '  ServerAliveInterval 30',
    ...(controlPath
      ? ['  ControlMaster auto', `  ControlPath ${quoteSshPath(controlPath)}`, '  ControlPersist 1h']
      : []),
    // ssh runs ProxyCommand itself, once per connection, and pipes stdin/stdout through it. The AWS CLI is
    // what orchestrates session-manager-plugin to turn the StartSession WebSocket into that byte stream, so
    // this cannot be replaced by an SDK call. --region is explicit so it does not depend on ambient env
    // at connection time.
    `  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region ${region}"`,
    // upsertBlock writes this block first in the file, so the Host stanza has to be closed again here.
    // Without it, directives the user kept above their first Host line, which applied to every host,
    // would be read as part of this stanza and silently stop applying to the rest of them.
    'Match all',
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

  // ssh keeps the first value it obtains for each parameter, so the block goes at the top of the file.
  // Appended last, any earlier stanza matching the alias -- a `Host *` on a self-hosted runner, say --
  // would outrank User and ProxyCommand, and the connection would silently bypass Session Manager.
  const rest = withoutOurs.replace(/^\n+/, '').replace(/\n*$/, '')
  const suffix = rest.trim() ? `\n${rest}\n` : ''
  await writeAtomic(sshConfigPath, `${block}\n${suffix}`)
  await chmod(sshConfigPath, 0o600)
  return withoutOurs !== existing
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
