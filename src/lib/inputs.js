// Reads and validates every action input, and resolves the region.

import * as core from '@actions/core'
import os from 'node:os'
import path from 'node:path'

const INSTANCE_ID = /^(i|mi)-[0-9a-f]{8}([0-9a-f]{9})?$/
const POSIX_USER = /^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,31}$/
const HOST_ALIAS = /^[A-Za-z0-9._-]{1,64}$/
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+){1,2}-\d$/
const UNSAFE = /[\s;&|`$(){}<>\\"'!*?[\]~#]/
const KEY_TYPES = new Set(['ed25519', 'rsa'])

export class InputError extends Error {}

const fail = (name, received, expected) => {
  throw new InputError(
    `Invalid value for input "${name}": received ${JSON.stringify(received)}. Expected ${expected}.`,
  )
}

const assertSafe = (name, value) => {
  if (UNSAFE.test(value)) {
    fail(name, value, 'a value with no whitespace, quotes or shell metacharacters')
  }
  return value
}

const readBoolean = (name) => {
  try {
    return core.getBooleanInput(name)
  } catch {
    fail(name, core.getInput(name), 'one of true, True, TRUE, false, False, FALSE')
  }
}

const readInteger = (name, { min, max }) => {
  const raw = core.getInput(name).trim()
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(name, raw, `an integer between ${min} and ${max}`)
  }
  return value
}

const resolveRegion = () => {
  const explicit = core.getInput('region').trim()
  if (explicit) return assertSafe('region', explicit)

  const ambient = (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '').trim()
  if (!ambient) {
    throw new InputError(
      'No AWS region could be resolved. Set the "region" input, or configure AWS_REGION / AWS_DEFAULT_REGION ' +
        '(aws-actions/configure-aws-credentials exports both when you pass aws-region).',
    )
  }
  return assertSafe('region', ambient)
}

// A key pasted from a Windows editor carries CRLF, which ssh-keygen refuses as "error in libcrypto". The
// shape check only turns away a value that is plainly not a key; ssh-keygen decides whether it loads.
const resolvePrivateKey = () => {
  const raw = core.getInput('private-key')
  if (!raw) return null

  const key = `${raw.replace(/\r\n?/g, '\n').trimEnd()}\n`
  if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\n/.test(key)) {
    throw new InputError(
      'Input "private-key" is not a PEM or OpenSSH private key: it does not start with a ' +
        '"-----BEGIN ... PRIVATE KEY-----" line. Pass it through a secret and keep the literal newlines intact ' +
        '(use the | block scalar in YAML).',
    )
  }
  return key
}

// Every input is validated, but the home directory is not one, and it is the only part of the rendered
// block this action does not choose. Quoting carries a space or a percent; nothing carries a quote, a
// backslash, or ${, which ssh expands from the environment and fails on when the variable is unset.
const resolveSshDir = () => {
  const home = os.homedir()
  const unrepresentable = /["\\]|\$\{/.test(home) || [...home].some((char) => char.codePointAt(0) < 0x20)
  if (unrepresentable) {
    throw new InputError(
      `The home directory ${JSON.stringify(home)} cannot be written into an SSH config: ssh reads ", \\ ` +
        'and ${ as syntax with no way to escape them, and a control character ends the line. ' +
        'Run this job with a HOME that contains none of those.',
    )
  }
  return path.join(home, '.ssh')
}

export const readInputs = () => {
  const instanceId = core.getInput('instance-id', { required: true }).trim()
  if (!INSTANCE_ID.test(instanceId)) {
    fail('instance-id', instanceId, 'an EC2 or managed instance ID such as i-0123456789abcdef0 or mi-0123456789abcdef0')
  }

  const osUser = core.getInput('os-user').trim()
  if (!POSIX_USER.test(osUser)) {
    fail(
      'os-user',
      osUser,
      'a user name matching ^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,31}$, such as ubuntu, ec2-user or first.last',
    )
  }

  const hostAlias = core.getInput('host-alias').trim()
  if (!HOST_ALIAS.test(hostAlias)) {
    fail('host-alias', hostAlias, 'an SSH host alias matching ^[A-Za-z0-9._-]{1,64}$, such as ssm-target')
  }

  const region = resolveRegion()
  if (!AWS_REGION.test(region)) {
    fail('region', region, 'an AWS region such as us-east-1, eu-west-2 or us-gov-west-1')
  }

  const keyType = core.getInput('key-type').trim()
  if (!KEY_TYPES.has(keyType)) {
    fail('key-type', keyType, `one of ${[...KEY_TYPES].join(', ')}`)
  }

  const sshDir = resolveSshDir()

  return Object.freeze({
    instanceId,
    osUser,
    hostAlias,
    region,
    keyType,
    port: readInteger('port', { min: 1, max: 65535 }),
    waitTimeout: readInteger('wait-timeout', { min: 0, max: 3600 }),
    privateKey: resolvePrivateKey(),
    checkInstance: readBoolean('check-instance'),
    terminateSessions: readBoolean('terminate-sessions'),
    cleanup: readBoolean('cleanup'),
    sshDir,
    sshConfigPath: path.join(sshDir, 'config'),
  })
}
