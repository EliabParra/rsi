# Cómo funciona el sistema RSI — explicación paso a paso

Esta guía explica **todo el recorrido del código**, método por método, desde que
levantás el sistema hasta que una petición vuelve con su respuesta. Está escrita
en lenguaje sencillo: si nunca tocaste el proyecto, podés seguirla de arriba a
abajo.

---

## Las piezas (quién es quién)

Pensá el sistema como un restaurante:

| Pieza | Rol | Archivo |
|-------|-----|---------|
| **Cliente** | El comensal que pide un plato | [client/ClientServer.js](../client/ClientServer.js) |
| **Proxy** | El mozo que toma el pedido | [client/ProxyCriminal.js](../client/ProxyCriminal.js) |
| **Dispatcher** | El maître que decide qué cocinero atiende | [server/Dispatcher.js](../server/Dispatcher.js) |
| **LoadBalancer** | El cerebro del maître (a quién conviene mandarle) | [server/LoadBalancer.js](../server/LoadBalancer.js) |
| **BO Server** | El cocinero (hay varios, son réplicas) | [BO_Servers/server/BOServer.js](../BO_Servers/server/BOServer.js) |
| **Criminal** | La receta concreta (la lógica de negocio) | [BO_Servers/class/Criminal.js](../BO_Servers/class/Criminal.js) |
| **PostgreSQL** | La despensa (la base de datos) | [db/pool.js](../db/pool.js) |

Reglas del juego:

- Nadie habla "TCP crudo". Todos se comunican con **mensajes JSON terminados en
  un salto de línea (`\n`)**. Eso lo maneja [shared/jsonStream.js](../shared/jsonStream.js).
- El Cliente habla SOLO con el Dispatcher (puerto `3000`).
- El Dispatcher habla con los BO Servers (puertos `4001`, `4002`, `4003`).
- Los BO Servers hablan con PostgreSQL (puerto `5432`).

---

## El lenguaje común: cómo se hablan todos

Antes de arrancar, entendé esto porque se usa en **cada** conexión del sistema.

TCP es un "chorro" de bytes: dos mensajes pueden llegar pegados, o uno partido a
la mitad. Para convertir ese chorro en mensajes ordenados se usa un truco: cada
mensaje termina en `\n`.

- **[writeJson()](../shared/jsonStream.js#L23)** — agarra un objeto, lo convierte
  a texto JSON y le pega un `\n` al final. Ese salto de línea es la **marca de
  "fin de mensaje"**.
- **[onJsonMessage()](../shared/jsonStream.js#L1)** — escucha lo que llega,
  lo va guardando en un `buffer`, y cada vez que encuentra un `\n` corta ahí,
  convierte ese pedazo de texto de vuelta a objeto (`JSON.parse`) y te avisa.

A esto se le llama **framing**: ponerle "marco" a cada mensaje. Sin esto, dos
peticiones seguidas se mezclarían y se romperían.

---

## ACTO 1 — Levantar el sistema

### 1.1 Arranca el Dispatcher (`node start.js`)

1. **[start.js](../start.js)** crea `new Dispatcher()` y llama a `d.init()`.
2. El **[constructor del Dispatcher](../server/Dispatcher.js#L8)** prepara:
   - `this.boServers` — un catálogo estático de servidores (el "plan B").
   - `this.lb` — el **LoadBalancer**, el que decide a quién mandarle cada pedido.
   - `this.reqSeq = 0` — un contador para numerar peticiones.
3. **[Dispatcher.init()](../server/Dispatcher.js#L19)** hace el trabajo pesado:
   - Llama a **[loadBOServers()](../server/Dispatcher.js#L15)**, que mete en el
     catálogo la lista de réplicas que vienen de [config.js](../shared/config.js#L14)
     (bo-1 en 4001, bo-2 en 4002, bo-3 en 4003). Esto es el **plan B**: si todavía
     no llegó ninguna señal de vida real, al menos sabe a dónde intentar.
   - Crea el servidor TCP (`Net.createServer`). Cada vez que algo se conecta y
     manda un mensaje, ese mensaje cae en **`handleRequest`**.
   - Programa una limpieza periódica: cada 3 segundos llama a
     **[lb.prune()](../server/LoadBalancer.js#L171)**, que borra los servidores
     que dejaron de dar señales de vida.
   - `listen(3000)` — queda escuchando.

En este punto el Dispatcher está vivo, pero **todavía no conoce a nadie en
tiempo real**. Solo tiene la lista estática del plan B.

### 1.2 Arrancan los BO Servers (`node start-bo.js --id bo-1 --port 4001`)

1. **[start-bo.js](../start-bo.js#L15)** lee los argumentos con `parseArgs()`
   (los flags `--id`, `--port`, `--host` ganan sobre las variables de entorno),
   crea `new BOServer({ id, host, port })` y llama a `bo.init()`.
2. El **[constructor de BOServer](../BO_Servers/server/BOServer.js#L18)** guarda
   su id y puerto, y crea su propio **`MetricsCollector`** (el que mide cuán
   ocupado está).
3. **[BOServer.init()](../BO_Servers/server/BOServer.js#L29)**:
   - Llama a **[metrics.start()](../BO_Servers/MetricsCollector.js#L63)**, que
     arranca un temporizador: cada segundo recalcula su **RPS** (peticiones por
     segundo) usando un promedio suavizado, para que un pico puntual no le
     distorsione la medición.
   - Crea su propio servidor TCP en el puerto 4001. Cada pedido que llega cae en
     su **`handleRequest`**.
   - `listen()` y, cuando ya está escuchando, llama a `_startHeartbeat()`.

### 1.3 El BO Server se presenta ante el Dispatcher

Acá pasa algo clave: cada cocinero **avisa que existe** y después **manda su
estado** constantemente.

1. **[BOServer._startHeartbeat()](../BO_Servers/server/BOServer.js#L46)** crea un
   **`HeartbeatClient`** apuntando al Dispatcher y lo arranca.
2. **[HeartbeatClient.start()](../BO_Servers/HeartbeatClient.js#L42)** llama a
   `_connect()`.
3. **[HeartbeatClient._connect()](../BO_Servers/HeartbeatClient.js#L47)** abre
   **UNA sola conexión persistente** del BO Server hacia el Dispatcher. Apenas
   conecta, dispara dos cosas:
   - **[_register()](../BO_Servers/HeartbeatClient.js#L76)** — manda un mensaje
     `{ type: 'register', ... }` con su **capacidad de hardware**, que saca de
     **[metrics.getStaticCaps()](../BO_Servers/MetricsCollector.js#L26)**:
     cantidad de núcleos de CPU, velocidad y memoria total. Esto se manda **una
     sola vez**: es como decir "este es el tamaño de mi cocina".
   - **[_startHeartbeat()](../BO_Servers/HeartbeatClient.js#L87)** — arranca un
     latido: cada 1 segundo manda `{ type: 'heartbeat', ... }` por la **misma**
     conexión, con su estado en vivo desde
     **[getDynamicMetrics()](../BO_Servers/MetricsCollector.js#L36)**: memoria
     libre, peticiones en curso, RPS y uso de CPU.

> **Idea de diseño importante:** el Dispatcher **nunca pregunta** "¿cómo estás?"
> en el momento de decidir. Son los BO Servers los que **empujan** su estado
> constantemente. Así, cuando hay que decidir a quién mandarle, la decisión es
> puro cálculo en memoria, sin esperar a la red. Por eso es rápido.

Si la conexión se cae, el `HeartbeatClient` **reconecta solo** y vuelve a
registrarse.

### 1.4 El Dispatcher registra al BO Server

El mensaje de `register` que mandó el BO Server entra por el Dispatcher:

1. **[Dispatcher.handleRequest()](../server/Dispatcher.js#L39)** mira el campo
   `type` del mensaje:
   - Si es `'register'` → llama a **[lb.register()](../server/LoadBalancer.js#L32)**
     y termina **sin cerrar la conexión** (la deja viva para los latidos).
   - Si es `'heartbeat'` → llama a **[lb.heartbeat()](../server/LoadBalancer.js#L59)**.
   - Si no, lo trata como una petición normal (lo vemos en el Acto 2).
2. **[LoadBalancer.register()](../server/LoadBalancer.js#L32)** guarda en su
   registro interno (`this.registry`) la capacidad del servidor y anota la hora
   (`lastSeen`).
3. Cada **[lb.heartbeat()](../server/LoadBalancer.js#L59)** que llega actualiza
   las métricas en vivo y refresca `lastSeen`.

Ahora **sí** el Dispatcher tiene una foto en vivo de todo el equipo, que se
refresca cada segundo.

---

## ACTO 2 — Una petición de punta a punta

Ejemplo: el cliente quiere listar criminales con `criminalProxy.list({ limit: 5 })`.

### 2.1 El cliente arma y manda el pedido

1. **[ClientServer.runClientApp()](../client/ClientServer.js#L8)** crea un
   `new ProxyCriminal(...)` y llama a `.list({ limit: 5 })`.
2. **[ProxyCriminal.list()](../client/ProxyCriminal.js#L16)** es comodidad: traduce
   esa llamada a un mensaje genérico
   `{ className: 'Criminal', method: 'list', args: { limit: 5 } }` y llama a
   `sendBO`.

   > Este es el patrón **Proxy**: el cliente llama `proxy.list()` como si el
   > objeto estuviera en su misma máquina, pero por debajo el pedido viaja por la
   > red. Toda la "magia" de red vive en la clase padre, `ClientRSI`.

3. **[ClientRSI.sendBO()](../client/ClientRSI.js#L46)** llama a `send()` y luego
   interpreta la respuesta con `parseBOResponse()`.
4. **[ClientRSI.send()](../client/ClientRSI.js#L12)** abre una conexión TCP al
   Dispatcher (puerto 3000). Al conectar, le agrega un `clientId` y un `reqId`
   único (para poder rastrear el pedido) y lo manda con `writeJson`. Devuelve una
   **promesa** que se resuelve cuando llega la respuesta, y ahí cierra el socket.

### 2.2 El Dispatcher recibe y decide

1. **[Dispatcher.handleRequest()](../server/Dispatcher.js#L39)** ve que el `type`
   no es `register` ni `heartbeat`, así que lo trata como petición y llama a
   `handleRpc`.
2. **[Dispatcher.handleRpc()](../server/Dispatcher.js#L54)**:
   - Suma 1 al contador y arma el identificador del pedido.
   - Llama a **[resolveTargets()](../server/Dispatcher.js#L74)** para conseguir la
     lista de candidatos **ordenados de mejor a peor**.
   - Si no hay ningún candidato → responde error y cierra.
   - Si hay → arma el mensaje a reenviar y llama a `forwardWithFailover`.
3. **[resolveTargets()](../server/Dispatcher.js#L74)** primero le pregunta al
   LoadBalancer (`lb.rank`). Si el balanceador tiene candidatos (porque ya
   llegaron latidos), usa esos. Si está vacío (recién arrancó, sin latidos),
   recurre a la **lista estática** del plan B.

### 2.3 El corazón: cómo el LoadBalancer decide el orden

**[LoadBalancer.rank()](../server/LoadBalancer.js#L91)** es el método más
importante del balanceo. Hace lo siguiente:

1. **[_healthy()](../server/LoadBalancer.js#L73)** se queda solo con los
   servidores **sanos**: los que tienen capacidad conocida **y** mandaron un
   latido hace poco (menos de 3 segundos). Un servidor que se quedó mudo hace 4
   segundos queda afuera.
2. Calcula los **valores máximos del grupo** (el que más CPU tiene, el que más
   RAM, etc.) para **normalizar**. ¿Por qué? Porque no se pueden sumar "8 núcleos"
   con "16 GB de RAM" directamente: son unidades distintas. Al dividir cada cosa
   por el máximo del grupo, todo queda en una escala de 0 a 1 y se vuelve
   comparable.
3. Para cada servidor calcula:
   - **`capacity`** (capacidad): qué tan "grande" es su hardware (núcleos +
     velocidad + RAM, combinados).
   - **`load`** (carga): qué tan ocupado está (peticiones en curso + memoria en
     uso + CPU + RPS). Importante: la carga se divide por la capacidad, así que
     **la misma cantidad de trabajo pesa más en un servidor chico** que en uno
     grande.
   - **`score = capacity * (1 - load)`**: un servidor grande y descargado obtiene
     puntaje alto; uno chico y saturado, bajo.
4. Ordena de mayor a menor puntaje y devuelve la lista con `rank: 1`, `rank: 2`,
   etc. El **rank 1 es el elegido**; los demás quedan como plan de respaldo por
   si el primero falla.

### 2.4 El reenvío con respaldo (failover)

**[Dispatcher.forwardWithFailover()](../server/Dispatcher.js#L91)** toma esa lista
ordenada e intenta con el primero:

1. **[lb.onDispatch()](../server/LoadBalancer.js#L152)** suma 1 a un contador
   **local** de peticiones en curso de ese servidor. Esto evita un problema
   típico: si llegan 100 pedidos en el mismo segundo (antes del próximo latido),
   el balanceador ya sabe que le está cargando trabajo a ese servidor y no lo
   satura mandándole todo a él.
2. Abre una conexión TCP al BO Server (4001) y le manda el pedido.
3. Si el BO Server **responde**:
   - **[lb.onResponse()](../server/LoadBalancer.js#L157)** baja ese contador local.
   - Le agrega a la respuesta un bloque `_meta` (quién la atendió, qué rank tenía,
     cuántos intentos hicieron falta) para poder rastrear.
   - **[logRouteDecision()](../server/Dispatcher.js#L132)** registra la decisión
     en el log (bajo mucha carga lo hace de a muestras, para no inundar la
     consola).
   - Le reenvía la respuesta al cliente y cierra las conexiones.
4. Si el BO Server **falla** (error de conexión):
   - Registra un **failover** en el log y se vuelve a llamar a sí mismo con el
     **siguiente** de la lista (rank 2, después rank 3...), en cascada.
   - Si se agotan todos los candidatos → le responde un error al cliente.

   > Un pequeño candado (`done`) evita responderle dos veces al cliente si la
   > respuesta y un error llegan casi al mismo tiempo.

### 2.5 El BO Server ejecuta de verdad

El pedido reenviado llega al cocinero:

1. **[BOServer.handleRequest()](../BO_Servers/server/BOServer.js#L61)**:
   - **[metrics.requestStarted()](../BO_Servers/MetricsCollector.js#L53)** suma 1
     a "peticiones en curso" (este número es justo el que después viaja en el
     latido).
   - Valida que el mensaje traiga `className` y `method`.
   - Llama a **[resolveClassInstance()](../BO_Servers/methodResolver.js#L3)**.
2. **[resolveClassInstance()](../BO_Servers/methodResolver.js#L3)** es el mecanismo
   de **reflexión** (descubrir clases y métodos automáticamente):
   - Usa **[MethodMapper](../BO_Servers/methodMapper.js)**. Si todavía no exploró
     las clases, llama a **[initialize()](../BO_Servers/methodMapper.js#L18)**: lee
     la carpeta `class/`, importa cada archivo `.js`, crea una instancia y anota
     todos sus métodos en un mapa.

     > Esto es lo bueno: si mañana agregás `class/Vehicle.js`, **funciona solo**,
     > sin tener que tocar ningún registro a mano.

   - **[hasMethod()](../BO_Servers/methodMapper.js#L72)** verifica que el método
     pedido exista (sin importar mayúsculas/minúsculas). Si no existe, devuelve un
     mensaje de error.
   - Importa la clase `Criminal`, crea una instancia y la devuelve.
3. De vuelta en `handleRequest`: agarra el método pedido (`list`), confirma que
   sea una función y lo ejecuta con `await fn(args)`.
4. **[Criminal.list()](../BO_Servers/class/Criminal.js#L49)** hace la consulta
   `SELECT * FROM criminals ...` contra PostgreSQL, usando el **pool de
   conexiones** de [db/pool.js](../db/pool.js). Devuelve `{ msg, result }`.
5. `writeJson(socket, response)` manda la respuesta de vuelta al Dispatcher.
6. En el bloque **`finally`** →
   **[metrics.requestFinished()](../BO_Servers/MetricsCollector.js#L57)** baja
   "peticiones en curso" y suma una al conteo de RPS. El `finally` garantiza que
   esto pase **aunque la consulta falle**, así nunca queda un contador inflado.

### 2.6 La respuesta vuelve

La respuesta sube en cadena: BO Server → Dispatcher (que le pega el `_meta`) →
Cliente. En el cliente:

1. **[ClientRSI.parseBOResponse()](../client/ClientRSI.js#L35)** verifica que la
   respuesta tenga la forma esperada `{ msg, result }`. Deja afuera el `_meta` del
   resultado de negocio (aunque `sendBO` lo vuelve a adjuntar por separado para
   quien lo necesite, como el panel del test de carga).
2. La promesa se resuelve y **[ClientServer](../client/ClientServer.js#L14)**
   imprime el mensaje y el resultado. **Fin del viaje.**

---

## El mapa completo en una imagen mental

```
Cliente.list()
  → Proxy.list()                       (traduce a mensaje genérico)
  → ClientRSI.send()                   (abre TCP al Dispatcher :3000)
      → Dispatcher.handleRequest
      → handleRpc
      → resolveTargets → LoadBalancer.rank()   (elige al mejor servidor)
      → forwardWithFailover            (abre TCP al BO Server :4001)
          → BOServer.handleRequest
          → resolveClassInstance        (reflexión: encuentra la clase y el método)
          → Criminal.list()             (consulta a PostgreSQL :5432)
          ← respuesta { msg, result }
      ← respuesta + _meta
  ← respuesta final
```

Y **en paralelo, todo el tiempo**, de fondo:

- Cada BO Server **late cada 1 segundo** (`HeartbeatClient`) empujando sus
  métricas.
- El LoadBalancer guarda esas métricas en memoria.
- El Dispatcher **poda** (`prune`) cada 3 segundos a los que se quedaron callados.

Esa actividad de fondo es la "inteligencia" del sistema: gracias a ella, el
rank 1 siempre es el servidor más sano **en ese instante**.

---

## Glosario rápido

- **RPC** (Remote Procedure Call): llamar a una función que en realidad se
  ejecuta en otra máquina, como si fuera local.
- **Proxy**: objeto que se hace pasar por el real, pero reenvía las llamadas por
  la red.
- **Heartbeat** (latido): mensaje periódico que dice "sigo vivo y así estoy de
  ocupado".
- **Load balancer** (balanceador de carga): reparte el trabajo entre varios
  servidores según quién esté más libre.
- **Failover**: si el primer servidor falla, se intenta automáticamente con el
  siguiente.
- **Framing**: marcar dónde empieza y termina cada mensaje dentro del chorro de
  bytes de TCP (acá, con un `\n`).
- **Reflexión**: descubrir clases y métodos en tiempo de ejecución, sin tenerlos
  listados a mano.
- **In-flight**: peticiones que ya entraron pero todavía no terminaron.
- **EWMA**: promedio que le da más peso a lo reciente; suaviza los picos.
</content>
</invoke>
