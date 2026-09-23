// Minimal stand-in for the three AWS services the action calls.
// SendSSHPublicKey actually installs the key into the sshd container's authorized_keys
// and removes it after KEY_TTL_MS, which is the only way to exercise the real 60s window.
// POST /__ping and /__key-ttl change PING_STATUS and KEY_TTL_MS without a restart.
import { createServer } from 'node:http'
import { writeFile, rm } from 'node:fs/promises'

const AUTHORIZED_KEYS = process.env.AUTHORIZED_KEYS
const CALLER_ARN = 'arn:aws:sts::123456789012:assumed-role/e2e/GitHubActions'

const calls = []
let sessions = []
let ping = process.env.PING_STATUS ?? 'Online'
let keyTtlMs = Number(process.env.KEY_TTL_MS ?? 60000)
let keyGeneration = 0

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
  res.end(JSON.stringify(body))
}

const handlers = {
  async SendSSHPublicKey(req) {
    await writeFile(AUTHORIZED_KEYS, `${req.SSHPublicKey}\n`, { mode: 0o644 })
    // One file holds one key, so an expiring push must not delete the key a later push wrote.
    const generation = ++keyGeneration
    setTimeout(() => {
      if (generation === keyGeneration) rm(AUTHORIZED_KEYS, { force: true })
    }, keyTtlMs).unref()
    return { RequestId: 'stub-eic', Success: true }
  },
  DescribeInstanceInformation: (req) => ({
    InstanceInformationList:
      ping === 'missing'
        ? []
        : [{ InstanceId: req.Filters?.[0]?.Values?.[0], PingStatus: ping, AgentVersion: '3.3.1611.0' }],
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
    if (req.url === '/__ping' && req.method === 'POST') {
      ping = body.trim()
      return json(res, { ok: true })
    }
    if (req.url === '/__key-ttl' && req.method === 'POST') {
      keyTtlMs = Number(body)
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
