# RÍO — detección de anomalías en flujo (behavioral baselining)

> Un río fluye hacia el mar con un caudal normal. Cuando cae una **piedra**,
> deja una **onda** que no encaja: ahí sabemos, **al momento**, que pasó algo.
> No hace falta conocer la piedra de antemano; basta conocer el flujo normal
> y notar cuándo se rompe.

Detector de anomalías en **streaming** (O(1) por muestra, sin dependencias).
No se basa en listas de amenazas conocidas, sino en aprender el comportamiento
normal y detectar lo que se desvía. Sirve para cualquier señal numérica en el
tiempo: peticiones/seg, bytes, latencia, intentos de login, una serie de precios…

## Las dos señales (la distinción clave)

| Metáfora | Qué es | Cómo se detecta |
|---|---|---|
| **La onda** | Un pico puntual (una piedra que cae y se va) | z-score robusto ≥ umbral |
| **El cauce** | Un desplazamiento **sostenido** del nivel (ataque lento, fuga) | CUSUM sobre el residuo |

El valor real está en el **cauce**: es lo que casi nadie detecta, porque no hace
ruido. Un atacante que sube el caudal poco a poco pasa desapercibido para los
sistemas de umbral fijo; el CUSUM acumula esas pequeñas desviaciones hasta que
el total deja de ser casualidad.

## Ficheros

- `detector.js` — el motor de UN río: `FlowBaseline` (EWMA robusto), `Cusum`, `RiverDetector`.
- `field.js` — el CAMPO: muchos ríos a la vez + detección de **correlación**.
- `simulate.js` — río sintético para pruebas (inyecta piedras y desvíos).
- `demo.js` — demo de un río por consola: `node river/demo.js`.
- `field-demo.js` — demo de correlación por consola: `node river/field-demo.js`.
- `server.js` — dashboard en vivo de UN río: `node river/server.js` → http://localhost:7070.
- `monitor.js` — dashboard multi-río con correlación: `node river/monitor.js` → http://localhost:7071.

## Correlación (lo que convierte esto en defensa)

Un río suelto con una onda suele ser ruido. La señal de verdad es que **varios
ríos se muevan JUNTOS**. `RiverField` vigila N canales en paralelo y, cuando
`corrMin` o más canales tienen anomalía dentro de una ventana de `corrWindow`
muestras, declara un **evento correlacionado** (p. ej. CPU + red + logins a la
vez = probable ataque). Medido en `field-demo.js`: una onda suelta en un canal
NO dispara correlación; un ataque que golpea tres canales a la vez SÍ.

## Diseño del motor

- **Base de flujo (`FlowBaseline`)**: media exponencial (EWMA) para el caudal
  normal y desviación absoluta media exponencial para la escala. La escala es
  **robusta**: una piedra enorme no infla la dispersión más allá de un tope, para
  no dejar sordo al detector.
- **Onda**: `z = (x − media) / escala`. Si `|z| ≥ rippleZ`, es una piedra.
- **Cauce (`Cusum`)**: acumula el z (saturado, para que una piedra no cuente como
  desvío) en cada dirección, restando un colchón. Al superar un umbral, el cauce
  cambió. Tras avisar, hay un **periodo refractario**: un desvío sostenido es UN
  evento, no muchos.

## Rendimiento medido (50 ríos sintéticos, 20.000 muestras de río normal)

| Prueba | Resultado |
|---|---|
| Piedra detectada | **50/50** |
| Desvío de cauce aislado | **50/50** (latencia media 4,0 muestras) |
| Falsas ondas | **4** (0,02 %) |
| Falsos cauces | **2** (0,01 %) |

## Limitación honesta conocida

**Una piedra muy grande caída ~1 s antes de un desvío lento enmascara el desvío
~50 % de las veces** (medido: 25/50). Causa: la piedra infla temporalmente la
escala y la base adaptativa absorbe el nuevo nivel antes de que el CUSUM acumule.
No es un bug corregible sin empeorar los falsos positivos: es intrínseco a usar
**una sola base adaptativa** para dos fenómenos de escala temporal distinta.

La solución correcta (trabajo futuro) es un **análisis multiescala**: detectar el
cauce sobre una representación de la señal con las ondas puntuales ya filtradas,
en lugar de reaprovechar la misma base. No se parchea; se rediseña.

## Banco de pruebas con ataques reales (defensa por capas)

`gen-log.js` genera un log de servidor (formato Combined) con **siete ataques**
modelados por su huella en la telemetría (estilo MITRE ATT&CK): DDoS, fuerza
bruta, credential stuffing distribuido, escaneo de vulnerabilidades, sondeo de
exploits (5xx), exfiltración y **beacon C2 de un troyano**. `ingest.js` lo
procesa **ciego**, en dos capas:

- **Capa A — ríos de volumen**: `req_min`, `auth_fail`, `not_found`,
  `server_err`, `unique_ips`, `bytes_mb`. Caza los seis ataques ruidosos
  (latencia 0-2 min) y correlaciona DDoS y fuerza bruta.
- **Capa B — periodicidad**: mide la regularidad de los intervalos por fuente.
  Caza el beacon C2 (low-and-slow) que el volumen no ve: una fuente que llama a
  casa cada ~30 s con coeficiente de variación ínfimo.

Resultado del banco: **7/7 ataques detectados**, con falsos positivos reducidos
de ~15 a ~1 gracias a dos mejoras del motor:

1. **EWMA robusto (Huber)**: un pico enorme no arrastra la media, así no deja
   una cola de falsas alarmas al terminar (la exfiltración pasó de 18 min de
   falsas alarmas a 0).
2. **Suelo de Poisson** en canales de conteo (`poisson:true`): la dispersión no
   cae por debajo de √media, así un 0→2 en un canal casi vacío no parece un
   terremoto (eliminó las falsas alarmas del arranque).

Correr: `node river/gen-log.js /tmp/a.log /tmp/t.json && node river/ingest.js /tmp/a.log /tmp/t.json`

## Parámetros (`new RiverDetector({ ... })`)

| Param | Def. | Significado |
|---|---|---|
| `halfLife` | 15 | memoria del flujo (muestras) |
| `warmup` | 40 | muestras para aprender antes de juzgar |
| `rippleZ` | 4 | a cuántas desviaciones una muestra es "onda" (y tope del Huber) |
| `cusumDrift` | 1.0 | colchón del CUSUM (debe superar el sesgo del vaivén normal) |
| `cusumH` | 5 | umbral de disparo del cauce |
| `shiftCooldown` | 30 | silencio tras avisar de un cauce |
| `poisson` | false | pon `true` en canales de conteo (suelo de dispersión √media) |

> **Nota:** estos valores se validaron sobre un río sintético. En datos reales,
> `halfLife`, `rippleZ` y los del CUSUM se recalibran según el ritmo y el ruido
> propios de la señal. Afinarlos sobre el juguete sería sobreajuste.
