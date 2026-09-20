import * as core from '@actions/core'
import * as io from '@actions/io'
import { createClients, getCallerArn, sendPublicKey, waitForInstanceOnline } from './lib/aws.js'
import { InputError, readInputs } from './lib/inputs.js'
import { CONTROL_PATH_MAX, generateKeyPair, keyPaths, writeProvidedKey } from './lib/keys.js'
import { ensureSshDir, renderBlock, upsertBlock } from './lib/ssh-config.js'
import { STATE } from './lib/state.js'

const REQUIRED_TOOLS = [
  {
    name: 'aws',
    fix:
      'Install AWS CLI v2. It is preinstalled on GitHub-hosted runners; on a self-hosted runner use ' +
      'ankurk91/install-aws-cli-action.',
  },
  {
    name: 'session-manager-plugin',
    fix:
      'Install the Session Manager plugin (version 1.1.23.0 or later) with ' +
      'ankurk91/install-session-manager-plugin-action before this step.',
  },
]

const requireTools = async () => {
  for (const { name, fix } of REQUIRED_TOOLS) {
    const resolved = await io.which(name, false)
    if (!resolved) {
      throw new Error(`"${name}" was not found on PATH. This action does not install it. ${fix}`)
    }
    core.debug(`${name} -> ${resolved}`)
  }
}

const run = async () => {
  const startedAt = new Date().toISOString()
  const config = readInputs()

  core.debug(
    `Resolved config: ${JSON.stringify({
      ...config,
      privateKey: config.privateKey ? '<redacted>' : null,
    })}`,
  )

  await requireTools()

  const paths = keyPaths(config)
  await ensureSshDir(config.sshDir)

  const { ssm, eic, sts } = createClients(config.region)

  core.saveState(STATE.started, startedAt)
  core.saveState(STATE.region, config.region)
  core.saveState(STATE.instanceId, config.instanceId)
  core.saveState(STATE.hostAlias, config.hostAlias)
  core.saveState(STATE.sshConfigPath, config.sshConfigPath)
  core.saveState(STATE.privateKeyPath, paths.privateKeyPath)
  core.saveState(STATE.publicKeyPath, paths.publicKeyPath)
  core.saveState(STATE.knownHostsFile, paths.knownHostsFile)
  const controlPathBytes = Buffer.byteLength(paths.controlPath)
  const multiplex = controlPathBytes < CONTROL_PATH_MAX
  if (!multiplex) {
    core.warning(
      `Connection multiplexing is off: the control socket path is ${controlPathBytes} bytes, at or over the ` +
        `${CONTROL_PATH_MAX}-byte limit for Unix sockets, and ssh refuses such a path outright. Every connection ` +
        'will authenticate separately, so a key pushed by EC2 Instance Connect must still be inside its ' +
        '60 second window. A shorter HOME re-enables it.',
    )
  }
  core.saveState(STATE.controlPath, multiplex ? paths.controlPath : '')
  core.saveState(STATE.terminateSessions, String(config.terminateSessions))
  core.saveState(STATE.cleanup, String(config.cleanup))

  core.startGroup('Resolving AWS caller identity')
  try {
    const callerArn = await getCallerArn(sts)
    if (callerArn) core.saveState(STATE.callerArn, callerArn)
    core.info(`Authenticated as ${callerArn ?? 'an unknown principal'} in ${config.region}.`)
  } catch (error) {
    core.warning(
      `Could not call sts:GetCallerIdentity (${error.message}). Session cleanup in the post step will be skipped ` +
        'because the owner of this job\'s sessions cannot be determined.',
    )
  }
  core.endGroup()

  if (config.checkInstance) {
    core.startGroup(`Checking ${config.instanceId} in SSM`)
    try {
      await waitForInstanceOnline({ ssm, instanceId: config.instanceId, timeoutSeconds: config.waitTimeout })
    } finally {
      core.endGroup()
    }
  } else {
    core.info('Skipping the SSM instance check because "check-instance" is false.')
  }

  if (config.privateKey) {
    await writeProvidedKey({ privateKeyPath: paths.privateKeyPath, privateKey: config.privateKey })
    core.info(`Wrote the supplied private key to ${paths.privateKeyPath}.`)
    core.info('Skipping EC2 Instance Connect because "private-key" was supplied.')
  } else {
    const publicKey = await generateKeyPair({
      privateKeyPath: paths.privateKeyPath,
      publicKeyPath: paths.publicKeyPath,
      keyType: config.keyType,
      comment: `setup-ssh-over-ssm-action/${config.instanceId}`,
    })
    core.info(`Generated an ephemeral ${config.keyType} key pair at ${paths.privateKeyPath}.`)

    core.startGroup('Pushing the public key via EC2 Instance Connect')
    try {
      await sendPublicKey({ eic, instanceId: config.instanceId, osUser: config.osUser, publicKey })
      // EC2 Instance Connect holds the key in instance metadata for 60 seconds. That window only has to cover
      // the handshake of the first connection; an established session, and any connection multiplexed onto it
      // through ControlMaster, survives well past it.
      core.info(`Public key accepted for "${config.osUser}". It stays valid on the instance for 60 seconds.`)
    } finally {
      core.endGroup()
    }
  }

  core.startGroup(`Writing the SSH config block for "${config.hostAlias}"`)
  try {
    const block = renderBlock({
      hostAlias: config.hostAlias,
      instanceId: config.instanceId,
      osUser: config.osUser,
      port: config.port,
      region: config.region,
      identityFile: paths.privateKeyPath,
      knownHostsFile: paths.knownHostsFile,
      controlPath: multiplex ? paths.controlPath : null,
    })
    core.debug(block)
    await upsertBlock({ sshConfigPath: config.sshConfigPath, hostAlias: config.hostAlias, block })
    core.info(`Updated ${config.sshConfigPath}.`)
  } finally {
    core.endGroup()
  }

  core.setOutput('host', config.hostAlias)
  core.setOutput('os-user', config.osUser)
  core.setOutput('key-path', paths.privateKeyPath)
  core.setOutput('ssh-config-path', config.sshConfigPath)

  core.info(`Ready. Downstream steps can reach the instance as "${config.hostAlias}".`)
}

try {
  await run()
} catch (error) {
  if (error?.cause) core.debug(`Caused by: ${error.cause.stack ?? error.cause}`)
  core.setFailed(error instanceof InputError ? error.message : (error?.message ?? String(error)))
}
