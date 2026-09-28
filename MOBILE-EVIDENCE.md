# ClimaCR — RETOQUE MOBILE (390x844, viewport móvil)

## Contexto
App de mapa meteorológico de Costa Rica (Leaflet + Chart.js + vanilla JS/CSS).
Tema "Observatorio Mesoamericano": dark, glassmorphism, Plus Jakarta Sans / Inter / JetBrains Mono.
Desktop (>=769px) está bien. SOLO se rediseña el breakpoint móvil.

Archivos (leo todo antes de proponer):
- frontend/index.html (330 líneas)
- frontend/index-v2.css (1324 líneas) — UN solo media query en línea 1273 (@media max-width:768px)
- frontend/app-v2.js (705+ líneas)

## Midecciones REALES del vivo (viewport 390x844, dsf=2, isMobile) — no las inventes, úsalas
- #map: top 0, bottom 844, h 844, w 390 (a pantalla completa, por detrás)
- .app-header (absolute): top 12, bottom 85, h 73, w 366  -> header flota ARRIBA del mapa
- .leaflet-top.leaflet-left (zoom): top 0, bottom 142, h 142, w 52  -> controles del mapa a la IZQ, empiezan en top 0 (DETRÁS/BAJO del header? header top=12) -> posiblemente chocan
- .sidebar (absolute, bottom sheet): top 380, bottom 844, h 464, w 390, overflow auto
  -> la hoja ocupa el 45% inferior (380->844). El 55% superior (0->380) es mapa visible.
- .sidebar-default (contenido de la hoja, static, overflow visible): top 419, bottom 1338, h 919, w 352
  -> el contenido mide 919px pero el área de scroll visible es ~464px => hay que scrollear ~2x para ver todo.
- .national-forecast-card: top 523, bottom 815, h 292  (tarjeta del pronóstico IMN, grande, con reproductor de audio)
- .summary-cards (3 cards max/min/wind): top 840, bottom 1148, h 308  (empieza DESPUÉS del fold: top 840 ~ fuera de pantalla inicial, hay que scrollear)
  - .summary-card (cada uno): h 92, w 352  -> apiladas a ancho completo, 3 de 92px
- .data-source-info: top 1178, bottom 1338, h 160 (pie con texto largo)
- Vista DETALLE (al clickear estación, .sidebar-detail): top 419, bottom 1835, h 1417 (mucho más alto que default)
  - .station-meta-card-premium: top 419, bottom 587, h 168
  - .btn-close: top 397, bottom 428 (asoma ARRIBA del borde de la hoja: top 397 < sheet top ~380? está pegado arriba)
  - charts (2 canvas Chart.js): h 145, w 292 c/u  -> gráficas anchas y bajas

## CSS móvil ACTUAL (líneas 1273-1324, íntegro)
@media (max-width: 768px) {
  .app-header { left:12px; right:12px; top:12px; padding:8px 14px; width:calc(100% - 24px); justify-content:space-between; gap:14px; }
  .header-stats { display:flex; gap:14px; padding-left:14px; }
  .bubble-label { font-size:0.55rem; }
  .bubble-val { font-size:0.95rem; }
  .sidebar { left:0; right:0; bottom:0; width:100%; top:auto; height:55vh; max-height:80vh; border-radius:20px 20px 0 0; padding:20px 18px; }
  .sidebar-drag-handle { display:block; }
  .btn-close { top:16px; right:16px; z-index:10; }
  .leaflet-control-zoom { margin-top:80px !important; }
}

## Problemas perceptibles (ver screenshots /tmp/m1.png /tmp/m2.png /tmp/m3.png)
- El mapa arriba (55%) y la hoja abajo (45%) es una división fija; la hoja a 55vh con contenido de 919px obliga a scroll interno constante.
- Los summary-cards (max/min/wind) quedan bajo el fold: el usuario no los ve sin scrollear, pero son el resumen principal.
- La tarjeta del pronóstico IMN (292px, con reproductor de audio) consume casi todo el fold visible.
- .btn-close asoma medio fuera del borde superior de la hoja en la vista detalle.
- Los controles de zoom de Leaflet (izq, top 0) pueden quedar bajo el header flotante.
- Vista detalle de 1417px: mucho scroll para 2 gráficas + métricas.

## TAREA
Propón UN rediseño móvil coherente con el concepto "Observatorio Mesoamericano" que:
1. Redistribuya la jerarquía: qué se ve al abrir (fold) vs qué se scrollea. Prioriza el resumen (max/min/wind) + pronóstico, no esconderlos bajo el fold.
2. Defina el patrón de bottom sheet: ¿altura fija, expandible/draggable (peephole -> half -> full), o reorganización a tab/grid? Da el patrón exacto.
3. Resuelva la oclusión header/controles de Leaflet.
4. Mejore la vista detalle (1417px) para que gráficas y métricas se lean sin scroll infinito.
5. Mantenga: dark, glassmorphism, mismas fuentes, mismo concepto. No cambies desktop (>=769px).

## ENTREGABLE
Escribe el reporte completo en /tmp/climacr-mobile.md con secciones:
- DIAGNÓSTICO (con las métricas de arriba, qué se ve mal y por qué)
- CONCEPTO MOBILE (patrón de sheet, jerarquía de fold, alturas exactas en px/%)
- PLAN DE IMPLEMENTACIÓN (cambios EXACTOS: qué clases de index-v2.css cambian y a qué valor [px, %, hex, z-index], qué cambia en index.html [estructura/ids], qué en app-v2.js si es necesario [p.ej. handler de drag, resize de Chart.js al cambiar altura de sheet]. Nombres de clases reales que existen en el código.)
- NO escribas todo el código; da reglas y valores exactos.

Al terminar imprime SOLO: REPORT-OK + 3 líneas de resumen.
