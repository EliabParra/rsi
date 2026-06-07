# Load Balancer — Diseño RSI

> Documento de planificación. **No es implementación.** Define la arquitectura,
> los contratos y el plan por fases para incorporar un balanceador de carga a la
> arquitectura RSI (ejecución remota de métodos por reflexión).

---

## 1. Contexto y objetivo

La arquitectura RSI ejecuta métodos de forma remota mediante reflexión. El flujo
actual es:

```
ClientRSI.send  →  Dispatcher.handleRequest  →  BO Server  →  reflexión  →  respuesta
```

Hoy el Dispatcher resuelve **un único** BO server por clase, leído fijo desde
`shared/config.js` (`boServers.get(className)`).

El objetivo es correr el **mismo servicio en N equipos** y que el Dispatcher
decida a cuál instancia mandar cada petición, en función del estado **en tiempo
real** de cada server, mediante un algoritmo de ranking optimizado.

Los 5 criterios de balanceo (del diagrama):

1. Cantidad de CPU
2. Velocidad de CPU
3. Cantidad de memoria
4. Cantidad de servicios actuales (peticiones en vuelo / *in-flight*)
5. Cantidad de respuestas por segundo (RPS)

---

## 2. Principios de diseño (no negociables)

### 2.1 Push, no pull — nunca I/O de red en el camino crítico

El balanceador **no** pregunta métricas a los servers cuando llega una petición.
Si lo hiciera, sumaría un round-trip × N a **cada** request y se volvería el
cuello de botella.

En su lugar, cada BO server **empuja** (push) sus métricas al Dispatcher
periódicamente (heartbeat). El LB mantiene un registro en memoria con el último
estado conocido. Cuando llega una request, la decisión es **puro CPU sobre un
`Map` en memoria** → microsegundos, cero I/O de red. Eso es "optimizado".

### 2.2 Métricas estáticas vs dinámicas

No todos los criterios cambian con el tiempo. Separarlos evita reenviar datos
que nunca cambian.

| Criterio                  | Tipo         | Origen                          | Frecuencia        |
| ------------------------- | ------------ | ------------------------------- | ----------------- |
| 1. Cantidad de CPU        | **Estático** | `os.cpus().length`              | 1 vez (register)  |
| 2. Velocidad de CPU       | **Estático** | `os.cpus()[0].speed`            | 1 vez (register)  |
| 3. Memoria total          | **Estático** | `os.totalmem()`                 | 1 vez (register)  |
| 3. Memoria libre          | Dinámico     | `os.freemem()`                  | cada heartbeat    |
| 4. Servicios actuales     | Dinámico     | contador propio del BO server   | cada heartbeat    |
| 5. Respuestas/seg (RPS)   | Dinámico     | contador rolling (EWMA)         | cada heartbeat    |
| (CPU util)                | Dinámico     | `os.loadavg()` / cálculo propio | cada heartbeat    |

- Lo **estático** define la **capacidad/peso** del server → se manda una sola
  vez al registrarse.
- Lo **dinámico** define el **margen libre actual** → va en cada heartbeat.

---

## 3. Decisiones tomadas

| Decisión                  | Elección                                                                 | Motivo                                                                                  |
| ------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Ubicación del LB**      | Módulo/clase **embebido en el Dispatcher**                               | Cero hops extra en el camino crítico. El registro vive en memoria del Dispatcher.      |
| **Canal del heartbeat**   | **Mismo socket TCP** del Dispatcher (puerto 3000), discriminado por `type` | No multiplicar infraestructura ni puertos.                                              |
| **Conexión BO→Dispatcher**| **Persistente** (una conexión de larga vida por BO server)               | Más eficiente que reconectar por heartbeat. Requiere manejo de reconexión.             |
| **RPS como criterio**     | Factor de **carga**, relativo a la capacidad                             | Un server poco potente recibiendo muchas req está saturado → se lo penaliza.           |
| **Algoritmo**             | **Score compuesto ponderado normalizado**                                | Combina los 5 criterios; más flexible que round-robin o least-connections puro.        |
| **Failover**              | Lista **rankeada** (rank 1, 2, 3…)                                        | El rank 2+ es el fallback si falla la conexión al rank 1.                               |
| **Anti thundering herd**  | Contabilidad **local de in-flight** en el LB                             | Evita que todas las requests se amontonen en el "mejor" server entre heartbeats.       |

> El LB embebido convierte la flecha "Dispatcher → Load Balancer" del diagrama en
> una **llamada a un método en memoria**, no en un payload de red. El "serverList"
> que muestra el diagrama es el conjunto de candidatos; el LB lo enriquece con las
> métricas que ya tiene en su registro.

---

## 4. Contratos

### 4.1 Configuración — N instancias por servicio

`shared/config.js` evoluciona de un objeto único a una **lista** por servicio.
Esto es solo el *bootstrap/discovery* (qué instancias existen). La salud y las
métricas vienen por heartbeat, no de acá.

```js
boServers: {
  calculator: [
    { id: 'calc-1', host: '172.20.243.176', port: 4001 },
    { id: 'calc-2', host: '172.20.243.177', port: 4001 },
    { id: 'calc-3', host: '172.20.243.178', port: 4001 }
  ],
  equation: [ /* ídem */ ]
}
```

### 4.2 Protocolo — discriminador de mensajes

Hoy el mensaje es plano (`{ method, className, args }`). Se lo envuelve con un
campo `type`. Los tres tipos viajan sobre el mismo `shared/jsonStream.js`:

```js
// (1) BO server → Dispatcher, al arrancar — capacidad estática, UNA vez
{
  type: 'register',
  serverId: 'calc-1',
  className: 'Calculator',
  caps: { cpuCores: 8, cpuSpeed: 3200, totalMem: 16777216000 }
}

// (2) BO server → Dispatcher, cada N ms — estado dinámico
{
  type: 'heartbeat',
  serverId: 'calc-1',
  metrics: { freeMem: 8123456000, inFlight: 3, rps: 42.5, cpuUtil: 0.31 }
}

// (3) Client → Dispatcher — la RPC de hoy, ahora con type
{
  type: 'rpc',
  className: 'Calculator',
  method: 'addition',
  args: { /* ... */ }
}
```

`Dispatcher.handleRequest` ramifica por `type`:
- `register` / `heartbeat` → van al LB (actualizan el registro).
- `rpc` → dispara el ranking + forward al BO server elegido.

> **Conexión persistente:** el BO server abre **una** conexión al Dispatcher al
> arrancar, manda `register`, y luego envía `heartbeat` periódicos por la misma
> conexión. Si la conexión se cae, debe reconectar y volver a registrarse.

### 4.3 Estado interno del LB

```js
// Map<className, Map<serverId, ServerState>>
ServerState = {
  id, host, port,

  // estático (de 'register') — precalculado
  capacity,        // score estático combinado (ver §5)

  // dinámico (último 'heartbeat')
  freeMem, totalMem, inFlight, rps, cpuUtil,

  // control interno del LB
  lastSeen,        // timestamp monotónico → detección de stale
  localInFlight    // contador propio del LB (anti thundering herd)
}
```

### 4.4 API del LB (lo que el Dispatcher invoca)

```
lb.register(msg)      // crea/actualiza ServerState, precalcula capacity
lb.heartbeat(msg)     // actualiza métricas dinámicas + lastSeen
lb.rank(className)    // → [{ rank:1, id, host, port }, { rank:2, ... }]  (puro CPU)
lb.onDispatch(id)     // ++localInFlight  (al despachar una request)
lb.onResponse(id)     // --localInFlight  (al recibir la respuesta / cierre)
```

`rank()` es el corazón del balanceador:
1. Filtra *unhealthy* (cuyo `lastSeen` superó el timeout).
2. Normaliza las métricas del conjunto de candidatos.
3. Calcula el `score` de cada uno.
4. Ordena descendente y asigna `rank: 1, 2, 3…`.
5. Devuelve la lista rankeada.

---

## 5. Algoritmo de ranking

### 5.1 Fórmula

Pesos configurables (`ws*` para lo estático, `wd*` para lo dinámico), cada grupo
sumando 1, para poder tunear sin tocar código.

```
// Estático — calculado UNA vez al registrar el server
capacity = ws1·norm(cpuCores)
         + ws2·norm(cpuSpeed)
         + ws3·norm(totalMem)

// Dinámico — calculado en cada rank()
load = wd1·(inFlight + localInFlight) / capacity      // peticiones en vuelo vs capacidad
     + wd2·(1 - freeMem / totalMem)                   // presión de memoria
     + wd3·cpuUtil                                     // uso de CPU
     + wd4·norm(rps) / capacity                        // RPS relativo a capacidad (carga)

score = capacity · (1 - load)    // más capacidad y menos carga → score más alto
```

### 5.2 Notas clave

- **`norm()`** lleva cada métrica a `[0,1]` respecto al **máximo del conjunto de
  candidatos** (o un máximo conocido). Sin esto, los bytes de RAM aplastarían al
  "cantidad de CPUs" y los pesos no serían comparables.

- **RPS es carga, no premio.** Un server poco potente que recibe muchas
  req/seg está saturado: por eso `rps` entra en `load` dividido por `capacity`
  (RPS relativo). Mucho RPS sobre poca capacidad = muy penalizado.

- **`localInFlight` (anti thundering herd).** Si entre heartbeats siempre se
  elige al rank 1, todas las requests se amontonan en el "mejor" server hasta el
  próximo heartbeat. El LB incrementa su propio contador en el instante en que
  despacha (`onDispatch`) y lo decrementa en la respuesta (`onResponse`), así su
  visión de carga se actualiza al toque sin esperar el heartbeat.

- **EWMA para suavizar.** El `rps` (y opcionalmente latencia) conviene
  calcularlo como media móvil exponencial en el BO server, para que un pico
  puntual no distorsione el ranking.

- **Complejidad.** `rank()` es O(n log n) sobre los candidatos (n ≈ 3). Trivial.
  La clave de la performance no es la complejidad sino **no hacer I/O** acá.

### 5.3 Por qué no otros algoritmos

| Algoritmo               | Por qué no                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| Round-robin             | Ignora la carga y las características de cada server.              |
| Least-connections puro  | Usa un solo criterio (in-flight); desperdicia los otros 4.        |
| Random                  | No aprovecha ninguna métrica.                                     |

> *Optimización avanzada opcional:* **Power of Two Choices (P2C)** — elegir 2
> candidatos al azar y mandar al menos cargado. Dispersa mejor a gran escala.
> No es necesario para empezar.

---

## 6. Salud y failover

- **Detección de stale:** si `now - lastSeen > heartbeatTimeout`, el server se
  marca *unhealthy* y queda **fuera** del ranking.
- **Failover por lista rankeada:** el Dispatcher intenta conectar al rank 1; si
  la conexión falla, cae en cascada al rank 2, luego al 3.
- **Circuit breaker (opcional):** si despachar a un server falla repetidamente,
  se lo expulsa temporalmente aunque siga mandando heartbeats.

---

## 7. Plan por fases

### Fase 0 — Groundwork (sin cambiar comportamiento)
- Generalizar `shared/config.js`: `calculator` pasa de `{host,port}` a
  `[{ id, host, port }, …]`.
- Extraer el "forward al BO server" de `Dispatcher.handleRequest` a un método
  aislado, para poder insertar ahí la decisión del LB.

### Fase 1 — Agente de métricas en cada BO server
- Módulo `MetricsCollector`: samplea `os.*` + contador propio de in-flight +
  RPS (EWMA).
- El BO server envuelve `handleRequest` con `++inFlight` / `--inFlight`.

### Fase 2 — Transporte de heartbeat
- Introducir el discriminador `type` en el protocolo (`register | heartbeat |
  rpc`) sobre `shared/jsonStream.js`.
- El BO server abre conexión **persistente** al Dispatcher: al arrancar manda
  `register` (capacidad estática); luego `heartbeat` cada N ms. Manejar
  reconexión + re-registro si la conexión se cae.

### Fase 3 — LB: registro + scoring
- Clase `LoadBalancer` con `Map<className, Map<serverId, ServerState>>`.
- Implementar `register`, `heartbeat`, `rank` (normalización + score),
  `onDispatch`, `onResponse`.
- Pruning de servers con heartbeat vencido.

### Fase 4 — Cablear al Dispatcher
- `handleRequest` ramifica por `type`.
- En `rpc`: `lb.rank(className)` → lista ordenada → conectar al rank 1, cascada
  a rank 2+ si falla. `lb.onDispatch(id)` al despachar, `lb.onResponse(id)` en la
  respuesta o cierre.

### Fase 5 — Tuning y hardening
- Pesos (`ws*`/`wd*`) configurables.
- EWMA, circuit breaker, observabilidad (logs/metrics del propio LB).
- **Load test** para *verificar* que la distribución es la esperada.

---

## 8. Pendientes / observaciones

- **Inconsistencia de naming a unificar:** el diagrama usa `methodName` / `params`
  pero el código usa `method` / `args`. Elegir uno antes de empezar la Fase 0.
- **Definir constantes operativas:** intervalo de heartbeat (N ms), timeout de
  stale, y valores iniciales de los pesos.
- **`cpuUtil`:** definir cómo se calcula en el BO server (a partir de
  `os.loadavg()` normalizado por núcleos, o muestreo de `process.cpuUsage()`).
