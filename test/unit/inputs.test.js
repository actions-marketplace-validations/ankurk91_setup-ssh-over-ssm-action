import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { InputError, readInputs } from '../../src/lib/inputs.js'

const DEFAULTS = {
  'INPUT_INSTANCE-ID': 'i-0123456789abcdef0',
  'INPUT_OS-USER': 'ubuntu',
  'INPUT_HOST-ALIAS': 'ssm-target',
  INPUT_REGION: 'us-east-1',
  INPUT_PORT: '22',
  'INPUT_KEY-TYPE': 'ed25519',
  'INPUT_PRIVATE-KEY': '',
  'INPUT_CHECK-INSTANCE': 'true',
  'INPUT_WAIT-TIMEOUT': '30',
  'INPUT_TERMINATE-SESSIONS': 'true',
  INPUT_CLEANUP: 'true',
  HOME: '/home/runner',
}

const KEY_BODY = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----`

let saved

beforeEach(() => {
  saved = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key === 'AWS_REGION' || key === 'AWS_DEFAULT_REGION') delete process.env[key]
  }
  Object.assign(process.env, DEFAULTS)
})

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, saved)
})

const read = (overrides = {}) => {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return readInputs()
}

const rejects = (overrides, pattern) => assert.throws(() => read(overrides), (error) => {
  assert.ok(error instanceof InputError, `expected an InputError, got ${error?.constructor?.name}`)
  assert.match(error.message, pattern)
  return true
})

describe('readInputs defaults', () => {
  test('returns a frozen config with paths under HOME', () => {
    const config = read()
    assert.ok(Object.isFrozen(config))
    assert.deepEqual(config, {
      instanceId: 'i-0123456789abcdef0',
      osUser: 'ubuntu',
      hostAlias: 'ssm-target',
      region: 'us-east-1',
      keyType: 'ed25519',
      port: 22,
      waitTimeout: 30,
      privateKey: null,
      checkInstance: true,
      terminateSessions: true,
      cleanup: true,
      sshDir: '/home/runner/.ssh',
      sshConfigPath: '/home/runner/.ssh/config',
    })
  })

  test('trims surrounding whitespace', () => {
    const config = read({ 'INPUT_INSTANCE-ID': '  i-0123456789abcdef0 \n', 'INPUT_HOST-ALIAS': ' web ' })
    assert.equal(config.instanceId, 'i-0123456789abcdef0')
    assert.equal(config.hostAlias, 'web')
  })
})

describe('instance-id', () => {
  for (const id of ['i-01234567', 'i-0123456789abcdef0', 'mi-0123456789abcdef0']) {
    test(`accepts ${id}`, () => assert.equal(read({ 'INPUT_INSTANCE-ID': id }).instanceId, id))
  }

  for (const id of ['i-0123456789ABCDEF0', 'i-012345678', 'sg-0123456789abcdef0', 'i-0123456789abcdef0;id']) {
    test(`rejects ${id}`, () => rejects({ 'INPUT_INSTANCE-ID': id }, /"instance-id": received/))
  }

  test('is required', () => {
    assert.throws(() => read({ 'INPUT_INSTANCE-ID': undefined }), /Input required and not supplied: instance-id/)
  })
})

describe('os-user', () => {
  for (const user of ['ubuntu', 'ec2-user', 'first.last', '_svc']) {
    test(`accepts ${user}`, () => assert.equal(read({ 'INPUT_OS-USER': user }).osUser, user))
  }

  for (const user of ['', '-leading-dash', 'a'.repeat(33), 'root;id', 'with space']) {
    test(`rejects ${JSON.stringify(user)}`, () => rejects({ 'INPUT_OS-USER': user }, /"os-user"/))
  }
})

describe('host-alias', () => {
  test('accepts 64 characters', () => {
    assert.equal(read({ 'INPUT_HOST-ALIAS': 'a'.repeat(64) }).hostAlias, 'a'.repeat(64))
  })

  for (const alias of ['a'.repeat(65), 'web*', 'two words', '']) {
    test(`rejects ${JSON.stringify(alias)}`, () => rejects({ 'INPUT_HOST-ALIAS': alias }, /"host-alias"/))
  }
})

describe('region', () => {
  test('falls back to AWS_REGION', () => {
    assert.equal(read({ INPUT_REGION: '', AWS_REGION: 'eu-west-2' }).region, 'eu-west-2')
  })

  test('falls back to AWS_DEFAULT_REGION', () => {
    assert.equal(read({ INPUT_REGION: '', AWS_DEFAULT_REGION: 'ap-south-1' }).region, 'ap-south-1')
  })

  test('prefers the input over the environment', () => {
    assert.equal(read({ AWS_REGION: 'eu-west-2' }).region, 'us-east-1')
  })

  test('accepts a GovCloud region', () => {
    assert.equal(read({ INPUT_REGION: 'us-gov-west-1' }).region, 'us-gov-west-1')
  })

  test('fails when nothing resolves', () => rejects({ INPUT_REGION: '' }, /No AWS region could be resolved/))

  test('rejects shell metacharacters', () => rejects({ INPUT_REGION: 'us-east-1;id' }, /shell metacharacters/))

  test('rejects a malformed region', () => rejects({ INPUT_REGION: 'us-east' }, /an AWS region such as/))
})

describe('key-type', () => {
  test('accepts rsa', () => assert.equal(read({ 'INPUT_KEY-TYPE': 'rsa' }).keyType, 'rsa'))
  test('rejects dsa', () => rejects({ 'INPUT_KEY-TYPE': 'dsa' }, /one of ed25519, rsa/))
})

describe('integers', () => {
  test('accepts the port bounds', () => {
    assert.equal(read({ INPUT_PORT: '1' }).port, 1)
    assert.equal(read({ INPUT_PORT: '65535' }).port, 65535)
  })

  for (const port of ['0', '65536', '22abc', '-22', '2.5', '']) {
    test(`rejects port ${JSON.stringify(port)}`, () => rejects({ INPUT_PORT: port }, /"port".*between 1 and 65535/))
  }

  test('accepts a wait-timeout of 0', () => assert.equal(read({ 'INPUT_WAIT-TIMEOUT': '0' }).waitTimeout, 0))
  test('rejects a wait-timeout over an hour', () => rejects({ 'INPUT_WAIT-TIMEOUT': '3601' }, /"wait-timeout"/))
})

describe('booleans', () => {
  test('reads false', () => {
    const config = read({ INPUT_CLEANUP: 'false', 'INPUT_TERMINATE-SESSIONS': 'False', 'INPUT_CHECK-INSTANCE': 'FALSE' })
    assert.equal(config.cleanup, false)
    assert.equal(config.terminateSessions, false)
    assert.equal(config.checkInstance, false)
  })

  test('rejects yes', () => rejects({ INPUT_CLEANUP: 'yes' }, /"cleanup": received "yes"/))
})

describe('private-key', () => {
  test('appends a missing trailing newline', () => {
    assert.equal(read({ 'INPUT_PRIVATE-KEY': PRIVATE_KEY }).privateKey, `${PRIVATE_KEY}\n`)
  })

  test('converts CRLF line endings to LF', () => {
    const crlf = `${PRIVATE_KEY.replaceAll('\n', '\r\n')}\r\n`
    assert.equal(read({ 'INPUT_PRIVATE-KEY': crlf }).privateKey, `${PRIVATE_KEY}\n`)
  })

  test('treats whitespace as absent', () => {
    assert.equal(read({ 'INPUT_PRIVATE-KEY': '  \n' }).privateKey, null)
  })

  for (const label of ['OPENSSH', 'RSA', 'EC', 'ENCRYPTED', '']) {
    const begin = `-----BEGIN ${label ? `${label} ` : ''}PRIVATE KEY-----`
    test(`leaves ${begin} to ssh-keygen`, () => {
      const key = `${begin}\n${KEY_BODY}\n-----END ${label ? `${label} ` : ''}PRIVATE KEY-----\n`
      assert.equal(read({ 'INPUT_PRIVATE-KEY': key }).privateKey, key)
    })
  }

  test('rejects a public key', () => {
    rejects({ 'INPUT_PRIVATE-KEY': 'ssh-ed25519 AAAAC3Nza e2e' }, /is not a PEM or OpenSSH private key/)
  })

  test('rejects a key whose BEGIN line was lost', () => {
    rejects({ 'INPUT_PRIVATE-KEY': `${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----` }, /does not start with/)
  })

  test('never echoes the key in the error', () => {
    assert.throws(
      () => read({ 'INPUT_PRIVATE-KEY': `junk\n${KEY_BODY}` }),
      (error) => error instanceof InputError && !error.message.includes(KEY_BODY),
    )
  })
})

describe('HOME', () => {
  test('accepts a space and a percent', () => {
    assert.equal(read({ HOME: '/home/a b%40corp' }).sshConfigPath, '/home/a b%40corp/.ssh/config')
  })

  for (const home of ['/home/a"b', '/home/a\\b', '/home/${USER}', '/home/a\tb']) {
    test(`rejects ${JSON.stringify(home)}`, () => rejects({ HOME: home }, /cannot be written into an SSH config/))
  }
})
