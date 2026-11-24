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

- `detector.js` — el motor: `FlowBaseline` (EWMA robusto), `Cusum`, `RiverDetector`.
- `simulate.js` — río sintético para pruebas (inyecta piedras y desvíos).
- `demo.js` — demostración por consola: `node river/demo.js`.
- `server.js` — dashboard en vivo por SSE: `node river/server.js` → http://localhost:7070.

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

## Parámetros (`new RiverDetector({ ... })`)

| Param | Def. | Significado |
|---|---|---|
| `halfLife` | 15 | memoria del flujo (muestras) |
| `warmup` | 40 | muestras para aprender antes de juzgar |
| `rippleZ` | 4 | a cuántas desviaciones una muestra es "onda" |
| `cusumDrift` | 1.0 | colchón del CUSUM (debe superar el sesgo del vaivén normal) |
| `cusumH` | 5 | umbral de disparo del cauce |
| `shiftCooldown` | 30 | silencio tras avisar de un cauce |

> **Nota:** estos valores se validaron sobre un río sintético. En datos reales,
> `halfLife`, `rippleZ` y los del CUSUM se recalibran según el ritmo y el ruido
> propios de la señal. Afinarlos sobre el juguete sería sobreajuste.
