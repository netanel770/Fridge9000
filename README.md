# Fridge 9000 (Dev)

## Requirements
- Docker Desktop

## Run
From repo root:
```bash
docker compose up --build
URLs
Frontend Dashboard: http://localhost:5173

Backend API (Swagger): http://localhost:8000/docs

Backend Health: http://localhost:8000/health

Stop
docker compose down
Reset DB (delete data)
This will erase all DB data.

docker compose down -v
docker compose up --build
Notes
DB schema + seed are initialized from db/init.sql on first run only.

If you changed schema and want init.sql to re-run, reset volumes (down -v).

