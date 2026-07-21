# Bejherro — Fase 1 (núcleo del reproductor)

## Cómo probarla

Para que `showDirectoryPicker` y el Service Worker funcionen, **necesitas HTTPS o localhost** (no vale abrir el `index.html` con doble clic, `file://` no funciona con estas APIs).

**Opción recomendada — GitHub Pages** (gratis, encaja con tu flujo habitual):
1. Crea un repo nuevo en tu cuenta `ManuelVS8` (o usa uno existente), ej. `bejherro`.
2. Sube estos 4 archivos a la raíz: `index.html`, `app.js`, `manifest.webmanifest`, `sw.js`, y la carpeta `icons/`.
3. Activa GitHub Pages (Settings → Pages → Deploy from branch → main / root).
4. Abre la URL resultante en Chrome Android → menú (⋮) → "Añadir a pantalla de inicio" / "Instalar app".

**Alternativa rápida para probar ya mismo:**
```
npx serve .
```
y abre la URL local que te indique (necesitarás acceder desde el móvil vía la IP local de tu ordenador, en la misma red WiFi).

## Qué incluye esta Fase 1

- Selección de carpeta local de música (recursivo, subcarpetas incluidas)
- Lectura de metadata ID3 (título, artista, álbum, género, año, carátula) con fallback al nombre de archivo
- Reproducción: play/pausa, siguiente/anterior, seek
- Repetir canción / repetir lista / sin repetir / "hasta el final y parar"
- Aleatorio (shuffle)
- Velocidad de reproducción (0.5x–2x)
- Temporizador de apagado
- Favoritos y listas de reproducción (crear, añadir, eliminar)
- Cola de reproducción visible y navegable
- Reanudación automática al reabrir (canción, segundo exacto, velocidad, volumen, cola, shuffle, repeat)
- Controles en pantalla de bloqueo (Media Session API)
- Vistas: Inicio, Biblioteca (canciones/artistas/álbumes/géneros/carpetas), Buscar, Listas, Ajustes
- Instalable como PWA, con app shell offline
- Accesos directos del icono (favoritos, reanudar, aleatorio)

## Notas técnicas

- El parser ID3 es propio (sin librerías externas) y cubre ID3v2.2/2.3/2.4. Si algún MP3 no trae carátula o etiquetas, se usa el nombre de archivo (`Artista - Título.mp3`).
- Todo se guarda en IndexedDB: pistas indexadas, playlists, favoritos, y el estado de reproducción.
- Los "handles" de carpeta se guardan para poder reescanear sin volver a pedir la carpeta cada vez (Chrome pedirá permiso de lectura de nuevo tras cerrar el navegador, es una restricción de seguridad del navegador, no de la app).

## Pendiente para próximas fases (según lo acordado)

Fase 2: navegación avanzada, selección múltiple, editor de cola drag&drop, playlists inteligentes.
Fase 3: ecualizador + presets, fade in/out, crossfade, gapless, ganancia por canción, atajos de auriculares.
Fase 4: editor de metadatos, info técnica ampliada, cola lateral, visualizador, color dinámico, vistas alternativas.
Fase 5: temporizador avanzado, despertador, marcadores, notas, estadísticas, AutoDJ.
