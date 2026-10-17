# Puente local Stremio → Chromecast clásico

Convierte mientras reproduce: H.264/AAC a 1280 píxeles de ancho y subtítulos españoles de texto como una pista WebVTT de HLS. Usa el receptor predeterminado de Chromecast. Requiere macOS, Stremio abierto, FFmpeg/ffprobe incluidos en Stremio, Python 3.14 y `pychromecast==14.0.10`. No modifica Stremio ni instala dependencias al arrancar.

1. Abrí la película en Stremio y dejá disponible el motor local en `127.0.0.1:11470`.
2. Desde este directorio ejecutá:

   ```sh
   ./start.command --source-file /Users/stefano/stremio-cast-bridge/.local/selected-source.json --device-name Stefano --device-host 192.168.0.19 --subtitle-delay-ms 500 --state-file
   ```

3. Abrí `http://127.0.0.1:18767`. Elegí la fuente y presioná **Iniciar**. No abre el navegador automáticamente. **Actualizar fuentes** consulta solamente `/stats.json`; también ofrece la fuente del JSON explícito.
4. Usá pausa, continuar, ±30 segundos o una posición absoluta. **Aplicar retraso** reinicia desde la posición actual. **Detener** finaliza el proceso propio y la reproducción seleccionada. Ctrl-C cierra el servicio.

El retraso por defecto es cero: los 500 ms del ejemplo se asignan a la primera fuente iniciada. Otras fuentes empiezan en cero; el proceso recuerda el retraso elegido por fuente mientras sigue abierto. Nunca se guarda la URL en el panel, estado ni logs. El JSON de fuente debe contener `source` y puede contener `device_id`. Abrí otra película y actualizá las fuentes para seleccionarla. No se fuerza el casting nativo para descubrir fuentes.

El script utiliza el entorno durable `.venv/bin/python`, ya preparado en esta máquina con las dependencias de `requirements.txt`. No hay servicios permanentes ni cambios globales.

Opciones: `--autostart` inicia para QA sin el botón; `--max-duration 90` limita la reproducción a los primeros 90 segundos; `--readrate 1.1` controla la lectura; `--media-port 18766`, `--control-port 18767`, `--no-open`. `--state-file` escribe `.local/state.json`; se puede indicar otra ruta dentro de `.local/`.

La interfaz sólo escucha en loopback y exige token por proceso para POST. El servidor multimedia escucha únicamente en la IP LAN hacia el Chromecast; permite CORS para recursos HLS. Se exige coincidencia exacta del nombre y del host cuando se indica. No uses un nombre de otro televisor.

La reproducción espera tres segmentos completos y el manifiesto de texto. La lista HLS es EVENT y crece; no se descarga la película completa antes de iniciar. El estado incluye PID/alive de FFmpeg, segmentos, duración generada, tiempo absoluto, estado del receptor y IDs de subtítulos activos. `generated_while_playing` se vuelve verdadero sólo si aumentan los segmentos durante observaciones PLAYING con el productor vivo; su validación real queda a cargo del operador.

Cada salto, incluso dentro del material generado, reinicia FFmpeg con `-ss` antes de `-i` desde la posición absoluta y una URL HLS nueva. Conserva la pausa y muestra espera hasta que el receptor confirme esa sesión en PLAYING o PAUSED; puede depender de la descarga del torrent. El tiempo absoluto es el origen de la sesión más el tiempo local del receptor. El límite `--max-duration` se refiere al final absoluto de la película, también después de saltar. Cambiar el retraso aplica el nuevo valor sobre la fuente original. Al detener o reiniciar, sólo se detiene el receptor si todavía reproduce la URL de esta sesión.

El productor se suspende al superar 60 segundos de adelanto y continúa cuando baja de 45; una pausa larga no genera toda la película. Se requieren 1 GB libre al iniciar y se detiene con menos de 512 MB libres o 6 GB de sesiones. Los artefactos quedan en `.local/sessions/` para inspección; no se borran automáticamente. Con el servicio detenido podés borrar manualmente las sesiones de este proyecto para recuperar espacio. No se toca la caché de Stremio.

Límites: sólo español de texto, sin OCR para PGS; transcodificación por CPU; FFprobe tiene un límite de 30 segundos. FFmpeg no conserva stderr para evitar filtrar URLs: sus fallos muestran código de salida. Este prototipo no implementa reconexión automática, autenticación multimedia ni borrado rotativo; mantenelo en una LAN de confianza. HTTP y Chromecast requieren validación real del operador, no cubierta por las pruebas offline.

Pruebas offline (sin sockets ni Chromecast):

```sh
/Users/stefano/stremio-cast-bridge/.venv/bin/python -B -m unittest discover -s tests -v
```
