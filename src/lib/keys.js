// SSH key material: ssh-keygen generation, caller-supplied keys, and log masking.

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
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

export const keyPaths = ({ sshDir, hostAlias, instanceId }) => {
  const privateKeyPath = path.join(sshDir, `ssm-${hostAlias}-${instanceId}`)
  return {
    privateKeyPath,
    publicKeyPath: `${privateKeyPath}.pub`,
    knownHostsFile: path.join(sshDir, `ssm-${hostAlias}-${instanceId}.known_hosts`),
    controlPath: path.join(sshDir, `ssm-${hostAlias}-${instanceId}.sock`),
  }
}

export const generateKeyPair = async ({ privateKeyPath, publicKeyPath, keyType, comment }) => {
  const sshKeygen = await io.which('ssh-keygen', false)
  if (!sshKeygen) {
    throw new Error(
      'ssh-keygen was not found on PATH. Install OpenSSH client tools on the runner ' +
        '(they are preinstalled on GitHub-hosted runners).',
    )
  }

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
}
