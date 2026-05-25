# ClimaCR — Agent Instructions

## Running the app

```
docker compose up
```

- Frontend: `http://localhost:8090`
- Backend API: `http://localhost:8090/api/` (proxied through Nginx)
- Backend direct (inside Docker network): `backend:8000`
- Backend local dev: `pip install -r backend/requirements.txt && uvicorn backend.main:app --reload --port 8000`

No build step. Frontend is vanilla HTML/CSS/JS served by Nginx.

## Architecture

- **Single-file backend**: `backend/main.py` (FastAPI + Uvicorn). Everything — startup, caching, scraping, API — is in one file.
- **Cache-first design**: On container boot and every 60s background, data is fetched and written to `/app/data/weather_cache.json`. The API reads from this cache. Modifying scraper logic requires restarting the container to repopulate the cache.
- **Three data sources**:
  1. WIS2.0 (WMO standard) from `http://wis2box.imn.ac.cr/oapi/...`
  2. Campbell RTMC ~100 HTML station pages from `https://www.imn.ac.cr/especial/tablas/{slug}.html` (parallel scraped, 25 workers)
  3. IMN national forecast from `https://www.imn.ac.cr/web/imn/inicio`
- Campbell data overwrites WIS2.0 entries when station exists in both.
- Frontend polls `/api/weather` every 60s. For stations without hourly schedule data, it generates mock hourly data via sinusoidal curves.

## API auth

Every frontend request to `/api/` must include the header:

```
X-App-Signature: CRWeatherMapSecretToken2026
```

Nginx enforces this before proxying to the backend. When testing the backend directly (bypassing Nginx), this header is **not** enforced — the guard lives in `nginx.conf`.

## Key files

| File | Purpose |
|------|---------|
| `backend/main.py` | Entire backend: startup events, cache, scrapers, FastAPI endpoint |
| `backend/requirements.txt` | 3 deps: fastapi, uvicorn, requests |
| `frontend/app.js` | Leaflet map, Chart.js charts, polling, detail panel |
| `frontend/index.css` | Dark glassmorphism theme, compass animation |
| `nginx.conf` | Reverse proxy, CORS, auth guard, gzip |
| `docker-compose.yml` | Two services (frontend, backend), `weather_data` volume, `weather_net` network |

## Constraints

- No tests, no linting, no CI.
- No git repo. No `.gitignore`, no env files, no `opencode.json`.
- Backend Python 3.11; frontend has zero dependencies (CDNs only).
- The `weather_data` Docker volume persists cache across restarts. Run `docker volume rm crmeteo_weather_data` to clear.
