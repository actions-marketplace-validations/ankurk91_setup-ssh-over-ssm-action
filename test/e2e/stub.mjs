// Minimal stand-in for the three AWS services the action calls.
// SendSSHPublicKey actually installs the key into the sshd container's authorized_keys
// and removes it after KEY_TTL_MS, which is the only way to exercise the real 60s window.
import { createServer } from 'node:http'
import { writeFile, rm } from 'node:fs/promises'

const AUTHORIZED_KEYS = process.env.AUTHORIZED_KEYS
const KEY_TTL_MS = Number(process.env.KEY_TTL_MS ?? 60000)
const CALLER_ARN = 'arn:aws:sts::123456789012:assumed-role/e2e/GitHubActions'
const PING = process.env.PING_STATUS ?? 'Online'

const calls = []
let sessions = []

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
  res.end(JSON.stringify(body))
}

const handlers = {
  async SendSSHPublicKey(req) {
    await writeFile(AUTHORIZED_KEYS, `${req.SSHPublicKey}\n`, { mode: 0o644 })
    setTimeout(() => rm(AUTHORIZED_KEYS, { force: true }), KEY_TTL_MS).unref()
    return { RequestId: 'stub-eic', Success: true }
  },
  DescribeInstanceInformation: (req) => ({
    InstanceInformationList:
      PING === 'missing'
        ? []
        : [{ InstanceId: req.Filters?.[0]?.Values?.[0], PingStatus: PING, AgentVersion: '3.3.1611.0' }],
  }),
  DescribeSessions: () => ({ Sessions: sessions }),
  TerminateSession: (req) => {
    sessions = sessions.filter((s) => s.SessionId !== req.SessionId)
    return { SessionId: req.SessionId }
  },
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    if (req.url === '/__calls') return json(res, calls)
    if (req.url === '/__sessions') {
      if (req.method !== 'POST') return json(res, sessions)
      sessions = JSON.parse(body)
      return json(res, { ok: true })
    }

    const target = req.headers['x-amz-target']
    if (target) {
      const op = target.split('.').at(-1)
      calls.push(op)
      const handler = handlers[op]
      if (!handler) {
        res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' })
        return res.end(JSON.stringify({ __type: 'UnknownOperationException', message: op }))
      }
      return json(res, await handler(JSON.parse(body || '{}')))
    }

    if (body.includes('Action=GetCallerIdentity')) {
      calls.push('GetCallerIdentity')
      res.writeHead(200, { 'content-type': 'text/xml' })
      return res.end(
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">` +
          `<GetCallerIdentityResult><Arn>${CALLER_ARN}</Arn>` +
          `<UserId>AROAE2E:GitHubActions</UserId><Account>123456789012</Account>` +
          `</GetCallerIdentityResult><ResponseMetadata><RequestId>stub</RequestId></ResponseMetadata>` +
          `</GetCallerIdentityResponse>`,
      )
    }
    res.writeHead(400).end('unhandled')
  })
}).listen(Number(process.env.STUB_PORT ?? 5599), '127.0.0.1', () =>
  console.log(`stub on ${process.env.STUB_PORT ?? 5599} -> ${AUTHORIZED_KEYS}`),
)
