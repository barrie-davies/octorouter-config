import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OctoRouterSecurityResources {
  securityGroupId: $util.Output<string>;
  keyPairName: $util.Output<string>;
}

export interface OctoRouterOutputs {
  OCTOROUTER_IP: $util.Output<string>;
  OCTOROUTER_URL: string;
  OCTOROUTER_DASHBOARD_URL: string;
  OCTOROUTER_MANAGEMENT_CENTER_URL: string;
  DELEGATED_ZONE_NAMESERVERS: $util.Output<string[]>;
}

const ROOT_DOMAIN = 'octinho.com';
const SUBZONE = 'octorouter.octinho.com';
const API_DOMAIN = 'octorouter.octinho.com';
const DASHBOARD_DOMAIN = 'dashboard.octorouter.octinho.com';

export function createOctoRouterSecurity(vpcId: $util.Output<string>): OctoRouterSecurityResources {
  const sshPublicKey = new sst.Secret('OctoRouterSshPublicKey');
  const sshAllowedCidr = new sst.Secret('OctoRouterSshAllowedCidr');

  const sg = new aws.ec2.SecurityGroup('OctoRouterSg', {
    vpcId,
    description: 'Security group for OctoRouter CLIProxyAPI',
    tags: {Name: 'octorouter-sg', Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  new aws.vpc.SecurityGroupIngressRule('OctoRouterSshIngress', {
    securityGroupId: sg.id,
    fromPort: 22,
    toPort: 22,
    ipProtocol: 'tcp',
    cidrIpv4: sshAllowedCidr.value,
    description: 'SSH access (restricted to allowed CIDR)'
  });
  new aws.vpc.SecurityGroupIngressRule('OctoRouterHttpIngress', {
    securityGroupId: sg.id,
    fromPort: 80,
    toPort: 80,
    ipProtocol: 'tcp',
    cidrIpv4: '0.0.0.0/0',
    description: 'HTTP (redirected to HTTPS by Caddy)'
  });
  new aws.vpc.SecurityGroupIngressRule('OctoRouterHttpsIngress', {
    securityGroupId: sg.id,
    fromPort: 443,
    toPort: 443,
    ipProtocol: 'tcp',
    cidrIpv4: '0.0.0.0/0',
    description: 'HTTPS API access'
  });

  new aws.vpc.SecurityGroupEgressRule('OctoRouterEgress', {
    securityGroupId: sg.id,
    fromPort: -1,
    toPort: -1,
    ipProtocol: '-1',
    cidrIpv4: '0.0.0.0/0',
    description: 'All outbound traffic'
  });

  const keyPair = new aws.ec2.KeyPair('OctoRouterKeyPair', {
    keyName: 'octorouter-key',
    publicKey: sshPublicKey.value,
    tags: {Name: 'octorouter-key', Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  return {
    securityGroupId: sg.id,
    keyPairName: keyPair.keyName
  };
}

export function createOctoRouter(): OctoRouterOutputs {
  const defaultVpc = aws.ec2.getVpcOutput({default: true});
  const security = createOctoRouterSecurity(defaultVpc.id);

  const postgresPassword = new sst.Secret('OctoRouterPostgresPassword');
  const jwtSecret = new sst.Secret('OctoRouterJwtSecret');
  const managementApiKey = new sst.Secret('OctoRouterManagementApiKey');
  const deploySecret = new sst.Secret('OctoRouterDeploySecret');

  const ami = aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: ['amazon'],
    filters: [
      {name: 'name', values: ['al2023-ami-*']},
      {name: 'architecture', values: ['x86_64']},
      {name: 'virtualization-type', values: ['hvm']}
    ]
  });

  const subnets = aws.ec2.getSubnetsOutput({
    filters: [
      {name: 'vpc-id', values: [defaultVpc.id]},
      {name: 'map-public-ip-on-launch', values: ['true']}
    ]
  });

  const servicesDir = path.resolve(process.cwd(), 'services');
  const dockerCompose = fs.readFileSync(path.join(servicesDir, 'docker-compose.yml'), 'utf8');
  const caddyfile = fs.readFileSync(path.join(servicesDir, 'Caddyfile'), 'utf8');
  const configExample = fs.readFileSync(path.join(servicesDir, 'config.example.yaml'), 'utf8');
  const webhookYaml = fs.readFileSync(path.join(servicesDir, 'webhook/webhook.yaml'), 'utf8');
  const webhookDeployScript = fs.readFileSync(path.join(servicesDir, 'webhook/deploy-dashboard.sh'), 'utf8');
  const webhookSystemdUnit = fs.readFileSync(path.join(servicesDir, 'webhook/octorouter-webhook.service'), 'utf8');

  // Static config files are uploaded to S3 and pulled at boot via instance profile,
  // keeping user-data well below the 16 KB EC2 limit.
  const configBucket = new aws.s3.BucketV2('OctoRouterConfigBucket', {
    forceDestroy: true,
    tags: {Name: 'octorouter-config', Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  new aws.s3.BucketPublicAccessBlock('OctoRouterConfigBucketPab', {
    bucket: configBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true
  });

  const uploadObject = (name: string, key: string, content: string) =>
    new aws.s3.BucketObjectv2(name, {
      bucket: configBucket.id,
      key,
      content,
      contentType: 'text/plain'
    });

  uploadObject('OctoRouterDockerCompose', 'docker-compose.yml', dockerCompose);
  uploadObject('OctoRouterCaddyfile', 'Caddyfile', caddyfile);
  uploadObject('OctoRouterConfigExample', 'config.example.yaml', configExample);
  uploadObject('OctoRouterWebhookYaml', 'webhook/webhook.yaml', webhookYaml);
  uploadObject('OctoRouterWebhookDeployScript', 'webhook/deploy-dashboard.sh', webhookDeployScript);
  uploadObject('OctoRouterWebhookSystemdUnit', 'webhook/octorouter-webhook.service', webhookSystemdUnit);

  const role = new aws.iam.Role('OctoRouterInstanceRole', {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {Service: 'ec2.amazonaws.com'},
          Action: 'sts:AssumeRole'
        }
      ]
    }),
    tags: {Name: 'octorouter-role', Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  new aws.iam.RolePolicy('OctoRouterInstanceRolePolicy', {
    role: role.id,
    policy: configBucket.arn.apply(arn =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:ListBucket'],
            Resource: [arn, `${arn}/*`]
          }
        ]
      })
    )
  });

  const instanceProfile = new aws.iam.InstanceProfile('OctoRouterInstanceProfile', {
    role: role.name
  });

  const userData = $interpolate`#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/octorouter-bootstrap.log) 2>&1
echo "[bootstrap] starting at $(date -Iseconds)"

yum update -y
yum install -y docker awscli
systemctl enable --now docker

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \\
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

mkdir -p /opt/octorouter/auths /opt/octorouter/logs /opt/octorouter/webhook /var/log/octorouter

BUCKET="${configBucket.bucket}"
aws s3 cp "s3://$BUCKET/docker-compose.yml"                 /opt/octorouter/docker-compose.yml
aws s3 cp "s3://$BUCKET/Caddyfile"                          /opt/octorouter/Caddyfile
aws s3 cp "s3://$BUCKET/webhook/webhook.yaml"               /opt/octorouter/webhook/webhook.yaml.tmpl
aws s3 cp "s3://$BUCKET/webhook/deploy-dashboard.sh"        /opt/octorouter/webhook/deploy-dashboard.sh
aws s3 cp "s3://$BUCKET/webhook/octorouter-webhook.service" /etc/systemd/system/octorouter-webhook.service
chmod 0755 /opt/octorouter/webhook/deploy-dashboard.sh

if [ ! -f /opt/octorouter/config.yaml ]; then
  aws s3 cp "s3://$BUCKET/config.example.yaml" /opt/octorouter/config.yaml
fi

cat > /opt/octorouter/.env <<ENV_EOF
CLIPROXYAPI_PORT=8317
CLIPROXYAPI_AUTH_DIR=/opt/octorouter/auths
CLIPROXYAPI_DEPLOY=cloud
POSTGRES_PASSWORD=${postgresPassword.value}
DASHBOARD_PORT=3000
JWT_SECRET=${jwtSecret.value}
MANAGEMENT_API_KEY=${managementApiKey.value}
DEPLOY_SECRET=${deploySecret.value}
WEBHOOK_HOST=http://host.docker.internal:9000
ENV_EOF
chmod 0600 /opt/octorouter/.env

sed "s|{{DEPLOY_SECRET}}|${deploySecret.value}|g" \\
  /opt/octorouter/webhook/webhook.yaml.tmpl > /opt/octorouter/webhook/webhook.yaml
chmod 0600 /opt/octorouter/webhook/webhook.yaml

if [ ! -f /swapfile ]; then
  fallocate -l 512M /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -x /usr/local/bin/webhook ]; then
  WEBHOOK_VERSION=2.8.2
  curl -fsSL "https://github.com/adnanh/webhook/releases/download/\${WEBHOOK_VERSION}/webhook-linux-amd64.tar.gz" -o /tmp/webhook.tar.gz
  tar -xzf /tmp/webhook.tar.gz -C /tmp
  install -m 0755 /tmp/webhook-linux-amd64/webhook /usr/local/bin/webhook
  rm -rf /tmp/webhook.tar.gz /tmp/webhook-linux-amd64
fi

systemctl daemon-reload
systemctl enable --now octorouter-webhook

cd /opt/octorouter
docker compose up -d
echo "[bootstrap] done at $(date -Iseconds)"
`;

  const instance = new aws.ec2.Instance('OctoRouterInstance', {
    instanceType: 't3.medium',
    ami: ami.imageId,
    subnetId: subnets.ids[0],
    vpcSecurityGroupIds: [security.securityGroupId],
    keyName: security.keyPairName,
    iamInstanceProfile: instanceProfile.name,
    rootBlockDevice: {
      volumeSize: 30,
      volumeType: 'gp3',
      deleteOnTermination: false
    },
    userData: userData.apply(ud => Buffer.from(ud).toString('base64')),
    tags: {Name: 'OctoRouter', Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  const eip = new aws.ec2.Eip('OctoRouterEip', {
    tags: {Name: 'OctoRouter-EIP'}
  });

  new aws.ec2.EipAssociation('OctoRouterEipAssociation', {
    instanceId: instance.id,
    allocationId: eip.allocationId
  });

  // Delegated subzone created in deploy account; parent zone octinho.com is in
  // octoathlete-shared. After first deploy the operator must add an NS record
  // for `octorouter` in the parent zone pointing at DELEGATED_ZONE_NAMESERVERS.
  const subzone = new aws.route53.Zone('OctoRouterSubzone', {
    name: SUBZONE,
    comment: `Delegated zone for OctoRouter — parent ${ROOT_DOMAIN} in octoathlete-shared`,
    tags: {Name: SUBZONE, Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  new aws.route53.Record('OctoRouterApiDns', {
    zoneId: subzone.zoneId,
    name: API_DOMAIN,
    type: 'A',
    ttl: 300,
    records: [eip.publicIp]
  });

  new aws.route53.Record('OctoRouterDashboardDns', {
    zoneId: subzone.zoneId,
    name: DASHBOARD_DOMAIN,
    type: 'A',
    ttl: 300,
    records: [eip.publicIp]
  });

  return {
    OCTOROUTER_IP: eip.publicIp,
    OCTOROUTER_URL: `https://${API_DOMAIN}`,
    OCTOROUTER_DASHBOARD_URL: `https://${DASHBOARD_DOMAIN}`,
    OCTOROUTER_MANAGEMENT_CENTER_URL: `https://${API_DOMAIN}/management.html`,
    DELEGATED_ZONE_NAMESERVERS: subzone.nameServers
  };
}

export const octoRouterInfrastructure = (): Record<string, string | $util.Output<unknown>> => {
  if ($app.stage !== 'ops') throw new Error(`No domain configured for stage '${$app.stage}'`);
  const octorouter = createOctoRouter();
  return {...octorouter};
};
