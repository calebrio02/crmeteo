import os
import json
import logging
import asyncio
import urllib.request
import concurrent.futures
from html.parser import HTMLParser
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Configurar logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("weather-backend")

app = FastAPI(title="Costa Rica Weather API", version="1.0")

# Permitir CORS (para pruebas o desarrollo directo, aunque Nginx controlará el acceso principal)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CACHE_DIR = "/app/data"
CACHE_FILE = os.path.join(CACHE_DIR, "weather_cache.json")

# Asegurar que el directorio de caché existe
os.makedirs(CACHE_DIR, exist_ok=True)

# -------------------------------------------------------------
# Parser HTML para el scraper de Sardinal de Carrillo (Campbell RTMC)
# -------------------------------------------------------------
class SardinalHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.current_table = None
        self.current_row = None
        self.in_table = False
        self.in_row = False
        self.in_cell = False
        self.headers_h1 = []
        self.in_h1 = False
        self.temp_data = ""
        self.current_h1_name = None

    def handle_starttag(self, tag, attrs):
        if tag == 'h1':
            self.in_h1 = True
            self.temp_data = ""
            self.current_h1_name = None
        elif tag == 'a' and self.in_h1:
            attrs_dict = dict(attrs)
            if 'name' in attrs_dict:
                self.current_h1_name = urllib.parse.unquote(attrs_dict['name'])
        elif tag == 'table':
            self.in_table = True
            self.current_table = []
        elif tag == 'tr' and self.in_table:
            self.in_row = True
            self.current_row = []
        elif tag in ['th', 'td'] and self.in_row:
            self.in_cell = True
            self.temp_data = ""

    def handle_data(self, data):
        if self.in_h1 or self.in_cell:
            self.temp_data += data

    def handle_endtag(self, tag):
        if tag == 'h1':
            self.in_h1 = False
            header_name = self.current_h1_name or self.temp_data.strip().replace('\xa0', ' ')
            if header_name:
                header_name = header_name.strip()
            else:
                header_name = f"Table_Header_{len(self.headers_h1)}"
            self.headers_h1.append(header_name)
        elif tag == 'table':
            self.in_table = False
            if self.current_table:
                self.tables.append(self.current_table)
            self.current_table = None
        elif tag == 'tr' and self.in_table:
            self.in_row = False
            if self.current_row:
                self.current_table.append(self.current_row)
            self.current_row = None
        elif tag in ['th', 'td'] and self.in_row:
            self.in_cell = False
            self.current_row.append(self.temp_data.strip().replace('\xa0', ' '))
            self.temp_data = ""

def _parse_fecha(fecha_str: str) -> str:
    """Devuelve la fecha más reciente entre varias cadenas de fecha del IMN.
    
    Formatos esperados:
    - "23/05/2026 09:12:15 p. m." (Tabla Actuales)
    - "23/05/2026 09:00 p. m." (Tabla Horarios)
    - "23/05/2026" (Tabla Promedio 2 min)
    """
    import re
    import datetime
    
    fechas = [f for f in fecha_str if f]
    if not fechas:
        return ""
    
    def parse(fecha):
        fecha = fecha.strip()
        # "23/05/2026 09:12:15 p. m."
        m = re.match(r'(\d{2}/\d{2}/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(am|p\.?\s*m\.?|a\.?\s*p\.)?', fecha, re.IGNORECASE)
        if m:
            date_part, time_part, period = m.groups()
            dt = datetime.datetime.strptime(date_part, "%d/%m/%Y")
            if time_part:
                fmt = "%H:%M:%S" if ":" == time_part[2] and len(time_part) > 5 else "%H:%M"
                h = int(time_part.split(":")[0])
                if period and "p" in period.lower():
                    h = (h % 12) + 12
                dt = dt.replace(hour=h, minute=int(time_part.split(":")[1]))
            return dt
        # "23/05/2026"
        m = re.match(r'(\d{2}/\d{2}/\d{4})', fecha)
        if m:
            return datetime.datetime.strptime(m.group(1), "%d/%m/%Y")
        return None
    
    parsed = [p for p in (parse(f) for f in fechas) if p]
    if parsed:
        return sorted(parsed, reverse=True)[0].strftime("%d/%m/%Y %H:%M:%S")
    return ""


# -------------------------------------------------------------
# Funciones Auxiliares de Fetch y Parseo
# -------------------------------------------------------------
def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode('utf-8'))

def scrape_national_forecast() -> dict:
    import urllib.request
    import re
    import urllib.parse
    
    url = "https://www.imn.ac.cr/web/imn/inicio"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
    try:
        logger.info("Raspando el pronóstico nacional del IMN...")
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8', errors='ignore')
            
        date_match = re.search(r'<p[^>]*class="[^"]*text-primary-medium[^"]*"[^>]*>(.*?)</p>', html, re.DOTALL)
        text_match = re.search(r'<p[^>]*class="[^"]*text-gray f-18[^"]*"[^>]*>(.*?)</p>', html, re.DOTALL)
        
        if not text_match:
            text_match = re.search(r'<p[^>]*class="[^"]*text-end text-gray[^"]*"[^>]*>(.*?)</p>', html, re.DOTALL)
            
        audio_match = re.search(r'path:\s*["\']([^"\']+)["\']', html)
        
        date_str = date_match.group(1).strip() if date_match else None
        text_str = text_match.group(1).strip() if text_match else None
        audio_path = audio_match.group(1).strip() if audio_match else None
        
        if date_str:
            date_str = re.sub(r'<[^<]+?>', '', date_str).strip()
        if text_str:
            text_str = re.sub(r'<[^<]+?>', '', text_str).strip()
            
        audio_url = f"https://www.imn.ac.cr{audio_path}" if audio_path else None
        
        return {
            "date": date_str or "Pronóstico del Día",
            "text": text_str or "Información del pronóstico no disponible de forma textual.",
            "audio_url": audio_url
        }
    except Exception as e:
        logger.error(f"Error raspando el pronóstico nacional: {e}")
        return {
            "date": "Pronóstico del Día",
            "text": "No se pudo recuperar el pronóstico en este momento debido a un problema con el sitio web del IMN.",
            "audio_url": None
        }

HTML_STATIONS = [
    ("sardinal", "Estación Sardinal de Carrillo (Guanacaste)", [-85.6117, 10.5310]),
    ("alfredovolio", "Estación Alfredo Volio Mata (Cartago)", [-83.9000, 9.9000]),
    ("altamira", "Estación Altamira (Buenos Aires)", [-83.0500, 9.0300]),
    ("aranjuez", "Estación Aranjuez, Pitahaya (Puntarenas)", [-84.8167, 9.9833]),
    ("arunachala", "Estación Arunachala (Pérez Zeledón)", [-83.7000, 9.3667]),
    ("balsa", "Estación Balsa (San Ramón)", [-84.4500, 10.0833]),
    ("barrancas", "Estación Barrancas (El Guarco)", [-83.9167, 9.8000]),
    ("belen", "Estación Belén (Heredia)", [-84.1833, 9.9833]),
    ("betania", "Estación Betania, Cutris (San Carlos)", [-84.4000, 10.5000]),
    ("bijagua", "Estación Coopeguanacaste, Bijagua (Upala)", [-85.0500, 10.7333]),
    ("burio", "Estación Cerro Burío (Aserrí)", [-84.0833, 9.8333]),
    ("cantagallo", "Estación Cantagallo (Pococí)", [-83.7833, 10.2667]),
    ("catie", "Estación CATIE (Turrialba)", [-83.6500, 9.8833]),
    ("cartagotec", "Estación TEC Campus Cartago", [-83.9120, 9.8540]),
    ("cedral", "Estación Cerro Cedral (Escazú)", [-84.1333, 9.8667]),
    ("chirripo", "Estación Cerro Chirripó (Pérez Zeledón)", [-83.5000, 9.4833]),
    ("chitaria", "Estación Cerro Chitaria (Santa Ana)", [-84.1833, 9.9333]),
    ("cigefi", "Estación CIGEFI (Montes de Oca)", [-84.0500, 9.9333]),
    ("cipanci", "Estación Refugio Cipanci (Cañas)", [-85.1167, 10.1833]),
    ("ciudadjudicial", "Estación Ciudad Judicial (Flores)", [-84.1500, 10.0000]),
    ("ciudadninos", "Estación Ciudad de los Niños (Cartago)", [-83.9167, 9.8667]),
    ("coopevega", "Estación Coopevega (San Carlos)", [-84.3500, 10.6000]),
    ("copalchi", "Estación Copalchí (Peñas Blancas)", [-84.6000, 10.4000]),
    ("coto49", "Estación Coto 49 (Corredores)", [-82.9686, 8.6312]),
    ("damas", "Estación Finca Damas (Quepos)", [-84.1667, 9.4333]),
    ("earth", "Estación EARTH (Guácimo)", [-83.6000, 10.2167]),
    ("elcarmen", "Estación Finca El Carmen (Siquirres)", [-83.5167, 10.1000]),
    ("fortuna", "Estación ADIFORT, La Fortuna (San Carlos)", [-84.6470, 10.4717]),
    ("fraijanes", "Estación Laguna Fraijanes (Alajuela)", [-84.1833, 10.1333]),
    ("frutadepan", "Estación Fruta de Pan (Pococí)", [-83.7833, 10.2667]),
    ("garza", "Estación Barco Quebrado - Garza (Nosara)", [-85.6500, 9.9000]),
    ("gavilancanta", "Estación Gavilán Canta, Bratsi (Talamanca)", [-82.9500, 9.6500]),
    ("giro", "Estación Cafetalera El Giro (San Vito)", [-82.9667, 8.7833]),
    ("guapiles", "Estación Pococí Guápiles (Limón)", [-83.7833, 10.2167]),
    ("guatuso", "Estación ASADA San Rafael de Guatuso", [-84.8167, 10.7167]),
    ("guayabo", "Estación ASADA Guayabo (Bagaces)", [-85.2500, 10.6667]),
    ("herradura", "Estación Muelle Herradura (Garabito)", [-84.6333, 9.6500]),
    ("horquetas", "Estación Horquetas (Sarapiquí)", [-84.0500, 10.3500]),
    ("huacalito", "Estación Cerro Huacalito (Carrillo)", [-85.6117, 10.5186]),
    ("invenio", "Estación Universidad INVENIO (Cañas)", [-85.1167, 10.3833]),
    ("iztaru", "Estación Iztarú (La Unión)", [-83.9833, 9.9000]),
    ("jaboncillal", "Estación Jaboncillal (Goicoechea)", [-84.0167, 9.9667]),
    ("jimenez", "Estación Finca El Patio (Puerto Jiménez)", [-83.3000, 8.5333]),
    ("juanvinas", "Estación Maravilla (Juan Viñas)", [-83.7167, 9.8833]),
    ("juco", "Estación Cerro Jucó (Paraíso)", [-83.7833, 9.8333]),
    ("laceiba", "Estación Finca La Ceiba (Nicoya)", [-85.3175, 10.1111]),
    ("lacruz", "Estación La Cruz (Guanacaste)", [-85.6833, 11.0667]),
    ("laligia", "Estación La Ligia (Parrita)", [-84.3333, 9.5167]),
    ("lalucha", "Estación La Lucha (León Cortés)", [-84.0000, 9.7167]),
    ("lapastora", "Estación Escuela La Pastora (Turrialba)", [-83.7333, 10.0167]),
    ("larebusca", "Estación La Rebusca (Sarapiquí)", [-84.0000, 10.3000]),
    ("lasdelicias", "Estación Las Delicias (San Carlos)", [-84.4500, 10.5500]),
    ("laurel", "Estación Laurel (Corredores)", [-82.9167, 8.4333]),
    ("llanogrande", "Estación Llano Grande (Cartago)", [-83.8833, 9.9167]),
    ("loschiles", "Estación Los Chiles (Alajuela)", [-84.7117, 11.0317]),
    ("loslotes", "Estación Finca Los Lotes (La Unión)", [-83.9833, 9.9167]),
    ("macaya", "Estación Finca Los Macaya (Goicoechea)", [-84.0333, 9.9500]),
    ("mangarica", "Estación Mangarica (Liberia)", [-85.4500, 10.6000]),
    ("manzanillo", "Estación Manzanillo (Talamanca)", [-82.6500, 9.6333]),
    ("maritza", "Estación Maritza, Volcán Orosi (La Cruz)", [-85.5000, 10.9500]),
    ("mawamba", "Estación Hotel Mawamba Tortuguero", [-83.5167, 10.5333]),
    ("mojica", "Estación Hacienda Mojica (Bagaces)", [-85.2833, 10.4167]),
    ("montecarlo", "Estación Montecarlo (Pérez Zeledón)", [-83.7500, 9.3833]),
    ("neotropica", "Estación Fundación Neotrópica (Osa)", [-83.5167, 8.7000]),
    ("nicoya", "Estación Nicoya (Guanacaste)", [-85.4500, 10.1500]),
    ("ochomogo", "Estación RECOPE Ochomogo (Cartago)", [-83.9333, 9.9000]),
    ("oroceiba", "Estación Oroceiba (Orotina)", [-84.5167, 9.9167]),
    ("pacayas", "Estación Pacayas (Alvarado)", [-83.8000, 9.9000]),
    ("paquera", "Estación Paquera (Puntarenas)", [-84.9333, 9.8167]),
    ("pilangosta", "Estación ASADA Pilangosta (Hojancha)", [-85.4167, 9.9833]),
    ("pindeco", "Estación PINDECO (Buenos Aires)", [-83.3333, 9.1667]),
    ("pinilla", "Estación San José, Pinilla (Santa Cruz)", [-85.8333, 10.2667]),
    ("pozoazul", "Estación Hotel Pozo Azul (Sarapiquí)", [-84.0167, 10.4167]),
    ("puntarenas", "Estación Puntarenas (Puntarenas)", [-84.8384, 9.9764]),
    ("rainforest", "Estación Rain Forest, Braulio Carrillo", [-83.9500, 10.1833]),
    ("rioclaro", "Estación Río Claro (Golfito)", [-83.0500, 8.6833]),
    ("sangerardo", "Estación San Gerardo (Sarapiquí)", [-83.8000, 10.3500]),
    ("sanjorge", "Estación Saint George (San Jorge)", [-84.7167, 10.9833]),
    ("sanmateo", "Estación San Mateo (Alajuela)", [-84.5500, 9.9500]),
    ("stacruz", "Estación UCR Santa Cruz (Guanacaste)", [-85.5861, 10.2628]),
    ("santarosa", "Estación Santa Rosa (La Cruz)", [-85.6167, 10.8333]),
    ("sepecue", "Estación Sepecue, Telire (Talamanca)", [-82.9833, 9.5167]),
    ("sitiomata", "Estación Sitio Mata (Turrialba)", [-83.6833, 9.8333]),
    ("sixaola", "Estación Sixaola (Limón)", [-82.6338, 9.5277]),
    ("tablazo", "Estación Altos Tablazo, Higuito", [-84.0500, 9.8333]),
    ("taboga", "Estación Hacienda Taboga (Cañas)", [-85.1500, 10.3500]),
    ("tenorio", "Estación Volcán Tenorio (Guatuso)", [-85.0167, 10.6667]),
    ("tirimbina", "Estación El Bosque, Rio Tirimbina", [-84.1167, 10.4167]),
    ("turrialba", "Estación Turrialba Centro (Cartago)", [-83.6833, 9.9000]),
    ("upala", "Estación Upala (Alajuela)", [-85.0333, 10.9000]),
    ("upaz", "Estación Universidad para la Paz (Mora)", [-84.2500, 9.9167])
]

def scrape_html_station(slug: str, name: str, coords: list) -> dict:
    url = f"https://www.imn.ac.cr/especial/tablas/{slug}.html"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    with urllib.request.urlopen(req, timeout=10) as response:
        html = response.read().decode('utf-8', errors='ignore')

    parser = SardinalHTMLParser()
    parser.feed(html)
    
    parsed_tables = {}
    for i, table in enumerate(parser.tables):
        title = parser.headers_h1[i] if i < len(parser.headers_h1) else f"Table_{i}"
        if not table:
            continue
        headers = table[0]
        rows = table[1:]
        
        table_list = []
        for row in rows:
            if len(row) == len(headers):
                table_list.append(dict(zip(headers, row)))
        parsed_tables[title] = table_list
        
    station_data = {
        "id": slug,
        "name": name,
        "coordinates": coords,
        "source": "Campbell RTMC",
        "status": "operational"
    }

    # Buscar la tabla de promedios de manera flexible
    promedios = []
    for k, v in parsed_tables.items():
        if "promedio" in k.lower():
            promedios = v
            break
    if not promedios:
        promedios = parsed_tables.get("Table_2", []) or parsed_tables.get("Table_1", [])

    if promedios:
        latest_promedio = promedios[0]
        
        temp_val = latest_promedio.get("Temp") or latest_promedio.get("Temp_c") or latest_promedio.get("Temperatura")
        if temp_val:
            try: station_data["air_temperature"] = float(temp_val.replace(",", "."))
            except: pass
            
        td_val = latest_promedio.get("Td") or latest_promedio.get("Punto_rocio")
        if td_val:
            try: station_data["dewpoint_temperature"] = float(td_val.replace(",", "."))
            except: pass
            
        hr_val = latest_promedio.get("HR") or latest_promedio.get("Humedad")
        if hr_val:
            try: station_data["relative_humidity"] = float(hr_val.replace(",", "."))
            except: pass
            
        wind_val = latest_promedio.get("Velocidad") or latest_promedio.get("Viento")
        if wind_val:
            try: station_data["wind_speed"] = float(wind_val.replace(",", "."))
            except: pass
            
        dir_val = latest_promedio.get("Dirección") or latest_promedio.get("Direccion")
        if dir_val:
            try: station_data["wind_direction"] = float(dir_val.replace(",", "."))
            except: pass
            
        thermal_val = latest_promedio.get("Sens térmica") or latest_promedio.get("Sens_termica")
        if thermal_val:
            try: station_data["thermal_sensation"] = float(thermal_val.replace(",", "."))
            except: pass

    # Buscar la tabla de actuales
    actuales = []
    for k, v in parsed_tables.items():
        if "actuales" in k.lower():
            actuales = v
            break
    if not actuales:
        actuales = parsed_tables.get("Tabla de datos: Actuales", [])
        
    if actuales:
        latest_actuales = actuales[0]
        fecha_actuales = latest_actuales.get("Fecha", "")
        if not fecha_actuales:
            fecha_promedio = promedios[0].get("Fecha", "") if promedios and len(promedios[0]) > 0 else ""
            if fecha_promedio:
                fecha_actuales = fecha_promedio
        station_data["last_update"] = fecha_actuales
        
        vmax_val = latest_actuales.get("Vmax") or latest_actuales.get("Racha")
        if vmax_val:
            try: station_data["maximum_wind_gust_speed"] = float(vmax_val.replace(",", "."))
            except: pass
            
        rain_val = latest_actuales.get("SUM_lluv") or latest_actuales.get("Lluvia_hoy") or latest_actuales.get("SUM_Lluv")
        if rain_val:
            try: station_data["total_precipitation_or_total_water_equivalent"] = float(rain_val.replace(",", "."))
            except: pass
            
        rain_yesterday_val = latest_actuales.get("LLUV_ayer") or latest_actuales.get("Lluvia_ayer") or latest_actuales.get("Lluv_ayer")
        if rain_yesterday_val:
            try: station_data["rain_yesterday"] = float(rain_yesterday_val.replace(",", "."))
            except: pass

        tmax_val = latest_actuales.get("Tmax") or latest_actuales.get("Temp_max")
        if tmax_val:
            try: station_data["temp_max"] = float(tmax_val.replace(",", "."))
            except: pass
            
        tmin_val = latest_actuales.get("Tmin") or latest_actuales.get("Temp_min")
        if tmin_val:
            try: station_data["temp_min"] = float(tmin_val.replace(",", "."))
            except: pass
            
    # Si no se pudo obtener temperatura de promedios, buscar en la tabla "Horarios"
    if "air_temperature" not in station_data:
        horarios_fallback = parsed_tables.get("Tabla de datos: Horarios", []) or parsed_tables.get("Table_0", [])
        if horarios_fallback:
            latest_horario = horarios_fallback[0]
            temp_val = latest_horario.get("Temp")
            if temp_val:
                try: station_data["air_temperature"] = float(temp_val.replace(",", "."))
                except: pass
            rain_val = latest_horario.get("Lluvia")
            if rain_val and "total_precipitation_or_total_water_equivalent" not in station_data:
                try: station_data["total_precipitation_or_total_water_equivalent"] = float(rain_val.replace(",", "."))
                except: pass

    # Obtener historial de 24 horas de la tabla Horarios
    horarios_list = []
    for k, v in parsed_tables.items():
        if "horario" in k.lower():
            horarios_list = v
            break
    if not horarios_list:
        horarios_list = parsed_tables.get("Tabla de datos: Horarios", []) or parsed_tables.get("Table_0", [])

    hourly_list = []
    if horarios_list:
        for row in horarios_list[:24]:  # Últimas 24 horas
            fecha = row.get("Fecha", "")
            time_label = ""
            if fecha:
                parts = fecha.split()
                if len(parts) >= 2:
                    # Ejemplo: "23/05/2026 07:00 p. m." -> "07:00 p. m."
                    time_label = " ".join(parts[1:])
                else:
                    time_label = fecha
            
            temp_val = row.get("Temp") or row.get("Temperatura") or row.get("Temp_c")
            temp_num = None
            if temp_val:
                try: temp_num = float(temp_val.replace(",", "."))
                except: pass
                
            rain_val = row.get("Lluvia") or row.get("Lluv")
            rain_num = 0.0
            if rain_val:
                try: rain_num = float(rain_val.replace(",", "."))
                except: pass
                
            hourly_list.append({
                "time": time_label,
                "temp": temp_num,
                "rain": rain_num
            })

    station_data["hourly"] = hourly_list[::-1]  # Invertir para orden cronológico (antiguo a reciente)
    return station_data

async def fetch_all_weather_data():
    logger.info("Iniciando recolección de datos meteorológicos...")
    try:
        # 1. Obtener la lista de estaciones desde wis2box
        stations_geojson = fetch_json("http://wis2box.imn.ac.cr/oapi/collections/stations/items?f=json")
        features_stations = stations_geojson.get("features", [])
        
        # 2. Obtener las últimas observaciones (500 ítems) para tener lecturas frescas
        observations_geojson = fetch_json("http://wis2box.imn.ac.cr/oapi/collections/urn:wmo:md:cr-imn:core.surface-based-observations.synop/items?f=json&limit=500&sortby=-reportTime")
        features_obs = observations_geojson.get("features", [])
        
        # Agrupar observaciones por estación e identificar la más reciente para cada parámetro
        obs_by_station = {}
        for obs in features_obs:
            props = obs.get("properties", {})
            station_id = props.get("wigos_station_identifier")
            var_name = props.get("name")
            var_value = props.get("value")
            var_unit = props.get("units")
            report_time = props.get("reportTime") or props.get("phenomenonTime")
            
            if not station_id or not var_name or var_value is None:
                continue
                
            if station_id not in obs_by_station:
                obs_by_station[station_id] = {}
                
            # Solo guardamos si es el más reciente
            current_saved = obs_by_station[station_id].get(var_name)
            if not current_saved or report_time > current_saved["time"]:
                obs_by_station[station_id][var_name] = {
                    "value": var_value,
                    "unit": var_unit,
                    "time": report_time
                }

        # Mapeo de IDs de la red mundial WMO a identificadores/slugs locales de Campbell RTMC
        WMO_TO_CAMPBELL_MAPPING = {
            "0-188-0-72157": "laceiba",    # Finca La Ceiba
            "0-188-0-87013": "sixaola",    # Sixaola
            "0-188-0-69633": "loschiles",  # Los Chiles / Comando Los Chiles
            "0-188-0-100651": "coto49"     # Coto 49
        }

        # 3. Consolidar estaciones globales
        consolidated_features = []
        for station in features_stations:
            props = station.get("properties", {})
            geom = station.get("geometry", {})
            coords = geom.get("coordinates", [0, 0])[:2]  # Solo lon, lat
            station_id = props.get("wigos_station_identifier")
            
            station_data = {
                "id": station_id,
                "name": props.get("name", "Estación Desconocida"),
                "coordinates": coords,
                "source": "wis2box (WMO)",
                "status": props.get("status", "operational"),
                "elevation": props.get("barometer_height"),
                "last_update": None
            }
            
            # Incorporar las últimas mediciones
            station_obs = obs_by_station.get(station_id, {})
            for var_name, obs_val in station_obs.items():
                station_data[var_name] = obs_val["value"]
                if not station_data["last_update"] or obs_val["time"] > station_data["last_update"]:
                    station_data["last_update"] = obs_val["time"]
            
            consolidated_features.append(station_data)
            
        # 4. Scrapear e integrar todas las estaciones HTML locales en paralelo
        logger.info(f"Iniciando raspado de {len(HTML_STATIONS)} estaciones locales...")
        
        def scrape_safe(station):
            slug, name, coords = station
            try:
                data = scrape_html_station(slug, name, coords)
                return data
            except Exception:
                return None
                
        with concurrent.futures.ThreadPoolExecutor(max_workers=25) as executor:
            scraped_results = list(executor.map(scrape_safe, HTML_STATIONS))
            
        for s_data in scraped_results:
            if s_data:
                # Si ya existe en consolidated_features (por ejemplo, Sixaola, Los Chiles, La Ceiba),
                # actualizamos sus datos con los del raspado (que son más frecuentes y recientes).
                # Buscamos por ID directo o mapeando la equivalencia de WMO a Campbell.
                existing_station = next((
                    s for s in consolidated_features 
                    if s["id"] == s_data["id"] or WMO_TO_CAMPBELL_MAPPING.get(s["id"]) == s_data["id"]
                ), None)
                
                if existing_station:
                    existing_station.update(s_data)
                    existing_station["id"] = s_data["id"] # Normalizar el ID al de Campbell
                else:
                    consolidated_features.append(s_data)
        logger.info(f"Integración de estaciones locales completada. Total estaciones integradas: {len(consolidated_features)}")
            
        # 5. Scrapear pronóstico nacional del IMN
        forecast_data = {
            "date": "Pronóstico del Día",
            "text": "Información del pronóstico no disponible en este momento.",
            "audio_url": None
        }
        try:
            forecast_data = scrape_national_forecast()
        except Exception as fe:
            logger.error(f"Error integrando el pronóstico nacional: {fe}")

        # 6. Escribir caché
        result = {
            "status": "success",
            "count": len(consolidated_features),
            "last_cached": consolidated_features[0].get("last_update") or "Tiempo real",
            "national_forecast": forecast_data,
            "stations": consolidated_features
        }
        
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            
        logger.info(f"Recolección completada con éxito. {len(consolidated_features)} estaciones actualizadas en caché.")
        
    except Exception as e:
        logger.error(f"Error crítico en la recolección de datos: {e}")
        # Si ocurre un fallo pero ya hay un caché previo, lo mantenemos intacto

# -------------------------------------------------------------
# Tarea de fondo programada (Loop cada 1 minuto)
# -------------------------------------------------------------
async def weather_scheduler():
    logger.info("Iniciando bucle de recolección en segundo plano (cada 30 segundos)...")
    # Dormir el primer minuto porque ya hicimos la recolección inicial en startup_event
    await asyncio.sleep(60)
    while True:
        try:
            await fetch_all_weather_data()
        except Exception as e:
            logger.error(f"Error en bucle de recolección: {e}")
        await asyncio.sleep(30)  # 30 segundos

# -------------------------------------------------------------
# Eventos de FastAPI
# -------------------------------------------------------------
@app.on_event("startup")
async def startup_event():
    # Ejecutar la primera consulta inmediatamente de forma síncrona al arrancar
    logger.info("Generando caché inicial de clima durante el arranque del contenedor...")
    try:
        await fetch_all_weather_data()
    except Exception as e:
        logger.error(f"Error generando caché inicial: {e}")
    # Iniciar el bucle de consultas recurrentes en segundo plano
    asyncio.create_task(weather_scheduler())

# -------------------------------------------------------------
# Endpoints de API
# -------------------------------------------------------------
@app.get("/")
def read_root():
    return {"message": "API de Clima Interactiva de Costa Rica está en funcionamiento."}

@app.get("/weather")
def get_weather():
    if not os.path.exists(CACHE_FILE):
        # Si aún no se ha generado la caché, intentamos correr el fetch de manera síncrona/inmediata
        logger.warning("Caché no encontrada en el endpoint. Intentando recolección inmediata...")
        loop = asyncio.get_event_loop()
        loop.run_until_complete(fetch_all_weather_data())
        
        if not os.path.exists(CACHE_FILE):
            raise HTTPException(status_code=503, detail="Los datos meteorológicos se están cargando. Por favor, inténtelo de nuevo en unos segundos.")
            
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception as e:
        logger.error(f"Error leyendo el archivo de caché: {e}")
        raise HTTPException(status_code=500, detail="Error al recuperar los datos meteorológicos.")
