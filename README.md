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

2. Set your own `POSTGRES_PASSWORD` and a random `WORKER_SHARED_SECRET` of at least 32 characters in `.env`. You can generate a secret with `openssl rand -hex 32`. Never commit `.env`.

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

Open **http://localhost:8080**, create an account, upload a PPTX and start a conversion.

### Updating an existing installation

**Apply the new stage migration before rebuilding the app:**

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U webproject -d webproject < migrations/004_stages.sql
docker compose up -d --build
```

Keep your existing `.env`. Do not run `docker compose down -v`: it removes database and file volumes.

## Check load balancing

Use the website's infrastructure buttons to check requests across `api-1` and `api-2`. Run several conversions to see different worker names on finished tasks. While a task runs, the progress bar shows real stages: **preparing**, **converting**, and **saving**. LibreOffice does not provide a reliable percentage.

## Limits

- Up to 3 active tasks per user.
- PPTX up to 30 MiB, 2,000 ZIP entries and 150 MiB uncompressed content.
- Conversion timeout: 120 seconds. Each worker: 1 CPU and 1 GiB RAM.
- PDF up to 100 MiB. The website shows the latest 30 tasks.

## Optional remote worker

`compose.remote-worker.yaml` runs a worker without the shared upload volume. It connects to the central PostgreSQL database and transfers files through the API. Use `remote-worker.env.example` as a guide for its settings.

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

Conversions are not retried automatically after failures. Finished PDFs do not expire automatically. Cancelling a running conversion and crash recovery still need full Docker testing. HTTPS, automatic scaling and an admin panel are not included.
