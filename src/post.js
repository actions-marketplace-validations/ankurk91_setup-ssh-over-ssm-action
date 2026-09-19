import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import { rm } from 'node:fs/promises'
import { createClients, listActiveSessions, terminateSession } from './lib/aws.js'
import { removeBlock } from './lib/ssh-config.js'
import { STATE } from './lib/state.js'

const state = (key) => core.getState(STATE[key])
const isTrue = (key) => state(key) === 'true'

const attempt = async (what, fn) => {
  try {
    await fn()
  } catch (error) {
    core.warning(`${what} failed: ${error?.message ?? error}`)
  }
}

const closeControlMaster = async ({ hostAlias, controlPath }) => {
  const ssh = await io.which('ssh', false)
  if (!ssh || !controlPath) return

  const exitCode = await exec.exec(ssh, ['-O', 'exit', '-o', `ControlPath=${controlPath}`, hostAlias], {
    silent: true,
    ignoreReturnCode: true,
  })
  core.debug(`ssh -O exit ${hostAlias} exited with ${exitCode}`)
  await rm(controlPath, { force: true })
}

// Only sessions owned by this job's caller identity and started at or after the main step are terminated.
// A looser filter would kill a concurrent job's session when several jobs share a self-hosted runner and
// assume the same role with the same role-session-name.
const terminateOwnSessions = async ({ region, instanceId, callerArn, startedAt }) => {
  if (!callerArn) {
    core.warning('No caller identity was recorded, so active SSM sessions were left alone.')
    return
  }

  const since = Date.parse(startedAt)
  if (Number.isNaN(since)) {
    core.warning('No valid start timestamp was recorded, so active SSM sessions were left alone.')
    return
  }

  const { ssm } = createClients(region)
  const sessions = await listActiveSessions({ ssm, target: instanceId })
  const own = sessions.filter(
    (session) => session.Owner === callerArn && session.StartDate instanceof Date && session.StartDate.getTime() >= since,
  )

  if (own.length === 0) {
    core.info('No active SSM sessions from this job were left open.')
    return
  }

  for (const session of own) {
    await attempt(`Terminating session ${session.SessionId}`, async () => {
      await terminateSession({ ssm, sessionId: session.SessionId })
      core.info(`Terminated SSM session ${session.SessionId}.`)
    })
  }
}

const run = async () => {
  const hostAlias = state('hostAlias')
  if (!hostAlias) {
    core.info('The main step did not get far enough to change anything; nothing to clean up.')
    return
  }

  const cleanup = isTrue('cleanup')

  if (cleanup) {
    await attempt('Closing the SSH control master', () =>
      closeControlMaster({ hostAlias, controlPath: state('controlPath') }),
    )
  }

  if (isTrue('terminateSessions')) {
    await attempt('Terminating SSM sessions', () =>
      terminateOwnSessions({
        region: state('region'),
        instanceId: state('instanceId'),
        callerArn: state('callerArn'),
        startedAt: state('started'),
      }),
    )
  }

  if (!cleanup) {
    core.info('Leaving the SSH config block and key material in place because "cleanup" is false.')
    return
  }

  await attempt('Removing the managed SSH config block', async () => {
    const removed = await removeBlock({ sshConfigPath: state('sshConfigPath'), hostAlias })
    core.info(
      removed
        ? `Removed the "${hostAlias}" block from ${state('sshConfigPath')}.`
        : `No "${hostAlias}" block was present in ${state('sshConfigPath')}.`,
    )
  })

  // The private key file is always one this action wrote, including when the caller supplied "private-key",
  // so removing it never destroys anything the caller still holds.
  await attempt('Removing the generated key material', async () => {
    for (const key of ['privateKeyPath', 'publicKeyPath', 'knownHostsFile']) {
      const target = state(key)
      if (target) await rm(target, { force: true })
    }
    core.info('Removed the key material written by this action.')
  })
}

try {
  await run()
} catch (error) {
  core.warning(`Post step did not complete cleanly: ${error?.message ?? error}`)
}
