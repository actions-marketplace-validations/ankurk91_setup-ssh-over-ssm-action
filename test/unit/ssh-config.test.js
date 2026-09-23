import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  findConflictingHost,
  quoteSshPath,
  removeBlock,
  renderBlock,
  stripBlock,
  upsertBlock,
} from '../../src/lib/ssh-config.js'

const SEED = 'ServerAliveCountMax 7\n\nHost *\n  User nobody\n'

const block = (alias, overrides = {}) =>
  renderBlock({
    hostAlias: alias,
    instanceId: 'i-0123456789abcdef0',
    osUser: 'ubuntu',
    port: 22,
    region: 'us-east-1',
    identityFile: '/k',
    knownHostsFile: '/kh',
    controlPath: null,
    sessionReason: 'setup-ssh-over-ssm-action/1/1/deadbeef',
    ...overrides,
  })

describe('quoteSshPath', () => {
  test('wraps the path in double quotes', () => {
    assert.equal(quoteSshPath('/home/a b/.ssh/k'), '"/home/a b/.ssh/k"')
  })

  test('doubles every percent so ssh does not read a token', () => {
    assert.equal(quoteSshPath('/home/u%40corp/%h'), '"/home/u%%40corp/%%h"')
  })
})

describe('renderBlock', () => {
  test('opens with the begin marker and closes the Host stanza before the end marker', () => {
    const lines = block('ssm-target').split('\n')
    assert.equal(lines[0], '# >>> setup-ssh-over-ssm-action: ssm-target >>>')
    assert.equal(lines[1], 'Host ssm-target')
    assert.equal(lines.at(-2), 'Match all')
    assert.equal(lines.at(-1), '# <<< setup-ssh-over-ssm-action: ssm-target <<<')
  })

  test('omits multiplexing when there is no control path', () => {
    assert.doesNotMatch(block('a'), /Control(Master|Path|Persist)/)
  })

  test('adds multiplexing with a quoted control path', () => {
    const out = block('a', { controlPath: '/tmp/h%1/ssm-ab.sock' })
    assert.match(out, /^ {2}ControlMaster auto$/m)
    assert.match(out, /^ {2}ControlPath "\/tmp\/h%%1\/ssm-ab\.sock"$/m)
    assert.match(out, /^ {2}ControlPersist 1h$/m)
  })

  test('stamps the region and session marker onto the ProxyCommand', () => {
    const out = block('a', { region: 'eu-west-2', sessionReason: 'marker/42' })
    assert.match(out, /--region eu-west-2 --reason 'marker\/42'/)
  })
})

describe('stripBlock', () => {
  test('removes only the matching alias', () => {
    const config = `${block('a')}\n${block('b')}\n${SEED}`
    const out = stripBlock(config, 'a')
    assert.doesNotMatch(out, /Host a$/m)
    assert.match(out, /^Host b$/m)
    assert.ok(out.endsWith(SEED))
  })

  test('treats the alias literally, not as a pattern', () => {
    const config = `${block('axb')}\n${SEED}`
    assert.equal(stripBlock(config, 'a.b'), config)
  })

  test('does not strip an alias that only shares a prefix', () => {
    const config = `${block('ssm-target-2')}\n`
    assert.equal(stripBlock(config, 'ssm-target'), config)
  })

  test('removes every copy of the block', () => {
    const config = `${block('a')}\n${SEED}${block('a')}\n`
    assert.doesNotMatch(stripBlock(config, 'a'), /setup-ssh-over-ssm-action/)
  })
})

describe('findConflictingHost', () => {
  test('finds the alias on a Host line with several patterns', () => {
    assert.equal(findConflictingHost('Host web ssm-target db\n', 'ssm-target'), 'Host web ssm-target db')
  })

  test('matches the keyword case-insensitively', () => {
    assert.equal(findConflictingHost('  host ssm-target\n', 'ssm-target'), 'host ssm-target')
  })

  test('ignores a longer alias and a wildcard', () => {
    assert.equal(findConflictingHost('Host ssm-target-2\nHost *\n', 'ssm-target'), null)
  })
})

describe('upsertBlock and removeBlock', () => {
  let dir
  let configPath

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'))
    configPath = path.join(dir, 'config')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const upsert = (alias = 'ssm-target') =>
    upsertBlock({ sshConfigPath: configPath, hostAlias: alias, block: block(alias) })

  test('creates the file with the block alone and mode 600', async () => {
    assert.equal(await upsert(), false)
    assert.equal(await readFile(configPath, 'utf8'), `${block('ssm-target')}\n`)
    assert.equal((await stat(configPath)).mode & 0o777, 0o600)
  })

  test('writes the block above existing content', async () => {
    await writeFile(configPath, SEED)
    await upsert()
    assert.equal(await readFile(configPath, 'utf8'), `${block('ssm-target')}\n\n${SEED}`)
  })

  test('reports a replaced block and keeps a single copy', async () => {
    await writeFile(configPath, SEED)
    await upsert()
    assert.equal(await upsert(), true)
    const contents = await readFile(configPath, 'utf8')
    assert.equal(contents.match(/^Host ssm-target$/gm).length, 1)
  })

  test('refuses an alias the user already defined', async () => {
    await writeFile(configPath, 'Host ssm-target\n  User me\n')
    await assert.rejects(upsert(), /Host alias "ssm-target" is already defined/)
    assert.equal(await readFile(configPath, 'utf8'), 'Host ssm-target\n  User me\n')
  })

  test('remove restores the original config byte for byte', async () => {
    await writeFile(configPath, SEED)
    await upsert()
    assert.equal(await removeBlock({ sshConfigPath: configPath, hostAlias: 'ssm-target' }), true)
    assert.equal(await readFile(configPath, 'utf8'), SEED)
  })

  test('remove leaves another alias in place', async () => {
    await upsert('a')
    await upsert('b')
    await removeBlock({ sshConfigPath: configPath, hostAlias: 'a' })
    assert.equal(await readFile(configPath, 'utf8'), `${block('b')}\n`)
  })

  test('remove empties a file that held only the block', async () => {
    await upsert()
    await removeBlock({ sshConfigPath: configPath, hostAlias: 'ssm-target' })
    assert.equal(await readFile(configPath, 'utf8'), '')
  })

  test('remove is a no-op when the file or the block is missing', async () => {
    assert.equal(await removeBlock({ sshConfigPath: configPath, hostAlias: 'ssm-target' }), false)
    await writeFile(configPath, SEED)
    assert.equal(await removeBlock({ sshConfigPath: configPath, hostAlias: 'ssm-target' }), false)
    assert.equal(await readFile(configPath, 'utf8'), SEED)
  })
})
