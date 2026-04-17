import * as fs from 'fs';
import * as path from 'path';

export interface OctoRouterSecurityResources {
  securityGroupId: $util.Output<string>;
  keyPairName: $util.Output<string>;
}

export interface OctoRouterOutputs {
  OCTOROUTER_IP: $util.Output<string>;
  OCTOROUTER_URL: string;
}

export function createOctoRouterSecurity(vpc: sst.aws.Vpc): OctoRouterSecurityResources {
  // Set via: sst secret set OctoRouterSshPublicKey "ssh-ed25519 ..."
  const sshPublicKey = new sst.Secret('OctoRouterSshPublicKey');
  // Set via: sst secret set OctoRouterSshAllowedCidr "1.2.3.4/32"
  const sshAllowedCidr = new sst.Secret('OctoRouterSshAllowedCidr');

  const sg = new aws.ec2.SecurityGroup('OctoRouterSg', {
    vpcId: vpc.id,
    description: 'Security group for OctoRouter CLIProxyAPI',
    tags: {Name: 'octorouter-sg', Service: 'CLIProxyAPI', ManagedBy: 'SST'}
  });

  new aws.vpc.SecurityGroupIngressRule('OctoRouterSshIngress', {
    securityGroupId: sg.id,
    fromPort: 22,
    toPort: 22,
    ipProtocol: 'tcp',
    cidrIpv4: sshAllowedCidr.value, // NOT 0.0.0.0/0 — restricted to operator CIDR
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

  // Import existing public key — IaC must NOT generate SSH keys
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

export function createOctoRouter(vpc: sst.aws.Vpc): OctoRouterOutputs {
  const security = createOctoRouterSecurity(vpc);

  // Additional secrets for services requiring runtime credentials
  // Set via: sst secret set OctoRouterPostgresPassword "$(openssl rand -hex 32)"
  const postgresPassword = new sst.Secret('OctoRouterPostgresPassword');
  // Set via: sst secret set OctoRouterJwtSecret "$(openssl rand -base64 32)"
  const jwtSecret = new sst.Secret('OctoRouterJwtSecret');
  // Set via: sst secret set OctoRouterManagementApiKey "$(openssl rand -hex 32)"
  const managementApiKey = new sst.Secret('OctoRouterManagementApiKey');
  // Set via: sst secret set OctoRouterDeploySecret "$(openssl rand -hex 32)"
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
      {name: 'vpc-id', values: ['vpc-07631f85d7c064e30']},
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

  const userData = $interpolate`#!/bin/bash
set -e

# Update packages
yum update -y

# Install Docker
# NOTE: Do NOT install 'curl' here — AL2023 ships curl-minimal which conflicts with curl.
# curl-minimal is sufficient for all operations below.
yum install -y docker
systemctl enable docker
systemctl start docker

# Install Docker Compose plugin
# Use curl-minimal (already present on AL2023) with -fsSL flags so failures are fatal under set -e
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Create app directory
mkdir -p /opt/octorouter/auths /opt/octorouter/logs

# Generate .env from SST secrets
cat > /opt/octorouter/.env << ENV_EOF
CLIPROXYAPI_IMAGE=eceasy/cli-proxy-api-plus:latest
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

# Write docker-compose.yml
cat > /opt/octorouter/docker-compose.yml << 'COMPOSE_EOF'
${dockerCompose}COMPOSE_EOF

# Write Caddyfile
cat > /opt/octorouter/Caddyfile << 'CADDY_EOF'
${caddyfile}CADDY_EOF

# Write config.yaml from template (user must SSH in and fill real values)
if [ ! -f /opt/octorouter/config.yaml ]; then
  cat > /opt/octorouter/config.yaml << 'CONFIG_EOF'
${configExample}CONFIG_EOF
fi

# Create swap file if not exists
if [ ! -f /swapfile ]; then
  fallocate -l 512M /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Install adnanh/webhook binary (used by dashboard to trigger redeploys from UI)
if [ ! -x /usr/local/bin/webhook ]; then
  WEBHOOK_VERSION=2.8.2
  curl -fsSL "https://github.com/adnanh/webhook/releases/download/\${WEBHOOK_VERSION}/webhook-linux-amd64.tar.gz" \\
    -o /tmp/webhook.tar.gz
  tar -xzf /tmp/webhook.tar.gz -C /tmp
  install -m 0755 "/tmp/webhook-linux-amd64/webhook" /usr/local/bin/webhook
  rm -rf /tmp/webhook.tar.gz /tmp/webhook-linux-amd64
fi

# Webhook config (token substituted from .env at render time)
mkdir -p /opt/octorouter/webhook /var/log/octorouter
cat > /opt/octorouter/webhook/webhook.yaml.tmpl << 'WEBHOOK_EOF'
${webhookYaml}WEBHOOK_EOF
cat > /opt/octorouter/webhook/deploy-dashboard.sh << 'WEBHOOK_DEPLOY_EOF'
${webhookDeployScript}WEBHOOK_DEPLOY_EOF
chmod 0755 /opt/octorouter/webhook/deploy-dashboard.sh

# Render {{DEPLOY_SECRET}} into webhook.yaml using the value we just wrote to .env
sed "s|{{DEPLOY_SECRET}}|${deploySecret.value}|g" \\
  /opt/octorouter/webhook/webhook.yaml.tmpl > /opt/octorouter/webhook/webhook.yaml
chmod 0600 /opt/octorouter/webhook/webhook.yaml

# Install and start systemd unit for webhook
cat > /etc/systemd/system/octorouter-webhook.service << 'WEBHOOK_SVC_EOF'
${webhookSystemdUnit}WEBHOOK_SVC_EOF
systemctl daemon-reload
systemctl enable octorouter-webhook
systemctl restart octorouter-webhook

# Start services
cd /opt/octorouter
docker compose up -d
`;

  const instance = new aws.ec2.Instance('OctoRouterInstance', {
    instanceType: 't3.micro',
    ami: ami.imageId,
    subnetId: subnets.ids[0],
    vpcSecurityGroupIds: [security.securityGroupId],
    keyName: security.keyPairName,
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

  const zone = aws.route53.getZoneOutput({name: 'octopws.io.'});

  new aws.route53.Record('OctoRouterDnsRecord', {
    zoneId: zone.zoneId,
    name: 'octorouter.octopws.io',
    type: 'A',
    ttl: 300,
    records: [eip.publicIp]
  });

  new aws.route53.Record('OctoRouterDashboardDnsRecord', {
    zoneId: zone.zoneId,
    name: 'dashboard.octorouter.octopws.io',
    type: 'A',
    ttl: 300,
    records: [eip.publicIp]
  });

  return {
    OCTOROUTER_IP: eip.publicIp,
    OCTOROUTER_URL: 'https://octorouter.octopws.io'
  };
}

export const octoRouterInfrastructure = (): Record<string, string | $util.Output<unknown>> => {
  if ($app.stage !== 'ops') throw new Error(`No domain configured for stage '${$app.stage}'`);
  const stagingVpcId = 'vpc-07631f85d7c064e30';
  const vpc = sst.aws.Vpc.get('OctoVpc', stagingVpcId);
  const octorouter = createOctoRouter(vpc);
  return {...octorouter};
};
