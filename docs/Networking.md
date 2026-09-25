# Networking

The action needs no inbound rules on the instance. Port 22 can stay closed, and the instance needs no public
IP. What it does need is an **outbound** path from the instance to AWS.

## How traffic flows

```
Runner ──HTTPS──▶ AWS public APIs (SSM, EC2 Instance Connect)
                          ▲
                          │ HTTPS 443, opened by the instance
                          │
                  SSM Agent on the instance ──▶ sshd on localhost:22
```

- The **runner** calls public AWS APIs. Nothing on the runner side touches your VPC.
- The **SSM Agent** on the instance connects out to Systems Manager on port 443. Your SSH traffic rides that
  connection to `sshd` on the instance itself.
- The ephemeral SSH key from EC2 Instance Connect arrives through instance metadata, which needs no network
  setup.

So the only question is: **can the SSM Agent reach Systems Manager?**

## Instance in a public subnet

Nothing to do. An instance with a public IP and a route to an internet gateway already reaches AWS. You can
still keep port 22 closed in its security group.

## Instance in a private subnet

Pick one of these.

### Option 1: NAT gateway

If the subnet already routes outbound traffic through a
[NAT gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html), nothing else is needed.

A NAT gateway is billed by the hour and per GB. See [VPC pricing](https://aws.amazon.com/vpc/pricing/).

### Option 2: VPC endpoints

With no NAT gateway, create these endpoints in the instance's VPC:

| Endpoint                                    | Type      | Needed for                                | Cost                   |
|---------------------------------------------|-----------|-------------------------------------------|------------------------|
| `com.amazonaws.<region>.ssm`                | Interface | Registering the instance with SSM         | Billed                 |
| `com.amazonaws.<region>.ssmmessages`        | Interface | Carrying the session, including SSH bytes | Billed                 |
| `com.amazonaws.<region>.s3`                 | Gateway   | SSM Agent updates                         | Free                   |

Interface endpoints are billed per hour, per Availability Zone, and per GB. See
[AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/). Gateway endpoints cost nothing.

When you create the two interface endpoints:

- Place them in the instance's subnet, or at least in its Availability Zone.
- Keep **private DNS** enabled, which is the default. The VPC needs DNS resolution and DNS hostnames turned on.
- Attach a security group that allows **inbound TCP 443** from the instance's security group.

Add the S3 gateway endpoint to the route table of the instance's subnet.

Step-by-step guides:

- [Use VPC endpoints for Systems Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html)
- [Create an interface endpoint](https://docs.aws.amazon.com/vpc/latest/privatelink/create-interface-endpoint.html)
- [Create an S3 gateway endpoint](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)

### What about `ec2messages`?

Older guides list a third interface endpoint, `ec2messages`. You don't need it if SSM Agent is 3.3.40.0 or
later, which uses `ssmmessages` instead. AWS Regions launched in 2024 or later don't offer `ec2messages` at
all. See
[the AWS reference](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-setting-up-messageAPIs.html).

If you are removing an existing `ec2messages` endpoint, first make sure the `ssmmessages` endpoint's security
group allows 443 from the instance. An agent that can't reach `ssmmessages` quietly falls back to
`ec2messages`, and removing it then takes the instance offline.

## Checking it works

In the AWS console, open **Systems Manager → Fleet Manager**. The instance should show as **Online**. If it
does not, the action fails before it configures SSH. See
[troubleshooting SSM Agent](https://docs.aws.amazon.com/systems-manager/latest/userguide/troubleshooting-ssm-agent.html).
