import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { CONTROL_PATH_MAX, generateKeyPair, keyPaths } from '../../src/lib/keys.js'

const INSTANCE_ID = 'i-0123456789abcdef0'

describe('keyPaths', () => {
  test('derives every path from one run token', () => {
    const paths = keyPaths({ sshDir: '/home/runner/.ssh', hostAlias: 'ssm-target', instanceId: INSTANCE_ID })
    const token = path.basename(paths.controlPath).match(/^ssm-([0-9a-f]{8})\.sock$/)?.[1]

    assert.ok(token, `unexpected control path ${paths.controlPath}`)
    assert.equal(paths.privateKeyPath, `/home/runner/.ssh/ssm-ssm-target-${INSTANCE_ID}-${token}`)
    assert.equal(paths.publicKeyPath, `${paths.privateKeyPath}.pub`)
    assert.equal(paths.knownHostsFile, `${paths.privateKeyPath}.known_hosts`)
  })

  test('gives each run its own paths', () => {
    const args = { sshDir: '/home/runner/.ssh', hostAlias: 'ssm-target', instanceId: INSTANCE_ID }
    assert.notEqual(keyPaths(args).privateKeyPath, keyPaths(args).privateKeyPath)
  })

  test('keeps the control path independent of the alias and instance id', () => {
    const paths = keyPaths({ sshDir: '/home/runner/.ssh', hostAlias: 'a'.repeat(64), instanceId: INSTANCE_ID })
    assert.ok(!paths.controlPath.includes('aaaa'))
    assert.ok(Buffer.byteLength(paths.controlPath) <= CONTROL_PATH_MAX)
  })

  test('leaves room for the temporary suffix ControlMaster appends', () => {
    assert.ok(CONTROL_PATH_MAX + '.'.length + 16 + 1 <= 108)
  })
})

describe('generateKeyPair', () => {
  test('reports what ssh-keygen said when it fails', async () => {
    const privateKeyPath = '/nonexistent-ssh-dir/ssm-key'
    await assert.rejects(
      generateKeyPair({ privateKeyPath, publicKeyPath: `${privateKeyPath}.pub`, keyType: 'ed25519', comment: 't' }),
      /could not generate the ed25519 key pair at \/nonexistent-ssh-dir\/ssm-key: .*No such file or directory.*Check that \/nonexistent-ssh-dir is writable/,
    )
  })
})
