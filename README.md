# WebProject

A web app that converts PPTX files to PDF using independent workers.

## How it works

- **Nginx** balances HTTP requests between `api1` and `api2`.
- **PostgreSQL** stores accounts, sessions, tasks and the shared task queue.
- **worker1** and **worker2** process tasks independently with LibreOffice.
- An optional **remote worker** transfers files through an authenticated API without a shared volume.

## First start

Run these commands in the `WebProject` folder. Docker Desktop and Docker Compose are required.

1. Create `.env` from the example:

   ```sh
   cp .env.example .env
   ```

2. Set your own `POSTGRES_PASSWORD` and a random `WORKER_SHARED_SECRET` of at least 32 characters in `.env`. You can generate a secret with `openssl rand -hex 32`. Keep the limits in the same `.env` file. Never commit `.env`.

3. Start PostgreSQL:

   ```sh
   docker compose up -d db
   ```

4. For a **new, empty database only**, run these commands in order:

   ```sh
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < schema.sql
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < migrations/001_tasks.sql
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < migrations/002_uploads.sql
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < migrations/003_processing.sql
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < migrations/004_stages.sql
   ```

5. Start the app:

   ```sh
   docker compose up -d --build
   ```

Open **http://localhost:8080**, create an account, select a PPTX and use the conversion button. The task is queued automatically.

## Local HTTPS

For HTTPS on this Mac, install `mkcert` with Homebrew, then generate a certificate trusted by this computer:

```sh
brew install mkcert
mkcert -install
mkdir -p certs
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1
```

Start the app with the optional HTTPS configuration:

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d
```

Open **https://localhost:8443**. Normal browser visits to `http://localhost:8080` redirect to HTTPS in this mode. Session cookies use the `Secure` attribute. Local internal HTTP on port 80 remains available for the optional worker connection, and the regular `compose.yaml` setup still works without certificates.

Certificates and keys inside `certs/` are local and must never be committed or shared. The certificate is trusted on this Mac only; it is not a public-domain certificate or a ready-to-deploy public HTTPS setup. Remote access still requires a private VPN and appropriate TLS configuration.

### Updating an existing installation

If migration `004_stages.sql` has not been applied yet, run it once:

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < migrations/004_stages.sql
```

For an existing installation, keep the limit variables from `.env.example` in your existing `.env`. Do not overwrite your password or worker secret. Run `docker compose up -d --build` after configuration changes. For updates that change only `server.js` and the frontend, rebuilding `api1` and `api2` is enough. No SQL migration is required. Never run `docker compose down -v`: it removes database and file volumes.

## Check load balancing

Use the website's infrastructure buttons to check requests across `api-1` and `api-2`. Run several conversions to see different worker names on finished tasks. The browser shows actual PPTX upload progress, then the task bar shows **upload**, **preparing**, **converting**, and **saving**. LibreOffice does not provide a reliable conversion percentage.

## Limits

Configure limits in `.env` (use `.env.example` for the variable names):

- `MAX_PPTX_MIB=30`: PPTX upload size; applied to frontend, API, workers and Nginx.
- `MAX_PDF_MIB=100`: maximum PDF output size; applied to API, workers and Nginx.
- `MAX_ACTIVE_TASKS=3`: active tasks per user.
- `MAX_PPTX_ENTRIES=2000` and `MAX_UNCOMPRESSED_MIB=150`: PPTX complexity limits.
- `CONVERSION_TIMEOUT_SECONDS=120`: conversion time limit.
- `WORKER_MEMORY=1g` and `WORKER_CPUS=1.0`: resource limits for each worker.

The browser gets only public limits from `/api/config`; database passwords and other secrets are not returned. The history loads 30 tasks per page, with filters and navigation to older results. Statistics cover the full history. Completed, failed, cancelled and old draft tasks can be deleted individually or cleared from history with their files. Active tasks must be cancelled first.

## Optional remote worker

`compose.remote-worker.yaml` runs a worker without the shared upload volume. It connects to the central PostgreSQL database and transfers files through the API. Use `remote-worker.env.example` as a guide for its settings. Configure the same processing limits in `.env` on both Docker hosts.

To test this on the same Docker host, stop the regular workers and start the network-only worker:

```sh
docker compose stop worker1 worker2
REMOTE_DB_HOST=db REMOTE_FILES_URL=http://nginx docker compose -f compose.yaml -f compose.remote-worker.yaml up -d --build worker_remote
```

After testing, restore the regular workers:

```sh
docker compose -f compose.yaml -f compose.remote-worker.yaml stop worker_remote
docker compose start worker1 worker2
```

A second computer requires a private VPN, restricted network access and matching secrets. Never expose PostgreSQL or the worker HTTP endpoints directly to the public internet. Multi-computer deployment has not been tested.

## Known limitations

Conversions are not retried automatically after failures. Finished PDFs do not expire automatically. Cancellation is best-effort; a running LibreOffice process is checked regularly. Crash recovery was demonstrated by stopping workers, but it does not retry interrupted tasks. Automatic scaling and an admin panel are not included. HTTPS is available for local development only.
