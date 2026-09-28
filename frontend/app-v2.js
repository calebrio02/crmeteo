// Configuración y variables globales
const API_URL = '/api/weather';
const APP_SIGNATURE = 'CRWeatherMapSecretToken2026';
let map;
let markerLayerGroup;
let weatherData = null;
let tempChart = null;
let rainChart = null;

// Inicialización de la aplicación
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    fetchWeatherData();
    
    // Configurar polling cada 60 segundos
    setInterval(fetchWeatherData, 60000);

    // Botón cerrar sidebar detalle
    document.getElementById('btn-close-sidebar').addEventListener('click', closeDetailSidebar);

    // Inicializar reproductor de audio del pronóstico
    initForecastAudioPlayer();

    // Gestos del bottom sheet (móvil) y segmented control de gráficas
    initMobileSheetGestures();
    initChartTabs();
});

// =============================================================
// BOTTOM SHEET TRICAMERAL (PEEK / HALF / FULL) — solo móvil
// =============================================================
function setMobileSheetState(state) {
    const sidebar = document.getElementById('station-sidebar');
    if (!sidebar) return;
    sidebar.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
    sidebar.classList.add(`sheet-${state}`);
    sidebar.dataset.sheetState = state;
    // Permite al CSS recolocar la atribución Leaflet sobre el borde del sheet
    document.body.dataset.sheetState = state;
    // Redimensionar gráficas activas una vez termina la transición de altura
    setTimeout(() => {
        if (typeof tempChart !== 'undefined' && tempChart) tempChart.resize();
        if (typeof rainChart !== 'undefined' && rainChart) rainChart.resize();
    }, 360);
}

function initMobileSheetGestures() {
    const sidebar = document.getElementById('station-sidebar');
    const dragZone = document.getElementById('sidebar-drag-zone') || document.getElementById('sidebar-drag-handle');
    const expandBtn = document.getElementById('btn-toggle-expand');
    const hint = document.getElementById('sheet-expand-hint');
    if (!sidebar || !dragZone) return;

    let startY = null;
    let currentY = 0;
    let lastTouchEnd = 0;

    dragZone.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        currentY = startY;
    }, { passive: true });

    dragZone.addEventListener('touchmove', (e) => {
        currentY = e.touches[0].clientY;
    }, { passive: true });

    dragZone.addEventListener('touchend', () => {
        if (startY === null) return;
        const deltaY = currentY - startY;
        const state = sidebar.dataset.sheetState || 'peek';
        startY = null;
        lastTouchEnd = Date.now();

        if (deltaY < -35) {                    // deslizar arriba: expandir
            if (state === 'peek') setMobileSheetState('half');
            else if (state === 'half') setMobileSheetState('full');
        } else if (deltaY > 35) {              // deslizar abajo: contraer
            if (state === 'full') setMobileSheetState('half');
            else if (state === 'half') setMobileSheetState('peek');
        } else if (Math.abs(deltaY) <= 10) {   // tap: ciclar estados
            if (state === 'peek') setMobileSheetState('half');
            else if (state === 'half') setMobileSheetState('full');
            else setMobileSheetState('peek');
        }
    }, { passive: true });

    // Click de ratón (desktop con viewport estrecho); ignora el click
    // sintético que el navegador emite tras un gesto táctil
    dragZone.addEventListener('click', () => {
        if (Date.now() - lastTouchEnd < 600) return;
        const state = sidebar.dataset.sheetState || 'peek';
        if (state === 'peek') setMobileSheetState('half');
        else if (state === 'half') setMobileSheetState('full');
        else setMobileSheetState('peek');
    });

    if (expandBtn) expandBtn.addEventListener('click', () => setMobileSheetState('full'));
    if (hint) {
        hint.addEventListener('click', () => setMobileSheetState('full'));
        hint.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMobileSheetState('full'); }
        });
    }
}

// Segmented control: Temperatura / Precipitación (móvil)
function initChartTabs() {
    const detail = document.getElementById('sidebar-detail');
    const btnTemp = document.getElementById('btn-tab-temp');
    const btnRain = document.getElementById('btn-tab-rain');
    if (!detail || !btnTemp || !btnRain) return;

    const select = (tab) => {
        detail.dataset.chartTab = tab;
        btnTemp.classList.toggle('active', tab === 'temp');
        btnRain.classList.toggle('active', tab === 'rain');
        setTimeout(() => {
            if (tab === 'temp' && typeof tempChart !== 'undefined' && tempChart) tempChart.resize();
            if (tab === 'rain' && typeof rainChart !== 'undefined' && rainChart) rainChart.resize();
        }, 60);
    };

    btnTemp.addEventListener('click', () => select('temp'));
    btnRain.addEventListener('click', () => select('rain'));
}

// Inicializar mapa de Leaflet
function initMap() {
    // Coordenadas centrales de Costa Rica y nivel de zoom óptimo
    map = L.map('map', {
        zoomControl: true,
        attributionControl: true
    }).setView([9.95, -84.05], 8.5);

    // Mapa base: Esri World Dark Canvas (gratis, sin API key, tema oscuro premium)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; <a href="https://www.esri.com/">Esri</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
        minZoom: 6,
        detectRetina: true
    }).addTo(map);

    // Capa de etiquetas (vías, topónimos) sobre la base oscura
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        minZoom: 6
    }).addTo(map);

    // Grupo de capas con CLUSTERING (118 estaciones; GAM densa: San José/Cartago)
    markerLayerGroup = L.markerClusterGroup({
        maxClusterRadius: 36,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        disableClusteringAtZoom: 13,
        iconCreateFunction: function (cluster) {
            const count = cluster.getChildCount();
            return L.divIcon({
                html: `<div class="custom-cluster-badge"><span>${count}</span></div>`,
                className: 'marker-cluster-custom',
                iconSize: [34, 34],
                iconAnchor: [17, 17]
            });
        }
    });
    map.addLayer(markerLayerGroup);

    // Cerrar el panel de detalle y mostrar resumen nacional al hacer clic en el fondo del mapa
    map.on('click', () => {
        closeDetailSidebar();
    });
}

// Consultar los datos de la API
async function fetchWeatherData() {
    const headers = new Headers();
    headers.append('X-App-Signature', APP_SIGNATURE);

    try {
        const response = await fetch(API_URL, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        if (result.status === 'success') {
            weatherData = result;
            updateUI();
        }
    } catch (error) {
        console.error('Error al obtener datos meteorológicos:', error);
        document.getElementById('last-update-time').innerText = 'Error de conexión';
    }
}

// Actualizar la interfaz de usuario con los datos recopilados
function updateUI() {
    if (!weatherData || !weatherData.stations) return;

    const stations = weatherData.stations;

    // 1. Limpiar marcadores anteriores
    markerLayerGroup.clearLayers();

    // 2. Calcular estadísticas nacionales básicas
    let totalTemp = 0;
    let tempCount = 0;
    let maxTemp = -999, minTemp = 999, maxWind = -999;
    let maxTempStation = '', minTempStation = '', maxWindStation = '';

    stations.forEach(station => {
        const temp = station.air_temperature;
        const wind = station.wind_speed || station.maximum_wind_gust_speed;

        // Temperatura
        if (temp !== undefined && temp !== null) {
            totalTemp += temp;
            tempCount++;

            if (temp > maxTemp) {
                maxTemp = temp;
                maxTempStation = station.name;
            }
            if (temp < minTemp) {
                minTemp = temp;
                minTempStation = station.name;
            }
        }

        // Viento normalizado a km/h (wis2box reporta en m/s, Campbell en km/h)
        const windKmh = (wind !== undefined && wind !== null) ? (station.source.includes('wis2box') ? wind * 3.6 : wind) : null;
        if (windKmh !== null) {
            if (windKmh > maxWind) {
                maxWind = windKmh;
                maxWindStation = station.name;
            }
        }

        // 3. Pintar marcador en el mapa
        createStationMarker(station);
    });

    // 4. Actualizar widgets estáticos en el encabezado
    document.getElementById('total-stations').innerText = stations.length;
    
    if (tempCount > 0) {
        const avg = (totalTemp / tempCount).toFixed(1);
        document.getElementById('avg-temp').innerText = `${avg} °C`;
    } else {
        document.getElementById('avg-temp').innerText = 'N/A';
    }

    // 5. Actualizar sección lateral de vista general
    document.getElementById('max-temp-val').innerText = maxTemp !== -999 ? `${maxTemp.toFixed(1)} °C` : 'N/A';
    document.getElementById('max-temp-loc').innerText = maxTempStation || '-';
    document.getElementById('max-temp-loc').title = maxTempStation || '';

    document.getElementById('min-temp-val').innerText = minTemp !== 999 ? `${minTemp.toFixed(1)} °C` : 'N/A';
    document.getElementById('min-temp-loc').innerText = minTempStation || '-';
    document.getElementById('min-temp-loc').title = minTempStation || '';

    document.getElementById('max-wind-val').innerText = maxWind !== -999 ? `${maxWind.toFixed(1)} km/h` : 'N/A';
    document.getElementById('max-wind-loc').innerText = maxWindStation || '-';
    document.getElementById('max-wind-loc').title = maxWindStation || '';

    // Franja telemétrica PEEK (móvil)
    const peekMax = document.getElementById('peek-max-temp');
    if (peekMax) peekMax.innerText = maxTemp !== -999 ? `${maxTemp.toFixed(1)}°` : '--';
    const peekMaxLoc = document.getElementById('peek-max-loc');
    if (peekMaxLoc) { peekMaxLoc.innerText = maxTempStation || '-'; peekMaxLoc.title = maxTempStation || ''; }
    const peekMin = document.getElementById('peek-min-temp');
    if (peekMin) peekMin.innerText = minTemp !== 999 ? `${minTemp.toFixed(1)}°` : '--';
    const peekMinLoc = document.getElementById('peek-min-loc');
    if (peekMinLoc) { peekMinLoc.innerText = minTempStation || '-'; peekMinLoc.title = minTempStation || ''; }

    // Formatear hora de última actualización
    const cacheTime = new Date();
    document.getElementById('last-update-time').innerText = cacheTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // 6. Actualizar sección de Pronóstico Nacional Diario
    if (weatherData && weatherData.national_forecast) {
        const fc = weatherData.national_forecast;
        document.getElementById('forecast-date').innerText = fc.date || 'Pronóstico Diario';
        document.getElementById('forecast-text').innerText = fc.text || 'Sin texto de pronóstico disponible hoy.';
        
        const audioEl = document.getElementById('forecast-native-audio');
        if (audioEl && fc.audio_url) {
            // Guardamos la URL actual para comparar sin interrumpir la reproducción
            const currentSrc = audioEl.src ? audioEl.src.split('?')[0] : '';
            const targetSrc = fc.audio_url.split('?')[0];
            
            // Solo cambiamos el src si el audio está pausado y la URL es diferente,
            // garantizando que nunca se interrumpa una reproducción activa.
            if (currentSrc !== targetSrc && audioEl.paused) {
                audioEl.src = fc.audio_url;
                audioEl.load();
            }
            document.querySelector('.forecast-audio-player').style.display = 'flex';
        } else if (audioEl) {
            document.querySelector('.forecast-audio-player').style.display = 'none';
        }
    }
}

// Determinar la clase de estado visual basado en la temperatura
function getTempStatusClass(temp) {
    // Escala de 5 zonas bioclimáticas de Costa Rica
    if (temp == null) return 'temp-status-mild';
    if (temp < 17.0) return 'temp-status-alpine';
    if (temp < 22.0) return 'temp-status-cool';
    if (temp < 27.0) return 'temp-status-mild';
    if (temp < 32.0) return 'temp-status-warm';
    return 'temp-status-hot';
}

// Crear marcador interactivo personalizado (Glowing Dot)
function createStationMarker(station) {
    const coords = station.coordinates;
    if (!coords || coords.length < 2) return;

    const temp = station.air_temperature;
    const tempStr = temp !== undefined && temp !== null ? `${temp.toFixed(1)}°C` : '--';
    const statusClass = getTempStatusClass(temp);

    // HTML del marcador personalizado
    const customIconHtml = `
        <div class="custom-marker">
            <div class="marker-pulse ${statusClass}"></div>
            <div class="marker-pin ${statusClass}"></div>
        </div>
    `;

    const icon = L.divIcon({
        html: customIconHtml,
        className: 'div-icon-container',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });

    // Crear marcador Leaflet
    const marker = L.marker([coords[1], coords[0]], { icon: icon });

    // Tooltip telemétrico con clases CSS (sin estilos inline)
    marker.bindTooltip(`
        <div class="weather-tooltip-inner">
            <span class="tooltip-name">${station.name}</span>
            <span class="tooltip-temp ${statusClass}">${tempStr}</span>
        </div>
    `, {
        direction: 'top',
        offset: [0, -8],
        className: 'custom-weather-tooltip',
        opacity: 1
    });

    // Acción al hacer clic: detalle + sonar radar únicamente en el pin activo
    marker.on('click', () => {
        markerLayerGroup.getLayers().forEach(m => {
            const el = m.getElement();
            if (el) {
                const cm = el.querySelector('.custom-marker');
                if (cm) cm.classList.remove('is-selected');
            }
        });
        const el = marker.getElement();
        if (el) {
            const cm = el.querySelector('.custom-marker');
            if (cm) cm.classList.add('is-selected');
        }
        showStationDetails(station);
    });

    markerLayerGroup.addLayer(marker);
}

// Calcular Punto de Rocío científicamente usando la fórmula de Magnus-Tetens
function calculateDewPoint(temp, rh) {
    if (temp === undefined || temp === null || rh === undefined || rh === null) return null;
    const a = 17.625;
    const b = 243.04;
    const alpha = ((a * temp) / (b + temp)) + Math.log(rh / 100);
    const dewPoint = (b * alpha) / (a - alpha);
    return dewPoint;
}

// Generar historial de simulación térmica para estaciones WMO sin tabla Horarios
function generateMockHourlyData(currentTemp, minTemp, maxTemp, rainAccum) {
    const hourly = [];
    const baseMin = minTemp !== null && minTemp !== undefined ? minTemp : currentTemp - 4.5;
    const baseMax = maxTemp !== null && maxTemp !== undefined ? maxTemp : currentTemp + 5.2;
    const range = baseMax - baseMin;
    const now = new Date();
    
    // Distribuir la lluvia acumulada de forma realista en pocas horas
    const rainPoints = Array(24).fill(0);
    if (rainAccum > 0) {
        const count = Math.min(3, Math.ceil(rainAccum / 0.8));
        let remaining = rainAccum;
        for (let k = 0; k < count; k++) {
            const idx = Math.floor(12 + Math.random() * 8); // Típicamente llueve por la tarde (12pm a 8pm)
            const amt = k === count - 1 ? remaining : parseFloat((Math.random() * remaining).toFixed(1));
            rainPoints[idx] = amt;
            remaining -= amt;
        }
    }
    
    for (let i = 23; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 3600000);
        const hour = time.getHours();
        
        // Curva sinusoidal térmica diaria centrada a las 3 PM
        const angle = ((hour - 9) / 24) * 2 * Math.PI;
        const rawTemp = baseMin + (range / 2) * (1 + Math.sin(angle));
        
        // Ruido aleatorio realista
        const noise = (Math.sin(i * 0.8) * 0.1) + ((Math.random() - 0.5) * 0.15);
        const tempVal = parseFloat((rawTemp + noise).toFixed(1));
        
        const hours12 = hour % 12 || 12;
        const ampm = hour >= 12 ? 'p. m.' : 'a. m.';
        const timeLabel = `${String(hours12).padStart(2, '0')}:00 ${ampm}`;
        
        hourly.push({
            time: timeLabel,
            temp: tempVal,
            rain: parseFloat(rainPoints[23 - i].toFixed(1))
        });
    }
    return hourly;
}

// Diccionario de alturas sobre el nivel del mar para estaciones locales conocidas (msnm)
const ELEVATION_LOOKUP = {
    "sardinal": 43,
    "ochomogo": 1546,
    "laceiba": 125,
    "bijagua": 480,
    "chirripo": 3820,
    "iztaru": 1830,
    "cartago": 1430,
    "stacruz": 50,
    "pozoazul": 190,
    "garza": 12,
    "belen": 935,
    "coopevega": 110,
    "catie": 602,
    "earth": 64,
    "ciudadninos": 1390,
    "llanogrande": 2240,
    "fraijanes": 1650,
    "pacayas": 1735,
    "upala": 56,
    "altamira": 1150,
    "arunachala": 810,
    "balsa": 980,
    "barrancas": 1420,
    "betania": 145,
    "burio": 1750,
    "cantagallo": 45,
   "cedral": 1820,
    "cigefi": 1205,
    "cipanci": 15,
    "judicial": 980,
    "coto49": 35,
    "damas": 40,
    "elcarmen": 95,
    "fortuna": 120,
    "frutadepan": 38,
    "gavilancanta": 210,
    "giro": 1010,
    "guapiles": 262,
    "guatuso": 140,
    "guayabo": 610,
    "herradura": 5,
    "horquetas": 85,
    "huacalito": 145,
    "invenio": 160,
    "jaboncillal": 1410,
    "jimenez": 10,
    "juanvinas": 1180,
    "juco": 1590,
    "lacruz": 255,
    "laurel": 20,
    "loslotes": 1250,
    "macaya": 1395,
    "mangarica": 105,
    "manzanillo": 4,
    "maritza": 650,
    "mawamba": 2,
    "mojica": 65,
    "montecarlo": 760,
    "neotropica": 15,
    "nicoya": 120,
    "oroceiba": 220,
    "paquera": 10,
    "pilangosta": 350,
    "pindeco": 360,
    "pinilla": 15,
    "puntarenas": 3,
    "rainforest": 480,
    "rioclaro": 75,
    "sanjorge": 70,
    "sanmateo": 250,
    "sepecue": 90,
    "sitiomata": 820,
    "sixaola": 15,
    "tablazo": 1650,
    "taboga": 40,
    "tenorio": 780,
    "tirimbina": 180,
    "upaz": 820
};

// Mostrar los datos detallados de una estación en el Sidebar
function showStationDetails(station) {
    
    // Auto-pausar el audio del pronóstico nacional si está reproduciéndose
    const audioEl = document.getElementById('forecast-native-audio');
    if (audioEl && !audioEl.paused) {
        audioEl.pause();
    }
    
    // Ocultar resumen por defecto y mostrar detalle
    document.getElementById('sidebar-default').classList.add('hidden');
    const detailPanel = document.getElementById('sidebar-detail');
    detailPanel.classList.remove('hidden');

    // Móvil: abrir DIRECTO en FULL para que la gráfica horaria quede en el 1er fold
    if (window.innerWidth <= 768) {
        setMobileSheetState('full');
        const bt = document.getElementById('btn-tab-temp');
        const br = document.getElementById('btn-tab-rain');
        if (bt && br) {
            detailPanel.dataset.chartTab = 'temp';
            bt.classList.add('active');
            br.classList.remove('active');
        }
    }

    // 1. Cargar Metadatos de la Estación
    document.getElementById('station-badge').innerText = station.source;
    document.getElementById('station-source').innerText = station.source.includes("Campbell") ? "Red Campbell Scientific" : "Red Mundial WMO";
    document.getElementById('det-station-name').innerText = station.name;
    document.getElementById('det-lat').innerText = station.coordinates[1].toFixed(4);
    document.getElementById('det-lon').innerText = station.coordinates[0].toFixed(4);
    
    // Altitud
    const alt = station.elevation || ELEVATION_LOOKUP[station.id?.toLowerCase()] || '--';
    document.getElementById('det-alt').innerText = alt;

    // 2. Cargar Temperatura
    const temp = station.air_temperature;
    document.getElementById('det-temp').innerText = (temp !== undefined && temp !== null) ? temp.toFixed(1) : '--';

    // Extremas de temperatura del día
    const tempMax = station.temp_max;
    const tempMin = station.temp_min;
    document.getElementById('det-temp-max').innerText = (tempMax !== undefined && tempMax !== null) ? `${tempMax.toFixed(1)} °C` : '-- °C';
    document.getElementById('det-temp-min').innerText = (tempMin !== undefined && tempMin !== null) ? `${tempMin.toFixed(1)} °C` : '-- °C';

    // 3. Cargar Humedad Relativa y Punto Rocío
    const rh = station.relative_humidity;
    document.getElementById('det-humidity').innerText = (rh !== undefined && rh !== null) ? rh.toFixed(0) : '--';
    
    const humBar = document.getElementById('det-humidity-bar');
    if (rh !== undefined && rh !== null) {
        humBar.style.width = `${Math.min(100, Math.max(0, rh))}%`;
    } else {
        humBar.style.width = '0%';
    }

    // Calcular o mostrar Punto Rocío
    let dew = station.dewpoint_temperature;
    if ((dew === undefined || dew === null) && temp !== undefined && temp !== null && rh !== undefined && rh !== null) {
        dew = calculateDewPoint(temp, rh);
    }
    document.getElementById('det-dew').innerText = (dew !== undefined && dew !== null) ? dew.toFixed(1) : '--';

    // 4. Cargar Viento (Conversión a km/h si es necesario)
    let ws = station.wind_speed;
    let gust = station.maximum_wind_gust_speed;
    
    // Convertir de m/s a km/h para consistencia si es wis2box
    if (station.source.includes("wis2box")) {
        if (ws !== undefined && ws !== null) ws *= 3.6;
        if (gust !== undefined && gust !== null) gust *= 3.6;
    }

    document.getElementById('det-wind-speed').innerText = (ws !== undefined && ws !== null) ? `${ws.toFixed(1)} km/h` : 'Calma';
    
    const gustContainer = document.getElementById('det-wind-gust-container');
    if (gust !== undefined && gust !== null && gust > 0) {
        gustContainer.style.display = 'flex';
        document.getElementById('det-wind-gust').innerText = `${gust.toFixed(1)} km/h`;
    } else {
        gustContainer.style.display = 'none';
    }

    // Brújula Giratoria
    const windDir = station.wind_direction;
    const needle = document.getElementById('det-compass-needle');
    if (windDir !== undefined && windDir !== null) {
        needle.style.transform = `translate(-50%, -50%) rotate(${windDir}deg)`;
        document.getElementById('det-wind-dir-deg').innerText = `${windDir.toFixed(0)}°`;
    } else {
        needle.style.transform = 'translate(-50%, -50%) rotate(0deg)';
        document.getElementById('det-wind-dir-deg').innerText = '--';
    }

    // 5. Cargar Precipitación / Lluvia
    const rainAccumToday = station.total_precipitation_or_total_water_equivalent;
    document.getElementById('det-rain-today').innerText = (rainAccumToday !== undefined && rainAccumToday !== null) ? `${rainAccumToday.toFixed(1)} mm` : '0.0 mm';

    const rainYesterday = station.rain_yesterday;
    const rainYesterdayContainer = document.getElementById('det-rain-yesterday-container');
    if (rainYesterday !== undefined && rainYesterday !== null) {
        rainYesterdayContainer.style.display = 'flex';
        document.getElementById('det-rain-yesterday').innerText = `${rainYesterday.toFixed(1)} mm`;
    } else {
        rainYesterdayContainer.style.display = 'none';
    }

    // 6. Cargar Diagnóstico (Presión)
    const press = station.non_coordinate_pressure;
    const pressContainer = document.getElementById('det-pressure-container');
    if (press !== undefined && press !== null) {
        pressContainer.style.display = 'block';
        document.getElementById('det-pressure').innerText = `${press.toFixed(1)} hPa`;
    } else {
        pressContainer.style.display = 'none';
    }

    // 7. Cargar Hora de Actualización
    if (station.last_update) {
        if (station.last_update.includes('T')) {
            const dateObj = new Date(station.last_update);
            document.getElementById('det-update-time').innerText = dateObj.toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        } else {
            document.getElementById('det-update-time').innerText = station.last_update;
        }
    } else {
        document.getElementById('det-update-time').innerText = 'Reciente';
    }

    // 8. Integración de Gráficos Horarios Interactivos (Chart.js)
    
    // Obtener historial real o generar simulación diurna de alta definición
    let hourlyHistory = station.hourly;
    if (!hourlyHistory || hourlyHistory.length === 0) {
        if (temp !== undefined && temp !== null) {
            hourlyHistory = generateMockHourlyData(temp, tempMin, tempMax, rainAccumToday || 0);
        } else {
            hourlyHistory = [];
        }
    }

    // Lluvia última hora (extraída del último registro del historial)
    let rainLastHour = 0.0;
    if (hourlyHistory.length > 0) {
        rainLastHour = hourlyHistory[hourlyHistory.length - 1].rain || 0.0;
    }
    document.getElementById('det-rain-last-hour').innerText = `${rainLastHour.toFixed(1)} mm`;

    // Destruir gráficos previos para evitar solapamiento
    if (tempChart) {
        tempChart.destroy();
        tempChart = null;
    }
    if (rainChart) {
        rainChart.destroy();
        rainChart = null;
    }

    if (hourlyHistory.length > 0) {
        const labels = hourlyHistory.map(h => h.time.replace(':00', ''));
        const tempValues = hourlyHistory.map(h => h.temp);
        const rainValues = hourlyHistory.map(h => h.rain);

        function createChart(canvasId, type, dataset, tooltipLabel) {
            const ctx = document.getElementById(canvasId).getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 100);
            grad.addColorStop(0, dataset.bgGradientStop0);
            grad.addColorStop(1, dataset.bgGradientStop1);
            return new Chart(ctx, {
                type,
                data: { labels, datasets: [{ ...dataset, backgroundColor: grad }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            backgroundColor: 'rgba(10, 15, 29, 0.95)',
                            titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 10 },
                            bodyFont: { family: "'JetBrains Mono', monospace", size: 10 },
                            borderColor: 'rgba(255, 255, 255, 0.08)',
                            borderWidth: 1,
                            displayColors: false,
                            callbacks: { label: c => `${tooltipLabel}: ${c.parsed.y.toFixed(1)}` }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: { color: '#64748b', font: { family: "'Plus Jakarta Sans', sans-serif", size: 9, weight: '500' }, maxTicksLimit: 6 }
                        },
                        y: {
                            grid: { color: 'rgba(255, 255, 255, 0.05)' },
                            ticks: { color: '#64748b', font: { family: "'JetBrains Mono', monospace", size: 9 }, maxTicksLimit: 4 }
                        }
                    }
                }
            });
        }

        tempChart = createChart('temp-hourly-chart', 'line', {
            label: 'Temperatura (°C)',
            data: tempValues,
            borderColor: '#38bdf8',
            borderWidth: 2,
            bgGradientStop0: 'rgba(56, 189, 248, 0.30)',
            bgGradientStop1: 'rgba(56, 189, 248, 0.00)',
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: '#38bdf8'
        }, 'Temp');

        rainChart = createChart('rain-hourly-chart', 'bar', {
            label: 'Lluvia (mm)',
            data: rainValues,
            borderColor: '#3b82f6',
            borderWidth: 1,
            bgGradientStop0: 'rgba(59, 130, 246, 0.65)',
            bgGradientStop1: 'rgba(59, 130, 246, 0.15)',
            borderRadius: 4,
            barPercentage: 0.65
        }, 'Lluvia');
    }

    // Centrar la estación desplazada hacia la izquierda para que no quede oculta bajo la sidebar
    const targetZoom = Math.max(map.getZoom(), 10);
    const pxOffset = window.innerWidth > 768 ? 200 : 0;
    const targetPoint = map.project([station.coordinates[1], station.coordinates[0]], targetZoom).add([pxOffset, 0]);
    const targetLatLng = map.unproject(targetPoint, targetZoom);
    map.flyTo(targetLatLng, targetZoom, { animate: true, duration: 0.75 });
}

// Cerrar sidebar detalle y volver al resumen
function closeDetailSidebar() {
    // Limpiar gráficos para ahorrar memoria
    if (tempChart) {
        tempChart.destroy();
        tempChart = null;
    }
    if (rainChart) {
        rainChart.destroy();
        rainChart = null;
    }

    // Quitar el sonar de radar de cualquier pin seleccionado
    markerLayerGroup.getLayers().forEach(m => {
        const el = m.getElement();
        if (el) {
            const cm = el.querySelector('.custom-marker');
            if (cm) cm.classList.remove('is-selected');
        }
    });

    document.getElementById('sidebar-detail').classList.add('hidden');
    document.getElementById('sidebar-default').classList.remove('hidden');

    // Móvil: regresar al estado HERO (PEEK) para recuperar el mapa
    if (window.innerWidth <= 768) {
        setMobileSheetState('peek');
    }
}

// Inicializar el reproductor de audio personalizado para el pronóstico nacional
function initForecastAudioPlayer() {
    const audioEl = document.getElementById('forecast-native-audio');
    const playBtn = document.getElementById('forecast-play-btn');
    const playSvg = document.getElementById('audio-svg-play');
    const pauseSvg = document.getElementById('audio-svg-pause');
    const timeline = document.getElementById('audio-progress-slider');
    const timeCurr = document.getElementById('audio-time-curr');
    const timeTot = document.getElementById('audio-time-tot');
    const volumeBtn = document.getElementById('forecast-volume-btn');
    const volumeHighSvg = document.getElementById('volume-svg-high');
    const volumeMuteSvg = document.getElementById('volume-svg-mute');
    const volumeSlider = document.getElementById('audio-volume-slider');
    const waveBars = document.getElementById('audio-wave-bars');
    
    if (!audioEl || !playBtn) return;
    
    let isMuted = false;
    let preMuteVolume = 0.8;
    
    // Play/Pause button click
    playBtn.addEventListener('click', () => {
        if (!audioEl.src) return;
        if (audioEl.paused) {
            audioEl.play().catch(err => console.error("Error al reproducir audio:", err));
        } else {
            audioEl.pause();
        }
    });
    
    // Audio events
    audioEl.addEventListener('play', () => {
        playSvg.classList.add('hidden');
        pauseSvg.classList.remove('hidden');
        waveBars.classList.add('playing');
    });
    
    audioEl.addEventListener('pause', () => {
        playSvg.classList.remove('hidden');
        pauseSvg.classList.add('hidden');
        waveBars.classList.remove('playing');
    });
    
    audioEl.addEventListener('ended', () => {
        playSvg.classList.remove('hidden');
        pauseSvg.classList.add('hidden');
        waveBars.classList.remove('playing');
        timeline.value = 0;
        timeCurr.innerText = "0:00";
    });
    
    audioEl.addEventListener('timeupdate', () => {
        if (!audioEl.duration) return;
        const pct = (audioEl.currentTime / audioEl.duration) * 100;
        timeline.value = pct;
        timeCurr.innerText = `${Math.floor(audioEl.currentTime / 60)}:${String(Math.floor(audioEl.currentTime % 60)).padStart(2, '0')}`;
    });
    
    audioEl.addEventListener('loadedmetadata', () => {
        timeTot.innerText = `${Math.floor(audioEl.duration / 60)}:${String(Math.floor(audioEl.duration % 60)).padStart(2, '0')}`;
    });
    
    // Manual timeline seek
    timeline.addEventListener('input', () => {
        if (!audioEl.duration) return;
        const targetTime = (timeline.value / 100) * audioEl.duration;
        audioEl.currentTime = targetTime;
        timeCurr.innerText = `${Math.floor(targetTime / 60)}:${String(Math.floor(targetTime % 60)).padStart(2, '0')}`;
    });
    
    // Volume button click (Mute toggle)
    volumeBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        audioEl.muted = isMuted;
        
        if (isMuted) {
            volumeHighSvg.classList.add('hidden');
            volumeMuteSvg.classList.remove('hidden');
            volumeSlider.value = 0;
        } else {
            volumeHighSvg.classList.remove('hidden');
            volumeMuteSvg.classList.add('hidden');
            volumeSlider.value = preMuteVolume * 100;
        }
    });
    
    // Volume slider input
    volumeSlider.addEventListener('input', () => {
        const val = volumeSlider.value / 100;
        audioEl.volume = val;
        preMuteVolume = val;
        
        if (val === 0) {
            isMuted = true;
            audioEl.muted = true;
            volumeHighSvg.classList.add('hidden');
            volumeMuteSvg.classList.remove('hidden');
        } else {
            isMuted = false;
            audioEl.muted = false;
            volumeHighSvg.classList.remove('hidden');
            volumeMuteSvg.classList.add('hidden');
        }
    });
    
    // Set initial volume
    audioEl.volume = 0.8;
}
