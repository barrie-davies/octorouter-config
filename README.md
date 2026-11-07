# OctoRouter

> **Origin.** Extracted from `barrie-davies/octopws-operational-tools` (`apps/octorouter`) with its git
> history, up to commit `18b50a6` (2026-09-23). This is the deployment behind https://octorouter.octinho.com.
>
> **Before you deploy:** as written, `sst deploy --stage ops` targets the same SST app (`octorouter`),
> stage, AWS account (`octoathlete-pr`) and domains as the live router. It would update that stack, not
> create a second one. For a separate router, change these first:
> - the app `name` in `sst.config.ts`;
> - `ROOT_DOMAIN`, `SUBZONE`, `API_DOMAIN` and `DASHBOARD_DOMAIN` in `infra/octorouter.ts`;
> - both host names in `services/Caddyfile`, and `DASHBOARD_URL` and `API_URL` in `services/docker-compose.yml`;
> - `keyName: 'octorouter-key'` in `infra/octorouter.ts`, because key pair names must be unique per region;
> - the AWS profile and account, if it goes somewhere else.

OctoRouter is an EC2-based proxy for Claude and Gemini models. It uses CLIProxyAPI to manage multiple OAuth accounts and provides a unified OpenAI-compatible API, a management dashboard, and the upstream Cli-Proxy-API-Management-Center static UI.

## Endpoints

| URL | Purpose |
|---|---|
| https://octorouter.octinho.com | OpenAI/Gemini/Claude-compatible proxy API |
| https://octorouter.octinho.com/management.html | Upstream Cli-Proxy-API-Management-Center UI (bundled with CLIProxyAPI) |
| https://dashboard.octorouter.octinho.com | Custom dashboard (cliproxyapi-dashboard) |

## Services

| Service | Port | Description |
|---|---|---|
| postgres | — | PostgreSQL 16 database for the dashboard |
| cliproxyapi | 8317 | OpenAI/Gemini/Claude proxy for CLI OAuth sessions |
| docker-proxy | — | Restricted Docker socket proxy for container management |
| dashboard | 3000 | Custom Web UI for managing CLIProxyAPI |
| caddy | 80, 443 | Reverse proxy with automatic HTTPS; also serves the management-center static SPA |

## AWS / DNS Layout

- **Deploy account**: `octoathlete-pr` (842091916323), region `eu-west-2`
- **Apex domain**: `octinho.com` lives in `octoathlete-shared` (510537391651)
- **Delegated zone**: SST creates `octorouter.octinho.com` as a hosted zone in the deploy account. After the first deploy you must add an `NS` record for `octorouter` in the apex zone (in the shared account) pointing to the four NS records output by SST as `DELEGATED_ZONE_NAMESERVERS`.

## SST Deployment

### Prerequisites
- AWS profile `octoathlete-pr` available locally (SSO login: `aws sso login --profile octoathlete-pr`)
- AWS profile `octoathlete-shared` available for the one-time NS delegation step
- SST installed
- `bun install` run in this repository

### Secrets Setup
Before deploying, set the following secrets for the `ops` stage (each command is the deploy account):

```bash
export AWS_PROFILE=octoathlete-pr
bunx sst secret set OctoRouterSshPublicKey "ssh-ed25519 ..." --stage ops
bunx sst secret set OctoRouterSshAllowedCidr "1.2.3.4/32" --stage ops
bunx sst secret set OctoRouterPostgresPassword "$(openssl rand -hex 32)" --stage ops
bunx sst secret set OctoRouterJwtSecret "$(openssl rand -base64 32)" --stage ops
bunx sst secret set OctoRouterManagementApiKey "$(openssl rand -hex 32)" --stage ops
bunx sst secret set OctoRouterDeploySecret "$(openssl rand -hex 32)" --stage ops
```

### Deploy Command
Deploy the stack to the `ops` stage:

```bash
export AWS_PROFILE=octoathlete-pr
bunx sst deploy --stage ops
```

### One-time NS Delegation (after first deploy)

SST outputs `DELEGATED_ZONE_NAMESERVERS` — a list of four AWS NS hostnames. Add an `NS` record for the name `octorouter` in the `octinho.com` hosted zone in `octoathlete-shared` pointing to those four nameservers (TTL 300):

```bash
NS_LIST=$(bunx sst outputs --stage ops | awk -F': ' '/DELEGATED_ZONE_NAMESERVERS/{print $2}')
ZONE_ID=$(aws --profile octoathlete-shared route53 list-hosted-zones \
  --query 'HostedZones[?Name==`octinho.com.`].Id' --output text | sed 's|/hostedzone/||')

cat > /tmp/octorouter-ns.json <<JSON
{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"octorouter.octinho.com.","Type":"NS","TTL":300,
  "ResourceRecords":[
    $(echo "$NS_LIST" | tr -d '[]"' | tr ',' '\n' | xargs -I{} printf '{"Value":"{}"},' | sed 's/,$//')
  ]}}]}
JSON

aws --profile octoathlete-shared route53 change-resource-record-sets \
  --hosted-zone-id "$ZONE_ID" --change-batch file:///tmp/octorouter-ns.json
```

This is a one-time step. Subsequent deploys reuse the same delegated zone.

## Post-Deploy Setup

### 1. SSH into instance
Connect to the OctoRouter instance using the `ec2-user`:

```bash
ssh ec2-user@octorouter.octinho.com
```

### 2. Set up config.yaml
Navigate to the application directory and create your configuration file from the template:

```bash
cd /opt/octorouter
cp config.example.yaml config.yaml
```

Edit `config.yaml` to set your secrets:
- **Management Secret**: Use the same value as `OctoRouterManagementApiKey`.
- **API Keys**: Generate at least one API key for clients to connect.
  ```bash
  openssl rand -hex 32
  ```

### 3. Restart services
Apply the configuration changes by restarting the Docker containers:

```bash
docker compose down && docker compose up -d
```

### 4. Verify API is running
Check if the API is responding correctly using your newly generated API key:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://octorouter.octinho.com/v1/models
```

### 5. Dashboard access
The dashboard is available at: https://dashboard.octorouter.octinho.com

## Claude Max OAuth
Claude OAuth can be configured directly through the dashboard.

1. Open the dashboard at https://dashboard.octorouter.octinho.com
2. Navigate to the Claude OAuth section
3. Follow the browser-based authorization flow to link your Claude account

After completing the flow, the auth tokens are saved automatically and the service picks them up.

## Gemini OAuth
Gemini OAuth requires an SSH tunnel for the callback and a one-shot `docker run` command.

1. **Open SSH Tunnel**: On your **local machine**, open a tunnel for the OAuth callback:
   ```bash
   ssh -L 8085:localhost:8085 ec2-user@octorouter.octinho.com
   ```
2. **Run OAuth Command**: On the EC2 instance, run a temporary container for the login flow:
   ```bash
   cd /opt/octorouter
   docker run --rm -it \
     -p 8085:8085 \
     -v /opt/octorouter/auths:/root/.cli-proxy-api \
     -v /opt/octorouter/config.yaml:/CLIProxyAPI/config.yaml:ro \
     eceasy/cli-proxy-api-plus:latest \
     ./CLIProxyAPIPlus -login -no-browser
   ```
3. **Complete in Browser**: Open the Google URL printed in the terminal, log in, and choose **2** (Google One mode) when prompted.
4. **Restart the service** to pick up the new auth tokens:
   ```bash
   docker compose restart cliproxyapi
   ```

> **Note:** Do not use `docker exec` on the running container for auth — the binary will try to bind port 8317 which is already in use. The `docker run` approach starts a fresh temporary container instead.

## Maintenance

### Update CLIProxyAPI (preferred — from the dashboard)
The CLIProxyAPI proxy can be upgraded without SSH access:

1. Open https://dashboard.octorouter.octinho.com
2. The dashboard polls Docker Hub for new tags of `eceasy/cli-proxy-api-plus`. When a newer version is available, an "Update Available" banner appears.
3. Click the specific version button (e.g. **v6.9.30-0**) in the *Available Versions* row. Avoid the **Update to Latest** button — it sends `version=latest` and unpins the running container's tag, which breaks version display.
4. After a successful upgrade, **bump the tag in `services/docker-compose.yml`** in this repo and redeploy via SST so fresh installs and host reboots come up on the same version.

How it works: the dashboard's `POST /api/update` calls `docker pull <image>:<version>` then `docker run` with the previous container's env, volumes, ports, and networks (compose plugin isn't installed in the dashboard image, so the compose-based path is skipped). Access to the Docker daemon is brokered through the read-write-restricted `tecnativa/docker-socket-proxy` sidecar (`CONTAINERS`, `IMAGES`, `POST`, `NETWORKS` enabled — everything else denied).

The `cliproxyapi` service in `docker-compose.yml` MUST stay pinned to a versioned tag (e.g. `eceasy/cli-proxy-api-plus:v6.9.28-0`). The dashboard parses the running version from `Config.Image`, so a bare `:latest` tag makes the UI report "latest" forever and the auto-update banner stops working.

> **Drift warning**: dashboard updates only change the running container — they do **not** touch this compose file. If you upgrade via the dashboard but skip step 4, a host reboot or `docker compose up -d` will recreate the container at the older tag still in compose, silently downgrading the proxy. Always bump the tag in this repo after a dashboard update.

> **Known dashboard quirk**: the *Update Available* banner shows even when current and latest match. The dashboard compares the local image config ID against the Docker Hub registry digest — different SHA spaces, never equal. Ignore the banner unless `Latest Version` is genuinely newer than `Current Version`.

### Update CLIProxyAPI (manual fallback, requires SSH)
```bash
cd /opt/octorouter
docker compose pull && docker compose up -d
```

### Check Logs
View real-time logs for troubleshooting:

```bash
docker compose logs -f cliproxyapi
```

## Troubleshooting

### Caddy Certificate Issues
If HTTPS is not working, check Caddy logs:
```bash
docker compose logs caddy
```
Ensure port 80 and 443 are open in the EC2 Security Group for Let's Encrypt challenges.

### OAuth Callback Fails
- Ensure the SSH tunnel is active on port 8085 for Gemini OAuth.
- Check that no other service is using that port on your local machine.
- For Claude, use the dashboard instead — no tunnel needed.

### Containers Not Starting
Check the status of the containers:
```bash
docker compose ps
```
If a container is in a restart loop, check its logs for configuration errors in `config.yaml`.

## Dashboard Deploy Webhook

The dashboard can redeploy itself from its admin panel. This is powered by
[adnanh/webhook](https://github.com/adnanh/webhook) running on the host
(systemd: `octorouter-webhook`) and listening on port 9000 on the Docker
host gateway only — never exposed to the public internet.

Setup is automatic via SST user-data. The `DEPLOY_SECRET` SST secret is
rendered into both `/opt/octorouter/.env` (picked up by the dashboard
container) and `/opt/octorouter/webhook/webhook.yaml` (validated as the
`X-Deploy-Token` header on every hook call).

### Endpoints (called from dashboard container only)
- `POST http://host.docker.internal:9000/hooks/deploy-dashboard` — pull + recreate dashboard
- `POST http://host.docker.internal:9000/hooks/deploy-dashboard-nocache` — same (no-cache flag is a no-op for prebuilt images)
- `POST http://host.docker.internal:9000/hooks/deploy-status` — read last deploy status JSON
- `POST http://host.docker.internal:9000/hooks/deploy-log` — read last deploy log

### Managing the webhook service
```bash
sudo systemctl status octorouter-webhook
sudo journalctl -u octorouter-webhook -f
sudo tail -f /var/log/octorouter/dashboard-deploy.log
```

## EC2 Directory Layout
```
/opt/octorouter/
├── .env              # generated from SST secrets — never edit manually
├── docker-compose.yml
├── Caddyfile
├── config.yaml       # edit this manually after deploy
├── config.example.yaml
├── auths/            # CLIProxyAPI OAuth tokens
├── logs/             # container logs
└── webhook/          # adnanh/webhook config + deploy script
    ├── webhook.yaml
    └── deploy-dashboard.sh
```
