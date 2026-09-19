# IAM permissions

Two roles are involved: the role your workflow assumes, and the instance profile on the EC2 instance.

## Runner role

This is the role the workflow assumes, usually through OIDC with `aws-actions/configure-aws-credentials`.
Replace the placeholders.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StartSshSession",
      "Effect": "Allow",
      "Action": "ssm:StartSession",
      "Resource": [
        "arn:aws:ec2:<region>:<account-id>:instance/<instance-id>",
        "arn:aws:ssm:<region>::document/AWS-StartSSHSession"
      ]
    },
    {
      "Sid": "OpenTheDataChannel",
      "Effect": "Allow",
      "Action": "ssmmessages:OpenDataChannel",
      "Resource": "*"
    },
    {
      "Sid": "DescribeCallsCannotBeScoped",
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeInstanceInformation",
        "ssm:DescribeSessions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EndOnlyOwnSessionsOnThisInstance",
      "Effect": "Allow",
      "Action": "ssm:TerminateSession",
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "ssm:resourceTag/aws:ssmmessages:session-id": "${aws:userid}*",
          "ssm:resourceTag/aws:ssmmessages:target-id": "<instance-id>"
        }
      }
    },
    {
      "Sid": "PushEphemeralKey",
      "Effect": "Allow",
      "Action": "ec2-instance-connect:SendSSHPublicKey",
      "Resource": "arn:aws:ec2:<region>:<account-id>:instance/<instance-id>",
      "Condition": {
        "StringEquals": {
          "ec2:osuser": "ubuntu"
        }
      }
    }
  ]
}
```

Adjust two things to match your workflow: the `ec2:osuser` condition value must equal the `os-user` input, or
the key push is denied; and drop the `PushEphemeralKey` statement entirely if you use the `private-key` input.

For a hybrid `mi-` managed node, the `ssm:StartSession` instance resource becomes
`arn:aws:ssm:<region>:<account-id>:managed-instance/<instance-id>`. EC2 Instance Connect does not support
hybrid nodes at all, so those need `private-key`.

### Gotchas

Three things that are easy to get wrong and produce confusing failures.

- **`ssm:TerminateSession` cannot be scoped by session ARN when you authenticate with OIDC.** The widely
  copied `arn:aws:ssm:*:*:session/${aws:username}-*` does not work: AWS documents that the `${aws:username}`
  method "doesn't work for accounts that grant access to AWS using federated IDs". Substituting
  `${aws:userid}` does not fix it either, because session IDs are built from the role session name alone
  while `${aws:userid}` expands to `<role-id>:<role-session-name>`. Use the tag condition above, which matches
  the `aws:ssmmessages:session-id` tag Session Manager stamps on every session. Getting this wrong makes the
  post step log `AccessDeniedException` and leave sessions running.
- **The instance resource for `ssm:StartSession` is an EC2 ARN**, `arn:aws:ec2:…:instance/…`, not an SSM one.
- **`ssm:DescribeInstanceInformation` and `ssm:DescribeSessions` support no resource-level permissions.** They
  must be granted on `"*"`; there is no way to narrow them to a single instance.

## EC2 instance role

Attach the AWS managed policy **`AmazonSSMManagedInstanceCore`** to the instance profile. It grants the SSM
Agent what it needs to register the instance and serve sessions: the `ssm:UpdateInstanceInformation`
heartbeat, the `ssmmessages:*` channel calls that carry session traffic, the `ec2messages:*` calls used for
Run Command, and read access to SSM documents and parameters.

You need permissions beyond it in two cases.

**Session logging.** `AmazonSSMManagedInstanceCore` does not grant log delivery. If you turn on Session
Manager logging you must also allow `s3:PutObject` on the log bucket, `kms:GenerateDataKey` on the key if the
bucket or the session is encrypted, and `logs:CreateLogStream`, `logs:PutLogEvents` and
`logs:DescribeLogStreams` on the CloudWatch log group. This logging does not capture SSH sessions — see the
caveats in the [README](../README.md#caveats).

**No internet egress.** The SSM Agent has to reach AWS endpoints. If the instance has no NAT gateway and no
internet gateway, create VPC interface endpoints for `com.amazonaws.<region>.ssm`,
`com.amazonaws.<region>.ssmmessages` and `com.amazonaws.<region>.ec2messages`, and allow 443 from the instance
to the endpoint security group. Without these the instance never reaches `Online` and this action fails its
instance check.
