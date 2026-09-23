// SSH key material: ssh-keygen generation, caller-supplied keys, and log masking.

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import { randomBytes } from 'node:crypto'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BOUNDARY = /^-----(BEGIN|END) .*-----$/

// The runner masks exact substrings, so a multi-line key is only reliably hidden when the body lines are
// registered individually alongside the whole value.
const maskPrivateKey = (contents) => {
  core.setSecret(contents)
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 20 && !BOUNDARY.test(trimmed)) core.setSecret(trimmed)
  }
}

// A Unix socket path cannot exceed 108 bytes including the terminator, and ssh exits 255 rather than
// degrading when it does, so the control socket is named by the run token alone instead of the alias and
// instance id. ControlMaster binds a temporary "<path>.<16 random characters>" and links that into place,
// so the path this action writes has to stay 18 bytes clear of 108. The key and known_hosts files have no
// such limit and stay readable.
export const CONTROL_PATH_MAX = 90

// Jobs on one self-hosted runner share $HOME, so paths built from the alias and instance id alone collide:
// ssh-keygen would delete a concurrent run's key before generating its own, both runs would share a control
// socket, and the first post step to finish would remove the other's key. The run identifiers cannot tell
// those jobs apart -- GITHUB_JOB is the same for every leg of a matrix -- so each main step draws a random
// token and hands the paths it built to its own post step through state.
export const keyPaths = ({ sshDir, hostAlias, instanceId }) => {
  const token = randomBytes(4).toString('hex')
  const privateKeyPath = path.join(sshDir, `ssm-${hostAlias}-${instanceId}-${token}`)
  return {
    privateKeyPath,
    publicKeyPath: `${privateKeyPath}.pub`,
    knownHostsFile: `${privateKeyPath}.known_hosts`,
    controlPath: path.join(sshDir, `ssm-${token}.sock`),
  }
}

const requireSshKeygen = async () => {
  const sshKeygen = await io.which('ssh-keygen', false)
  if (!sshKeygen) {
    throw new Error(
      'ssh-keygen was not found on PATH. Install OpenSSH client tools on the runner ' +
        '(they are preinstalled on GitHub-hosted runners).',
    )
  }
  return sshKeygen
}

// An encrypted key carries the same BEGIN line as a plain one, and readInputs checks nothing past that
// line, so only reading the key tells a usable one apart. ssh runs non-interactively on the runner, with no
// agent and no tty, so a key that needs a passphrase fails several steps later as "Permission denied
// (publickey)", which points at IAM or at the 60-second key window instead of at the key. -P '' makes
// ssh-keygen fail rather than prompt.
const assertUsableWithoutPassphrase = async (privateKeyPath) => {
  const sshKeygen = await requireSshKeygen()
  let stderr = ''

  const exitCode = await exec.exec(sshKeygen, ['-y', '-P', '', '-f', privateKeyPath], {
    silent: true,
    ignoreReturnCode: true,
    listeners: { stderr: (chunk) => { stderr += chunk.toString() } },
  })
  if (exitCode === 0) return

  const detail = stderr.trim().split('\n').at(-1) || `ssh-keygen exited with code ${exitCode}`
  throw new Error(
    `Input "private-key" could not be read by ssh-keygen: ${detail}. The key is passphrase-protected, in a ` +
      'format this runner\'s OpenSSH does not support, or truncated. Strip a passphrase with ' +
      'ssh-keygen -p -P \'<old passphrase>\' -N \'\' -f <key>, convert an unsupported key with ' +
      'ssh-keygen -p -N \'\' -f <key> on a machine that reads it, or copy the secret again.',
  )
}

export const generateKeyPair = async ({ privateKeyPath, publicKeyPath, keyType, comment }) => {
  const sshKeygen = await requireSshKeygen()

  await rm(privateKeyPath, { force: true })
  await rm(publicKeyPath, { force: true })

  const args = [
    '-q',
    '-t', keyType,
    ...(keyType === 'rsa' ? ['-b', '4096'] : []),
    '-N', '',
    '-C', comment,
    '-f', privateKeyPath,
  ]

  const exitCode = await exec.exec(sshKeygen, args, { silent: true, ignoreReturnCode: true })
  if (exitCode !== 0) {
    throw new Error(`ssh-keygen exited with code ${exitCode} while generating a ${keyType} key at ${privateKeyPath}.`)
  }

  await chmod(privateKeyPath, 0o600)
  await chmod(publicKeyPath, 0o644)

  maskPrivateKey(await readFile(privateKeyPath, 'utf8'))
  return (await readFile(publicKeyPath, 'utf8')).trim()
}

export const writeProvidedKey = async ({ privateKeyPath, privateKey }) => {
  maskPrivateKey(privateKey)
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 })
  await chmod(privateKeyPath, 0o600)
  await assertUsableWithoutPassphrase(privateKeyPath)
}
