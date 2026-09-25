// AWS SDK v3 control-plane calls: SSM registration and sessions, EC2 Instance Connect.

import * as core from '@actions/core'
import { SendSSHPublicKeyCommand, EC2InstanceConnectClient } from '@aws-sdk/client-ec2-instance-connect'
import {
  DescribeInstanceInformationCommand,
  DescribeSessionsCommand,
  SSMClient,
  TerminateSessionCommand,
} from '@aws-sdk/client-ssm'
import { setTimeout as sleep } from 'node:timers/promises'

// The default Node handler never times out, so an endpoint that accepts a connection and never answers -- a
// broken proxy, or a VPC interface endpoint whose DNS resolves -- would hang the step until the job's
// timeout-minutes. requestTimeout on its own only logs a warning; throwOnRequestTimeout makes it an error.
const clientConfig = (region) => ({
  region,
  requestHandler: { connectionTimeout: 5000, requestTimeout: 15000, throwOnRequestTimeout: true },
})

export const createClients = (region) => ({
  ssm: new SSMClient(clientConfig(region)),
  eic: new EC2InstanceConnectClient(clientConfig(region)),
})

const timedOut = (service, error) =>
  new Error(
    `${service} did not answer in time: ${error.message} Check that the runner can reach the ${service} ` +
      'endpoint for this region, through any proxy or VPC interface endpoint it uses.',
    { cause: error },
  )

const describeInstance = async (ssm, instanceId) => {
  const response = await ssm.send(
    new DescribeInstanceInformationCommand({
      Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
      MaxResults: 5,
    }),
  )
  core.debug(`DescribeInstanceInformation matched ${response.InstanceInformationList?.length ?? 0} instance(s)`)
  return response.InstanceInformationList?.at(0) ?? null
}

const describeFailure = (instanceId, error) => {
  if (error.name === 'TimeoutError') return timedOut('SSM', error)
  if (error.name === 'AccessDeniedException') {
    return new Error(
      `Not authorised to call ssm:DescribeInstanceInformation. Grant it on Resource "*" — this API does not ` +
        `support resource-level permissions. Underlying error: ${error.message}`,
      { cause: error },
    )
  }
  return new Error(`Could not read SSM registration for ${instanceId}: ${error.message}`, { cause: error })
}

export const waitForInstanceOnline = async ({ ssm, instanceId, timeoutSeconds }) => {
  const deadline = Date.now() + timeoutSeconds * 1000
  let delay = 2000
  let last = null

  for (;;) {
    try {
      last = await describeInstance(ssm, instanceId)
    } catch (error) {
      throw describeFailure(instanceId, error)
    }

    if (last?.PingStatus === 'Online') {
      core.info(`Instance ${instanceId} is Online in SSM (agent ${last.AgentVersion ?? 'unknown'}).`)
      return last
    }

    if (Date.now() + delay >= deadline) break

    core.info(
      `Instance ${instanceId} is ${last ? `"${last.PingStatus}"` : 'not registered'}; retrying in ${delay / 1000}s.`,
    )
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.5), 10000)
  }

  if (!last) {
    throw new Error(
      `Instance ${instanceId} is not registered with SSM. Check that SSM Agent 2.3.672.0 or later is running on ` +
        'the instance, that its instance profile allows AmazonSSMManagedInstanceCore, and that the instance can ' +
        'reach the ssm, ssmmessages and ec2messages endpoints (NAT gateway or VPC interface endpoints).',
    )
  }

  throw new Error(
    `Instance ${instanceId} is registered with SSM but its ping status is "${last.PingStatus}", not "Online". ` +
      'The SSM Agent is not currently reachable. Restart amazon-ssm-agent on the instance, or raise "wait-timeout" ' +
      'if the instance is still booting.',
  )
}

export const sendPublicKey = async ({ eic, instanceId, osUser, publicKey }) => {
  try {
    const response = await eic.send(
      new SendSSHPublicKeyCommand({
        InstanceId: instanceId,
        InstanceOSUser: osUser,
        SSHPublicKey: publicKey,
      }),
    )
    core.debug(`SendSSHPublicKey requestId=${response.RequestId ?? 'unknown'}`)
    return response
  } catch (error) {
    if (error.name === 'TimeoutError') throw timedOut('EC2 Instance Connect', error)
    if (error.name === 'AccessDeniedException') {
      throw new Error(
        `Not authorised to call ec2-instance-connect:SendSSHPublicKey for ${instanceId} as "${osUser}". Grant it on ` +
          `the instance ARN, and make sure any ec2:osuser condition on the policy lists "${osUser}". ` +
          `Underlying error: ${error.message}`,
        { cause: error },
      )
    }
    if (error.name === 'EC2InstanceNotFoundException') {
      throw new Error(
        `EC2 Instance Connect does not recognise ${instanceId}. It must be a running EC2 instance in region scope; ` +
          'hybrid "mi-" managed nodes are not supported by Instance Connect — supply "private-key" instead.',
        { cause: error },
      )
    }
    if (error.name === 'InvalidArgsException') {
      throw new Error(
        `EC2 Instance Connect rejected the request for user "${osUser}" on ${instanceId}: ${error.message}. ` +
          'Check that the OS user exists on the instance.',
        { cause: error },
      )
    }
    throw new Error(
      `SendSSHPublicKey failed for ${instanceId}: ${error.name}: ${error.message}`,
      { cause: error },
    )
  }
}

export const listActiveSessions = async ({ ssm, target }) => {
  const sessions = []
  let nextToken

  do {
    const response = await ssm.send(
      new DescribeSessionsCommand({
        State: 'Active',
        Filters: [{ key: 'Target', value: target }],
        MaxResults: 200,
        NextToken: nextToken,
      }),
    )
    sessions.push(...(response.Sessions ?? []))
    nextToken = response.NextToken
  } while (nextToken)

  core.debug(`DescribeSessions returned ${sessions.length} active session(s) for ${target}`)
  return sessions
}

export const terminateSession = async ({ ssm, sessionId }) => {
  await ssm.send(new TerminateSessionCommand({ SessionId: sessionId }))
}
