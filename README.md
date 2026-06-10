# ClimaCR

Dashboard interactivo de monitoreo meteorológico en tiempo real para Costa Rica. Muestra datos de ~158 estaciones del IMN sobre un mapa con gráficas de temperatura, precipitación, viento y humedad.

## Correr localmente

```bash
docker compose up
```

> **Nota:** Si haces cambios en el frontend y no se reflejan en el navegador, haz un hard refresh (`Ctrl+Shift+R`) o reconstruye los contenedores con `docker compose up --build`.

- Frontend: `http://localhost:8090`
- Backend API: `http://localhost:8090/api/` (proxied vía Nginx)

## Arquitectura

| Capa | Tecnología |
|------|-----------|
| **Frontend** | HTML/CSS/JS vanilla + Leaflet + Chart.js |
| **Backend** | Python 3.11, FastAPI, Uvicorn |
| **Reverse proxy** | Nginx Alpine |
| **Containerización** | Docker Compose (2 servicios) |

- **Backend single-file**: `backend/main.py` contiene todo — startup, scraping, caché y endpoint.
- **Cache-first**: Al arrancar y cada 30s, se scrapean las 3 fuentes y se escriben en `/app/data/weather_cache.json`. El endpoint `/api/weather` solo lee ese archivo.
- **Fuentes de datos**:
  1. **WIS2.0** (WMO) desde `wis2box.imn.ac.cr`
  2. **Campbell RTMC** — ~158 estaciones scrapadas del IMN (paralelo, 25 workers)
  3. **Pronóstico nacional** del IMN
- Campbell sobrescribe datos WIS2.0 cuando hay conflicto en la misma estación.
- El frontend genera datos horarios simulados (curvas sinusoidales) para estaciones sin historial.

## Despliegue (Dokploy)

Usa `docker-compose.prod.yml` — no expone puertos, Dokploy maneja el routing externo.

## Estructura

```
docker-compose.yml          # Desarrollo (puerto 8090)
docker-compose.prod.yml     # Producción (sin puertos expuestos)
nginx.conf                  # Proxy, CORS, auth header, gzip
backend/
  main.py                   # Todo el backend (scraping + API + scheduler)
  requirements.txt          # fastapi, uvicorn, requests
frontend/
  index.html
  app.js                    # Mapa, gráficas, polling, panel detalle
  index.css                 # Tema glassmorphism
```

## Autenticación

Nginx exige el header `X-App-Signature: CRWeatherMapSecretToken2026` en `/api/`. Bypass de Nginx (backend directo) no lo verifica.

## Notas

- Sin tests, lint, CI ni `.gitignore`.
- Volumen `weather_data` persiste cache. Limpiar: `docker volume rm crmeteo_weather_data`.
- Los datos del IMN se actualizan cada ~10 min en la web; el scraper captura lo disponible cuando refresca.
