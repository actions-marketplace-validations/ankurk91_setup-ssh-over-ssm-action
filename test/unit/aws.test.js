import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listActiveSessions,
  sendPublicKey,
  terminateSession,
  waitForInstanceOnline,
} from '../../src/lib/aws.js'

const INSTANCE_ID = 'i-0123456789abcdef0'

// Stands in for an SDK v3 client. Replies are consumed in order and the last one repeats.
const fakeClient = (...replies) => {
  const sent = []
  return {
    sent,
    send: async (command) => {
      sent.push({ name: command.constructor.name, input: command.input })
      const reply = replies.length > 1 ? replies.shift() : replies[0]
      if (reply instanceof Error) throw reply
      return reply
    },
  }
}

const awsError = (name, message = `${name} from the stub`) => Object.assign(new Error(message), { name })

const instance = (PingStatus) => ({
  InstanceInformationList: [{ InstanceId: INSTANCE_ID, PingStatus, AgentVersion: '3.3.1611.0' }],
})

describe('waitForInstanceOnline', () => {
  test('returns the instance once it is Online', async () => {
    const ssm = fakeClient(instance('Online'))
    const info = await waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 0 })
    assert.equal(info.PingStatus, 'Online')
    assert.deepEqual(ssm.sent[0].input.Filters, [{ Key: 'InstanceIds', Values: [INSTANCE_ID] }])
  })

  test('fails at once with a zero timeout when the instance is not registered', async () => {
    const ssm = fakeClient({ InstanceInformationList: [] })
    await assert.rejects(
      waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 0 }),
      /is not registered with SSM.*SSM Agent 2\.3\.672\.0/,
    )
    assert.equal(ssm.sent.length, 1)
  })

  test('names the ping status when the agent is not Online', async () => {
    const ssm = fakeClient(instance('ConnectionLost'))
    await assert.rejects(
      waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 0 }),
      /ping status is "ConnectionLost", not "Online"/,
    )
  })

  test('retries until the instance comes Online', async () => {
    const ssm = fakeClient(instance('Offline'), instance('Online'))
    const info = await waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 5 })
    assert.equal(info.PingStatus, 'Online')
    assert.equal(ssm.sent.length, 2)
  })

  test('explains that DescribeInstanceInformation needs Resource "*"', async () => {
    const denied = awsError('AccessDeniedException')
    const ssm = fakeClient(denied)
    await assert.rejects(waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 0 }), (error) => {
      assert.match(error.message, /ssm:DescribeInstanceInformation\. Grant it on Resource "\*"/)
      assert.equal(error.cause, denied)
      return true
    })
  })

  test('points at reachability when the endpoint does not answer', async () => {
    const ssm = fakeClient(awsError('TimeoutError', 'a request has exceeded the configured 15000 ms requestTimeout.'))
    await assert.rejects(
      waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 0 }),
      /SSM did not answer in time: .*15000 ms.* Check that the runner can reach the SSM endpoint/,
    )
  })

  test('wraps any other SDK error with the instance id', async () => {
    const ssm = fakeClient(awsError('ThrottlingException', 'Rate exceeded'))
    await assert.rejects(
      waitForInstanceOnline({ ssm, instanceId: INSTANCE_ID, timeoutSeconds: 0 }),
      new RegExp(`Could not read SSM registration for ${INSTANCE_ID}: Rate exceeded`),
    )
  })
})

describe('sendPublicKey', () => {
  const send = (eic) => sendPublicKey({ eic, instanceId: INSTANCE_ID, osUser: 'ubuntu', publicKey: 'ssh-ed25519 AAAA' })

  test('sends the instance, user and key', async () => {
    const eic = fakeClient({ RequestId: 'r-1', Success: true })
    await send(eic)
    assert.deepEqual(eic.sent, [
      {
        name: 'SendSSHPublicKeyCommand',
        input: { InstanceId: INSTANCE_ID, InstanceOSUser: 'ubuntu', SSHPublicKey: 'ssh-ed25519 AAAA' },
      },
    ])
  })

  const cases = [
    ['AccessDeniedException', /make sure any ec2:osuser condition on the policy lists "ubuntu"/],
    ['EC2InstanceNotFoundException', /hybrid "mi-" managed nodes are not supported/],
    ['InvalidArgsException', /Check that the OS user exists on the instance/],
    ['TimeoutError', /EC2 Instance Connect did not answer in time/],
    ['ServiceException', new RegExp(`SendSSHPublicKey failed for ${INSTANCE_ID}: ServiceException`)],
  ]

  for (const [name, pattern] of cases) {
    test(`explains ${name}`, async () => {
      const original = awsError(name)
      await assert.rejects(send(fakeClient(original)), (error) => {
        assert.match(error.message, pattern)
        assert.equal(error.cause, original)
        return true
      })
    })
  }
})

describe('listActiveSessions', () => {
  test('follows NextToken across pages', async () => {
    const ssm = fakeClient(
      { Sessions: [{ SessionId: 's-1' }], NextToken: 'page-2' },
      { Sessions: [{ SessionId: 's-2' }] },
    )
    const sessions = await listActiveSessions({ ssm, target: INSTANCE_ID })
    assert.deepEqual(sessions.map((session) => session.SessionId), ['s-1', 's-2'])
    assert.deepEqual(ssm.sent.map((call) => call.input.NextToken), [undefined, 'page-2'])
  })

  test('asks only for active sessions on the target', async () => {
    const ssm = fakeClient({})
    assert.deepEqual(await listActiveSessions({ ssm, target: INSTANCE_ID }), [])
    assert.equal(ssm.sent[0].input.State, 'Active')
    assert.deepEqual(ssm.sent[0].input.Filters, [{ key: 'Target', value: INSTANCE_ID }])
  })
})

describe('terminateSession', () => {
  test('terminates the given session', async () => {
    const ssm = fakeClient({ SessionId: 's-1' })
    await terminateSession({ ssm, sessionId: 's-1' })
    assert.deepEqual(ssm.sent, [{ name: 'TerminateSessionCommand', input: { SessionId: 's-1' } }])
  })
})
