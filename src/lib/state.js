// State keys shared between the main and post steps.

export const STATE = {
  started: 'started-at',
  region: 'region',
  instanceId: 'instance-id',
  hostAlias: 'host-alias',
  sshConfigPath: 'ssh-config-path',
  privateKeyPath: 'private-key-path',
  publicKeyPath: 'public-key-path',
  knownHostsFile: 'known-hosts-file',
  controlPath: 'control-path',
  callerArn: 'caller-arn',
  terminateSessions: 'terminate-sessions',
  cleanup: 'cleanup',
}
