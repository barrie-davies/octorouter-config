# OctoRouter

OctoRouter is an EC2-based proxy for Claude and Gemini models. It uses CLIProxyAPI to manage multiple OAuth accounts and provides a unified OpenAI-compatible API, along with a management dashboard.

## Services

| Service | Port | Description |
|---|---|---|
| postgres | — | PostgreSQL 16 database for the dashboard |
| cliproxyapi | 8317 | OpenAI/Gemini/Claude proxy for CLI OAuth sessions |
| docker-proxy | — | Restricted Docker socket proxy for container management |
| dashboard | 3000 | Web UI for managing CLIProxyAPI |
| caddy | 80, 443 | Reverse proxy with automatic HTTPS |

## SST Deployment

### Prerequisites
- AWS profile configured
- SST installed
- `bun install` run in the repository root

### Secrets Setup
Before deploying, you must set the following secrets for the `ops` stage:

```bash
bunx sst secret set OctoRouterSshPublicKey "ssh-ed25519 ..." --stage ops
bunx sst secret set OctoRouterSshAllowedCidr "1.2.3.4/32" --stage ops
bunx sst secret set OctoRouterPostgresPassword "$(openssl rand -hex 32)" --stage ops
bunx sst secret set OctoRouterJwtSecret "$(openssl rand -base64 32)" --stage ops
bunx sst secret set OctoRouterManagementApiKey "$(openssl rand -hex 32)" --stage ops
```

### Deploy Command
Deploy the stack to the `ops` stage:

```bash
bunx sst deploy --config apps/octorouter/sst.config.ts --stage ops
```

## Post-Deploy Setup

### 1. SSH into instance
Connect to the OctoRouter instance using the `ec2-user`:

```bash
ssh ec2-user@octorouter.octopws.io
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
curl -H "Authorization: Bearer YOUR_API_KEY" https://octorouter.octopws.io/v1/models
```

### 5. Dashboard access
The dashboard is available at: https://dashboard.octorouter.octopws.io

## Claude Max OAuth
Claude OAuth can be configured directly through the dashboard.

1. Open the dashboard at https://dashboard.octorouter.octopws.io
2. Navigate to the Claude OAuth section
3. Follow the browser-based authorization flow to link your Claude account

After completing the flow, the auth tokens are saved automatically and the service picks them up.

## Gemini OAuth
Gemini OAuth requires an SSH tunnel for the callback and a one-shot `docker run` command.

1. **Open SSH Tunnel**: On your **local machine**, open a tunnel for the OAuth callback:
   ```bash
   ssh -L 8085:localhost:8085 ec2-user@octorouter.octopws.io
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

### Update Image
To update to the latest version of CLIProxyAPI:

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

## EC2 Directory Layout
```
/opt/octorouter/
├── .env              # generated from SST secrets — never edit manually
├── docker-compose.yml
├── Caddyfile
├── config.yaml       # edit this manually after deploy
├── config.example.yaml
├── auths/            # CLIProxyAPI OAuth tokens
└── logs/             # container logs
```
