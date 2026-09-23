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

Things that are easy to get wrong and produce confusing failures.

- **`ssm:TerminateSession` cannot be scoped by session ARN when you authenticate with OIDC.** The widely
  copied `arn:aws:ssm:*:*:session/${aws:username}-*` does not work: AWS documents that the `${aws:username}`
  method "doesn't work for accounts that grant access to AWS using federated IDs". Substituting
  `${aws:userid}` does not fix it either, because session IDs are built from the role session name alone
  while `${aws:userid}` expands to `<role-id>:<role-session-name>`. Use the tag condition above instead. The
  `aws:ssmmessages:session-id` tag AWS stamps on every session holds the *caller's* ID, not the session ID:
  `<role-id>:<role-session-name>` for an assumed role and the user ID for an IAM user, so `${aws:userid}`
  matches either. Getting this wrong makes the post step log `AccessDeniedException` and leave sessions
  running.
- **The instance resource for `ssm:StartSession` is an EC2 ARN**, `arn:aws:ec2:…:instance/…`, not an SSM one.
- **`ssm:DescribeInstanceInformation` and `ssm:DescribeSessions` support no resource-level permissions.** They
  must be granted on `"*"`; there is no way to narrow them to a single instance.

## EC2 instance role

Attach the AWS managed policy **`AmazonSSMManagedInstanceCore`** to the instance profile.

Few cases need more than that.

- **Session logging.** Also allow `s3:PutObject` on the log bucket, `kms:GenerateDataKey` on the key if the
  bucket or the session is encrypted, and `logs:CreateLogStream`, `logs:PutLogEvents` and
  `logs:DescribeLogStreams` on the CloudWatch log group. It does not capture SSH sessions — see the
  [caveats](Caveats.md).
- **No internet egress.** The instance needs a NAT gateway or VPC endpoints to reach Systems Manager. See
  [Networking](Networking.md).
