# Refactor — Desacople total de RSI (hexagonal / screaming architecture)

> **Documento de planificación. NO es implementación — spec para retomar después
> del curso.** Define el objetivo, los smells, la arquitectura destino (ports +
> composition root), los items de refactor R1–R11, los criterios de aceptación
> verificables y cómo retomar. **No se escribe código acá. No se tocan fuentes.**

---

## 1. Alcance (scope)

### Qué busca este refactor

Hoy RSI **funciona** (Load Balancer embebido, heartbeat, failover, BO único
contra Postgres, prueba de carga — ver `docs/load-balancer.md` y
`docs/plan-definitiva.md`). El problema no es que ande: es que está **acoplado**.
Hay singletons globales, `import()` por request, paths hardcodeados, config
monolítica y dependencias que se importan en vez de inyectarse. Eso hace que el
sistema sea difícil de testear, difícil de razonar y difícil de levantar en
varias máquinas sin tocar código.

Este refactor lleva RSI a una **arquitectura hexagonal / screaming**: cada
dependencia externa (registro de métodos, carga de clases, repositorio,
cluster de DB, observabilidad) se expresa como un **port** (un contrato), y un
**composition root** los **inyecta** en el Dispatcher y en los BO. Sin framework
de DI: inyección manual por constructor, a mano, explícita y legible.

### Qué SÍ entra

- Separar `shared/config.js` por concern (R1).
- Inyectar dependencias en el Dispatcher y en los BO por constructor (R2, R7).
- Matar singletons globales: `MethodMapper`, los pools eager de `db/pool.js`
  (R3, R4).
- Cachear la resolución de clases (sin `import()` por request) (R5).
- Path de clases configurable (R6).
- Sacar `_meta` del contrato de negocio y versionarlo (R8).
- **DbCluster**: componente de DB que mira la query y rutea writes→primary,
  reads balanceados entre réplicas, con health checks / métricas / lag-aware
  (R9 — versión COMPLETA documentada acá; la mínima se implementa aparte).
- **Logging estructurado de TODO** (R10).
- **Test pesado entendible** (R11).

### Qué NO entra (ver §9 No-goals)

Sin TypeScript, sin bundler, sin framework de DI. No se toca el scoring del LB
ni el protocolo de heartbeat. No se agregan features de negocio.

---

## 2. Estado actual + arquitectura objetivo

### 2.1 Estado actual (cómo está cableado hoy)

```
                     ┌──────────────── M0 ────────────────┐
   loadTest.js ─RPC─►│ Dispatcher                         │
   (ProxyCriminal)   │   new LoadBalancer(config.lb)      │  ← importa config directo
                     │   createLogger(config.log)         │  ← logger acoplado a config
                     │   resolveTargets → forward         │
                     └──────────────┬─────────────────────┘
                                    │ forward (rank 1, failover 2,3)
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        ┌──────────┐         ┌──────────┐         ┌──────────┐
        │ BOServer │         │ BOServer │         │ BOServer │
        │  bo-1    │         │  bo-2    │         │  bo-3    │
        └────┬─────┘         └────┬─────┘         └────┬─────┘
             │ resolveClassInstance() → import() POR REQUEST
             │ new MethodMapper()  ← SINGLETON GLOBAL (static instance)
             ▼
        ┌──────────────┐   import { writePool, readPool }  ← SINGLETONS EAGER
        │ Criminal.js  │───────────────────────────────────► Postgres
        └──────────────┘   (la clase IMPORTA el pool, no lo recibe)
```

Puntos de dolor estructural (resumen — detalle en §3):

- El Dispatcher **importa** `config`, `LoadBalancer` y el logger directo: no se
  puede instanciar con dobles para test.
- `MethodMapper` es un **singleton de proceso** (`static instance`): dos BO en el
  mismo proceso comparten estado; imposible aislar en test.
- `methodResolver` hace `import()` **por request** sobre un path relativo
  hardcodeado (`./class/${classKey}.js`).
- `db/pool.js` crea **dos `Pool` eager** al importarse el módulo: efecto
  secundario en import, imposible de inyectar o cerrar limpio.
- `Criminal.js` **importa** `writePool`/`readPool`: la decisión read/write vive
  dentro de la clase de negocio, mezclada con el SQL.

### 2.2 Arquitectura objetivo (composition root inyectando ports)

```
                          ┌──────────────── COMPOSITION ROOT ────────────────┐
                          │  (start.js / start-bo.js — único lugar que       │
                          │   conoce config y construye los adaptadores)     │
                          └───────────────────────┬──────────────────────────┘
                                                  │ construye + inyecta
            ┌─────────────────────────────────────┼──────────────────────────────┐
            ▼                                       ▼                              ▼
   ┌──────────────────┐                  ┌──────────────────┐           ┌──────────────────┐
   │   Dispatcher     │                  │     BOServer     │           │  Observability   │
   │  (recibe ports)  │                  │  (recibe ports)  │◄──────────│   (Logger port)  │
   │  · LoadBalancer  │                  │  · MethodRegistry│           │  canal único de  │
   │  · Logger        │                  │  · ClassLoader   │──────────►│  ruteo/failover/ │
   │  · Topology      │                  │  · Repository    │           │  query/heartbeat │
   └────────┬─────────┘                  └────────┬─────────┘           └──────────────────┘
            │ rank + forward                       │ resolve + execute
            ▼                                       ▼
   (mismo protocolo                        ┌──────────────────┐
    JSON-newline,                          │   DbCluster      │  ← port de persistencia
    register/heartbeat,                    │  write→primary   │
    {msg,result})                          │  read→réplicas   │──► Postgres primary
                                           │  health/metrics  │──► réplica 1 (otra máquina)
                                           │  lag-aware       │──► réplica N (otra máquina)
                                           └──────────────────┘
```

La idea clave: **nadie importa una dependencia concreta directamente**. El
composition root lee la config, construye los adaptadores concretos (un
`DbCluster` real, un `Logger` real, un `ClassLoader` real) y los **pasa por
constructor**. El Dispatcher y los BO solo conocen el **contrato** (el port), no
la implementación.

---

## 3. Tabla de smells

| Smell | Archivo:línea | Por qué duele |
| ----- | ------------- | ------------- |
| Singleton global con `static instance` | `BO_Servers/methodMapper.js:6-16` | Estado compartido a nivel proceso. Dos BO en el mismo proceso pisan el mismo `methodMap`. Imposible de aislar/mockear en test. |
| `import()` dinámico por cada request | `BO_Servers/methodResolver.js:20-23` | Cada RPC vuelve a resolver e importar el módulo de la clase. Trabajo repetido en el camino crítico; bajo carga, ruido innecesario. |
| Path de clases relativo hardcodeado | `BO_Servers/methodResolver.js:20` / `methodMapper.js:11-12` | `./class/${classKey}.js` y `path.resolve(__dirname,'./class')` clavados. No se puede apuntar a otro directorio de dominio sin editar código. |
| `new ClassRef()` en cada request | `methodResolver.js:31` + `methodMapper.js:43` | Se instancia la clase por request (y otra vez en el mapper). Acopla "qué métodos hay" con "instanciar para ejecutar". |
| Dos `Pool` eager creados al importar | `db/pool.js:13-23` | Efecto secundario en import: con solo importar el módulo ya abrís conexiones. No se puede inyectar, configurar por instancia ni cerrar limpio en test. |
| `default export` = `writePool` | `db/pool.js:32` | El "pool por defecto" es el de escritura: cualquiera que haga `import pool` arrastra el primary. Decisión read/write filtrada al import. |
| La clase de negocio importa el pool | `BO_Servers/class/Criminal.js:1` | `Criminal` decide read vs write (`writePool`/`readPool`) adentro. Mezcla SQL de dominio con topología de DB. No se puede testear con un repo falso. |
| Dispatcher importa `config` directo | `server/Dispatcher.js:3,10-11` | `new LoadBalancer(config.loadBalancer)` y `createLogger(config.log)` clavados en el constructor. No hay forma de inyectar un LB/logger/topología de prueba. |
| Logger global exportado | `shared/logger.js:70` | `export const logger = createLogger()` crea una instancia con defaults al importar. Coexiste con la instancia inyectada → dos canales de log posibles. |
| `console.error` suelto (sin canal) | `Dispatcher.js:26`, `BOServer.js:37,41`, `pool.js:29-30`, `methodMapper.js:24,57`, `methodResolver.js:42` | Errores y arranques van a `console` directo, fuera del logger estructurado. No se puede filtrar por nivel/tag ni redirigir el sink. |
| Config monolítica multi-concern | `shared/config.js:9-67` | Un solo objeto mezcla dispatcher, boServers, db, loadBalancer, loadTest y log. Cambiar un concern obliga a leer/tocar todo el archivo. |
| `_meta` mezclado en la respuesta | `Dispatcher.js:110-115` | El Dispatcher inyecta `_meta` en el mismo objeto que `{msg,result}`. El cliente tiene que ignorarlo a mano (`loadTest.js:155`). Contrato de transporte y de negocio mezclados, sin versión. |
| Resolución duplicada mapper/resolver | `methodMapper.js` + `methodResolver.js` | El mapper construye el `methodMap` y el resolver vuelve a importar y a buscar la key ignore-case. Dos lugares hacen lo mismo con dos caches distintos. |
| loadTest monolítico (462 funciones sueltas) | `client/loadTest.js:1-209` | Generación, selección de operación, stats, render y control de ritmo en un solo archivo con funciones sueltas. Cuesta leer qué fase hace qué y dónde se miden las métricas. |

---

## 4. Arquitectura objetivo hexagonal / screaming

La regla de oro: **el dominio y la orquestación dependen de PORTS (contratos),
nunca de adaptadores concretos.** Los adaptadores se construyen una sola vez, en
el composition root, y se inyectan hacia adentro.

### 4.1 Ports (contratos)

Cada port es una interfaz pequeña (en JS: una forma de objeto con métodos
acordados, documentada acá). No hay framework: el "contrato" es esta tabla + el
JSDoc del archivo.

| Port | Responsabilidad | Métodos del contrato | Adaptador concreto (hoy) |
| ---- | --------------- | -------------------- | ------------------------ |
| **MethodRegistry** | Saber qué clases/métodos existen y exponerlos | `has(className, method)`, `list()`, `resolveKey(className, method)` | reemplaza el `methodMap` del singleton `MethodMapper` |
| **ClassLoader** | Cargar (y cachear) una clase de dominio por nombre | `load(className) → ClassRef`, `instance(className) → obj` | reemplaza el `import()` por request de `methodResolver` |
| **CriminalRepository** | Persistencia del dominio criminal (CRUD), agnóstica de topología DB | `create`, `getById`, `list`, `search`, `update`, `remove` | hoy embebido en `Criminal.js`; pasa a recibir el `DbCluster` |
| **DbCluster** | Rutear cada query: writes→primary, reads→réplicas balanceadas + failover | `query(sql, params, { kind:'read'\|'write' })`, `health()`, `metrics()` | reemplaza `writePool`/`readPool` de `db/pool.js` |
| **Observability / Logger** | Canal único de eventos estructurados | `debug/info/warn/error(tag, msg)`, `route(...)`, `failover(...)`, `query(...)`, `heartbeat(...)` | extiende `shared/logger.js`; instancia única inyectada |

### 4.2 Quién depende de qué (dirección de las flechas)

```
composition root ──► construye adaptadores ──► inyecta ──┐
                                                          ▼
Dispatcher  depende de: LoadBalancer, Logger, Topology   (ports)
BOServer    depende de: MethodRegistry, ClassLoader,
                        CriminalRepository, Logger        (ports)
Criminal    depende de: CriminalRepository (o DbCluster)  (port)
DbCluster   depende de: Logger                            (port)
```

Ningún módulo de adentro (Dispatcher, BOServer, Criminal) hace `import` de un
adaptador concreto. Solo el composition root conoce los nombres concretos.

### 4.3 Screaming: qué grita la estructura

La estructura de carpetas debe **gritar el dominio y los ports**, no el
framework. Orientación (no obligatoria a la letra, pero esta es la intención):

```
src/
  domain/        Criminal (reglas), contratos de repo
  ports/         MethodRegistry, ClassLoader, CriminalRepository, DbCluster, Logger  (contratos + JSDoc)
  adapters/      PgDbCluster, FsClassLoader, MapMethodRegistry, AnsiLogger          (implementaciones)
  app/           Dispatcher, BOServer (orquestación; reciben ports)
  composition/   start.js / start-bo.js (arman y cablean todo)
```

> El punto no es la carpeta exacta, es que **al abrir el repo se entienda el
> sistema** (dominio + contratos) antes que la tecnología.

---

## 5. Items de refactor (R1–R11)

Cada item es autónomo salvo donde diga "depende de". El orden recomendado de
ejecución está en §7. Riesgo: BAJO / MEDIO / ALTO. Esfuerzo: S / M / L.

### R1 — Separar `shared/config.js` por concern

- **id:** R1
- **título:** Config por concern (un módulo por dominio de config)
- **problema:** `shared/config.js:9-67` es un objeto monolítico que mezcla
  dispatcher, boServers, db, loadBalancer, loadTest y log. Tocar un concern
  obliga a leer todo; y todos los módulos importan el objeto entero.
- **cambio propuesto:** dividir en módulos chicos por concern
  (`config/dispatcher.js`, `config/topology.js`, `config/db.js`,
  `config/loadBalancer.js`, `config/loadTest.js`, `config/log.js`) con un
  `config/index.js` que los componga. Cada módulo conserva el patrón env→default
  actual (`toPort`, etc.). Nadie de adentro importa `config`: el composition root
  toma de acá y pasa pedazos por constructor.
- **archivos:** `shared/config.js` → `shared/config/*.js`
- **riesgo:** BAJO
- **esfuerzo:** S
- **depende de:** —

### R2 — Inyección de dependencias en el Dispatcher

- **id:** R2
- **título:** DI por constructor en el Dispatcher (LoadBalancer / logger / config / topology)
- **problema:** `server/Dispatcher.js:3,10-11` importa `config` y construye
  `LoadBalancer` y el logger adentro. No se puede instanciar con dobles.
- **cambio propuesto:** el constructor recibe
  `new Dispatcher({ loadBalancer, logger, topology, dispatcherConfig })`. El
  composition root construye esas piezas y las inyecta. `resolveTargets` usa
  `topology` (la lista estática) en vez de `this.boServers` cableado a config.
  Mismo comportamiento de ranking/failover — solo cambia de dónde llegan las
  dependencias.
- **archivos:** `server/Dispatcher.js`, `start.js` (composition root)
- **riesgo:** BAJO
- **esfuerzo:** M
- **depende de:** R1 (necesita los slices de config para inyectarlos)

### R3 — Matar el singleton global `MethodMapper`

- **id:** R3
- **título:** `MethodRegistry` instanciable (sin `static instance`)
- **problema:** `BO_Servers/methodMapper.js:6-16` usa `static instance`: estado
  de proceso compartido, imposible de aislar. `methodResolver.js:4` hace
  `new MethodMapper()` esperando recuperar el singleton.
- **cambio propuesto:** convertir `MethodMapper` en un `MethodRegistry`
  instanciable (sin `static`), construido una vez por BO en el composition root e
  inyectado. El `methodMap` vive en la instancia, no en la clase. Conserva
  `has/list/resolveKey` (ignore-case) como contrato del port.
- **archivos:** `BO_Servers/methodMapper.js` (→ MethodRegistry),
  `BO_Servers/methodResolver.js`, `BO_Servers/server/BOServer.js`
- **riesgo:** MEDIO
- **esfuerzo:** M
- **depende de:** —

### R4 — Pool factory (sin singletons eager en `db/pool.js`)

- **id:** R4
- **título:** Factory de pools (construcción explícita, sin efecto en import)
- **problema:** `db/pool.js:13-23` crea dos `Pool` **al importarse el módulo**.
  Efecto secundario en import; `default export` es el write pool
  (`db/pool.js:32`). No se puede inyectar config por instancia ni cerrar limpio.
- **cambio propuesto:** exponer una **factory** `createPool(opts)` /
  `createPools(dbConfig) → { primary, replicas }` que el composition root invoca
  explícitamente. Sin top-level `new Pool`. El listener de `error` se registra en
  la factory. El `DbCluster` (R9) consume estos pools por inyección.
- **archivos:** `db/pool.js`
- **riesgo:** MEDIO
- **esfuerzo:** S
- **depende de:** R1 (config de db separada)

### R5 — Cachear clases (sin `import()` por request)

- **id:** R5
- **título:** `ClassLoader` con cache (resolución una vez, no por RPC)
- **problema:** `BO_Servers/methodResolver.js:20-23` hace `import()` dinámico en
  **cada** request, más `new ClassRef()` (línea 31) por request.
- **cambio propuesto:** un `ClassLoader` que carga e instancia cada clase una
  vez (al arrancar o lazy-en-primer-uso) y cachea la referencia/instancia. El
  resolver de request solo consulta el cache. Elimina I/O de import del camino
  crítico. Mantiene el binding ignore-case actual.
- **archivos:** `BO_Servers/methodResolver.js` (→ ClassLoader),
  `BO_Servers/methodMapper.js`
- **riesgo:** MEDIO
- **esfuerzo:** M
- **depende de:** R3 (comparte el registro de clases)

### R6 — Path de clases configurable

- **id:** R6
- **título:** Directorio de dominio inyectable
- **problema:** el directorio de clases está clavado: `methodMapper.js:11-12`
  (`path.resolve(__dirname,'./class')`) y `methodResolver.js:20`
  (`./class/${classKey}.js`).
- **cambio propuesto:** `classesPath` (o `domainDir`) entra por config (R1) y se
  inyecta al `MethodRegistry`/`ClassLoader`. Permite apuntar a otro dominio sin
  editar código. Default = el `class/` actual, para no romper nada.
- **archivos:** `BO_Servers/methodMapper.js`, `BO_Servers/methodResolver.js`,
  `shared/config/*` 
- **riesgo:** BAJO
- **esfuerzo:** S
- **depende de:** R3, R5 (los consumidores del path)

### R7 — Inyectar el repositorio en `Criminal`

- **id:** R7
- **título:** `Criminal` recibe `CriminalRepository` (no importa el pool)
- **problema:** `BO_Servers/class/Criminal.js:1` importa `writePool`/`readPool`
  y decide read vs write adentro de cada método. SQL de dominio mezclado con
  topología de DB.
- **cambio propuesto:** extraer un `CriminalRepository` (port) que hable con el
  `DbCluster` (R9). `Criminal` recibe el repo por constructor (inyectado por el
  `ClassLoader`/composition root) y queda solo con reglas de dominio + forma
  `{msg,result}`. El repo decide `kind:'read'|'write'` y delega el ruteo al
  cluster.
- **archivos:** `BO_Servers/class/Criminal.js`, nuevo
  `CriminalRepository`, `BO_Servers/server/BOServer.js`
- **riesgo:** MEDIO
- **esfuerzo:** M
- **depende de:** R4, R9 (el repo necesita el cluster), R5 (el loader inyecta el repo)

### R8 — Sacar `_meta` del protocolo de negocio (ALTO — va último y aislado)

- **id:** R8
- **título:** Separar transporte/metadata del payload de negocio + versionar el contrato
- **problema:** `Dispatcher.js:110-115` mezcla `_meta` con `{msg,result}` en el
  mismo objeto; el cliente lo ignora a mano (`loadTest.js:155`). El contrato
  cliente↔dispatcher no tiene versión: cualquier cambio rompe en silencio.
- **cambio propuesto:** definir un **sobre (envelope) versionado** que separe la
  carga de negocio de la metadata de ruteo, p.ej.
  `{ v: 1, payload: { msg, result }, meta: { servedBy, rank, attempts } }`, o un
  canal de metadata fuera del cuerpo de negocio. El cliente lee `meta` de un
  lugar explícito, no "ignorando un campo". **Cambia un contrato observable**:
  por eso va **último, aislado, y con número de versión** para poder convivir con
  clientes viejos durante la transición.
- **archivos:** `server/Dispatcher.js`, `client/ClientRSI.js`,
  `client/loadTest.js`, contrato documentado en §8
- **riesgo:** ALTO
- **esfuerzo:** M
- **depende de:** todos los anteriores (se hace al final, sobre base ya desacoplada)

### R9 — DbCluster (versión COMPLETA / avanzada)

- **id:** R9
- **título:** `DbCluster` — ruteo de queries write/read con health, métricas y lag-aware
- **problema:** hoy `db/pool.js` expone dos pools fijos (`writePool`/`readPool`)
  y `Criminal.js` elige cuál usar a mano. No hay balanceo entre N réplicas, ni
  health checks, ni failover de lectura, ni conciencia de lag de replicación.
- **cambio propuesto:** un componente **`DbCluster`** que es un port de
  persistencia desacoplado. Mira cada query y rutea:
  - **writes → primary** (siempre).
  - **reads → balanceados round-robin entre N réplicas** (en máquinas distintas),
    con **failover** a otra réplica (y al primary como último recurso) si una cae.
  - **Versión COMPLETA / avanzada** (lo que se documenta acá; la mínima va
    aparte): 
    - **Health checks** activos por réplica (ping periódico; réplica unhealthy
      sale del pool de lectura, igual que el LB saca BO stale).
    - **Métricas por réplica:** queries/seg, latencia, errores, estado
      (sano/degradado/caído) — expuestas vía `metrics()` y logueadas (R10).
    - **Lag-aware:** una réplica con replication lag por encima de un umbral se
      penaliza o se saca de lecturas que requieran datos frescos; lecturas
      "tolerantes a lag" pueden seguir usándola. El umbral es configurable.
  - **Contrato:** `query(sql, params, { kind })`, `health()`, `metrics()`.
  - **Reusa el patrón del LB:** round-robin + failover + stale-detection son
    conceptualmente lo mismo que el balanceo de BO; la lógica se inspira en
    `server/LoadBalancer.js` pero NO se acopla a él.
- **NOTA:** una **versión mínima de R9 se implementa ahora** (writes→primary,
  reads→round-robin simple). Lo que está documentado en este item es la
  **versión completa/avanzada** (health checks, métricas por réplica,
  lag-aware), para retomar.
- **archivos:** `db/pool.js` (factory, R4), nuevo `db/DbCluster.js`,
  `BO_Servers/class/Criminal.js` (vía repo, R7), `shared/config/db.js`
- **riesgo:** ALTO
- **esfuerzo:** L
- **depende de:** R4 (factory de pools), R10 (para loguear el ruteo de DB)

### R10 — Logging estructurado de TODO

- **id:** R10
- **título:** Canal de observabilidad único — loguear cada ruteo, failover, query, heartbeat
- **problema:** hay `console.error` sueltos fuera del logger (`Dispatcher.js:26`,
  `BOServer.js:37,41`, `pool.js:29-30`, `methodMapper.js:24,57`,
  `methodResolver.js:42`) y un logger global redundante (`logger.js:70`). El log
  estructurado existe (`route`, `failover`) pero no cubre query/heartbeat/DB.
- **cambio propuesto:** extender `shared/logger.js` para que **TODO** evento
  releva­nte pase por el logger inyectado, con contexto:
  - `logger.route(...)` y `logger.failover(...)` — ya existen, se mantienen.
  - **nuevos helpers:** `logger.query({ kind, replica, ms, rows, error })`,
    `logger.heartbeat({ serverId, inFlight, rps })`,
    `logger.dbRoute({ kind, target, reason })`,
    `logger.dbFailover({ from, to, error })`.
  - Eliminar `console.*` sueltos → reemplazar por el logger inyectado.
  - Eliminar el `export const logger = createLogger()` global: **una sola
    instancia**, la inyectada por el composition root.
  - El **muestreo lo decide el llamador** (igual que hoy en `Dispatcher.logRouteDecision`),
    no el logger.
- **archivos:** `shared/logger.js`, y todos los call-sites de `console.*`
  listados arriba
- **riesgo:** BAJO
- **esfuerzo:** M
- **depende de:** R2 (logger inyectado en Dispatcher), R9 (eventos de DbCluster a loguear)

### R11 — Test pesado entendible

- **id:** R11
- **título:** Refactor de `client/loadTest.js` para que se lea solo
- **problema:** `client/loadTest.js:1-209` es un archivo monolítico de funciones
  sueltas (generación, selección de operación, stats, render, control de ritmo).
  Cuesta ver las **fases** y dónde se miden las métricas.
- **cambio propuesto:** refactor por **responsabilidad y fase**, sin cambiar la
  carga que genera:
  - Módulos chicos: `loadgen/operationMix.js` (qué operación y por qué),
    `loadgen/rateController.js` (control de ritmo por ventanas),
    `loadgen/stats.js` (acumulación + percentiles),
    `loadgen/dashboard.js` (render).
  - **Fases nombradas y explícitas:** `warmup → ramp → sustain → drain → report`.
  - **Métricas explicadas:** cada métrica con un nombre claro y un comentario de
    qué mide y por qué importa (p.ej. por qué `p99` y no promedio).
  - Naming autoexplicativo: `virtualClients`, `targetRps`, `readWriteRatio`,
    `servedBy` — nada de abreviaturas crípticas.
- **archivos:** `client/loadTest.js` → `client/loadgen/*.js`
- **riesgo:** BAJO
- **esfuerzo:** M
- **depende de:** R8 (lee `meta.servedBy` del nuevo contrato), R10 (consume el logger)

### R12 — Topología declarativa avanzada

- **id:** R12
- **título:** Topología declarativa avanzada — descubrimiento, salud, hot-reload, validación y generación multi-target
- **problema:** la **versión mínima de topología se implementa ahora**
  (`topology.json` como fuente única + `tools/topogen.js` que genera el `.env` +
  `tools/up.js` que levanta el stack). Esa versión declara la topología a mano y
  solo genera `.env`. Le falta todo lo "vivo": las máquinas se enumeran a mano
  (un host nuevo no aparece solo), no se chequea que los nodos declarados estén
  realmente arriba antes de lanzar, un cambio en `topology.json` exige reiniciar
  a mano, no hay validación (dos BO pueden pedir el mismo puerto, un host puede
  estar caído o un `id` de BO duplicado y nadie avisa hasta que rompe), solo se
  emite `.env` (nada de systemd/pm2/docker-compose) y el `--machine` se elige a
  dedo (frágil si la laptop tiene varias NICs o cambia de IP).
- **cambio propuesto:** elevar `topology.json` de "archivo que genera un `.env`" a
  un **plano operativo declarativo** del cluster. Este item es el **superconjunto
  de futuro** sobre la versión mínima; no la reemplaza, la extiende:
  - **Auto-descubrimiento de máquinas:** además de la lista estática, descubrir
    nodos en la LAN (p.ej. mDNS/`_rsi._tcp`, barrido de un rango configurable, o
    un registro liviano al que cada host se anuncia). Una máquina nueva entra a
    la topología sin editar el JSON; el descubrimiento es **aditivo** y nunca
    pisa lo declarado a mano.
  - **Health/liveness de nodos declarados antes de lanzar:** `tools/up.js`
    (o un `tools/doctor.js`) hace un **preflight**: por cada nodo declarado
    (dispatcher, BO, primary, réplicas) verifica que el host responde y el puerto
    está libre/alcanzable antes de arrancar. Si un nodo está caído, avisa con
    contexto (qué nodo, qué host:puerto, por qué) en vez de fallar a mitad del
    boot. Reusa conceptualmente el stale-detection del LB y el `health()` del
    DbCluster (R9), sin acoplarse a ellos.
  - **Hot-reload de la topología:** observar `topology.json` (watch) y aplicar
    cambios **sin reiniciar** todo el stack: agregar/quitar un BO o una réplica
    re-genera los artefactos afectados y notifica a los procesos vivos (señal o
    canal de control) para que recarguen su vista de topología. Lo que no cambió
    no se reinicia.
  - **Validación (lint de topología):** un validador que corre antes de generar y
    detecta: **choques de puerto** (dos nodos en el mismo host:puerto), **hosts
    inalcanzables** (DNS no resuelve / ping/TCP falla), **`id` de BO duplicados**,
    réplicas apuntando a un primary inexistente, y referencias colgadas
    (dispatcher hacia un BO que no existe). Falla temprano con mensaje claro,
    nunca genera artefactos a partir de una topología inválida.
  - **Generación multi-target (no solo `.env`):** a partir del mismo
    `topology.json`, `topogen` emite además **unidades de servicio** por target:
    `systemd` (un `.service` por proceso, con `WantedBy`/restart), **pm2**
    (`ecosystem.config.js` con los apps y sus envs) y **docker-compose**
    (servicios, redes, `depends_on`, healthchecks). El `.env` sigue siendo un
    target más; el formato de salida se elige por flag/config. Una sola fuente de
    verdad, N formas de desplegar.
  - **`--machine` auto-detect robusto:** detectar cuál nodo de la topología
    corresponde a *esta* máquina sin pasarlo a mano, **robusto entre NICs**:
    enumerar todas las interfaces y sus IPs (IPv4/IPv6, descartando loopback y
    link-local), hacer match contra los hosts declarados, y resolver hostnames a
    IP para comparar. Si hay ambigüedad (varias NICs matchean, o ninguna),
    avisa y pide `--machine` explícito en vez de adivinar mal.
- **NOTA:** la **versión mínima** (`topology.json` + `tools/topogen.js` +
  `tools/up.js`, solo `.env`, lista estática, sin preflight) **se implementa
  ahora**. Lo documentado en este item es la **versión completa/avanzada**, para
  retomar — mismo patrón que R9 (mínimo ahora, avanzado después).
- **archivos:** `topology.json` (fuente única), `tools/topogen.js` (→ multi-target),
  `tools/up.js` (→ preflight + hot-reload), nuevo `tools/doctor.js`
  (validación/health), `shared/config/topology.js` (R1), `start.js` /
  `start-bo.js` (consumen la topología; recargan en hot-reload)
- **riesgo:** ALTO
- **esfuerzo:** L
- **depende de:** R1 (config de topología separada), R2 (Dispatcher recibe la
  topología por inyección), R9 (reusa el patrón health/failover; valida réplicas),
  R10 (loguea descubrimiento, preflight, recargas y validación)

---

## 6. Principios / criterios de aceptación

Los 6 principios de Eliab, como **criterios verificables** (no buenas
intenciones). Para cada uno, **cómo se verifica que se cumplió**.

### P1 — Buen logging de TODO

> Cada decisión y evento del sistema queda registrado con contexto.

**Cómo se verifica:**
- `rg 'console\.(log|error|warn)' --type js` sobre el código de runtime devuelve
  **cero** resultados fuera de `shared/logger.js` y del composition root.
- Correr una request end-to-end produce líneas estructuradas para: ruteo de BO
  (`[ROUTE]`), ruteo de DB (`[DB]`), query (`[QUERY]` con `kind/replica/ms`),
  heartbeat (`[HEARTBEAT]`), y failover si ocurre (`[FAILOVER]`).
- Cada línea incluye `reqId`/contexto identificable.
- Existe **una sola** instancia de logger en todo el proceso (no hay
  `export const logger` global).

### P2 — SRP (una responsabilidad por módulo)

> Cada archivo hace una sola cosa.

**Cómo se verifica:**
- `Criminal.js` no importa pools de DB (`rg 'writePool|readPool' BO_Servers/class/Criminal.js` → vacío).
- El ruteo read/write vive **solo** en `DbCluster`, no en la clase de dominio.
- `MethodRegistry` (qué métodos hay) y `ClassLoader` (cargar/instanciar) son
  módulos separados; ninguno hace `import()` por request.
- La config está partida por concern (R1): ningún módulo importa el objeto
  `config` entero.

### P3 — Código autoexplicativo (naming + módulos chicos + cero magia, sin framework de DI)

> Se entiende leyéndolo, sin documentación externa.

**Cómo se verifica:**
- **No hay framework de DI**: `rg 'inversify|tsyringe|awilix|typedi'` → vacío. La
  inyección es manual, por constructor, en el composition root.
- Los nombres dicen lo que hacen: `DbCluster.query(sql, params, { kind })`,
  `MethodRegistry.has(className, method)` — sin abreviaturas crípticas.
- Ningún archivo de runtime supera ~120 líneas (los actuales que lo superan se
  parten en R1/R11).
- Un lector nuevo puede trazar una request leyendo el composition root + los
  ports, sin grep a ciegas.

### P4 — Buena DX (un comando para generar, errores con línea, setup trivial)

> Levantar y operar el proyecto es trivial.

**Cómo se verifica:**
- Un comando levanta el stack (`docker compose up -d` + `node start.js`) y otro
  una réplica (`node start-bo.js`), documentado en el README/§A.
- Los errores de runtime incluyen **archivo:línea o contexto** (no `console.error`
  pelado): un error de DB dice qué query, qué réplica y el mensaje.
- Setup desde cero (clone → run) está en un solo lugar y no requiere editar
  código (solo env): se verifica siguiendo el §A en una máquina limpia.

> **Futuro (VSCode/DX):** un **LSP de Nivel 3** (autocompletado, go-to-def, hover
> sobre clases/métodos/ports de RSI) es trabajo a futuro, construido **encima de
> la extensión de Nivel 2**.

### P5 — Test pesado entendible

> El load test se lee solo y explica qué mide.

**Cómo se verifica:**
- `loadTest` está partido por fase (`warmup/ramp/sustain/drain/report`) y por
  responsabilidad (operationMix / rateController / stats / dashboard).
- Cada métrica del dashboard tiene un nombre claro y un comentario de qué mide.
- Un lector que nunca vio el test entiende, leyendo los nombres de fase, qué
  hace cada etapa sin abrir la implementación.

### P6 — Despliegue / levantar en 1 o N laptops trivial

> Mismo código corre en una máquina o en N, solo cambiando env.

**Cómo se verifica:**
- Levantar todo en **una** laptop: defaults de config (localhost) funcionan sin
  editar nada (`node start.js` + N×`node start-bo.js` con puertos distintos).
- Levantar en **N** laptops: solo se setean envs (`DISPATCHER_HOST`, `BO_n_HOST`,
  `DB_HOST`, réplicas) — **cero** cambios de código. Se verifica con el §A en dos
  máquinas.
- El composition root es el **único** lugar donde la topología se materializa:
  cambiar de 1 a N máquinas no toca dominio ni adaptadores.

---

## 7. Grafo de dependencias + secuencia por fases

### 7.1 Grafo de dependencias entre items

```
R1 (config split) ──┬─► R2 (DI Dispatcher) ──────────────────┐
                    └─► R4 (pool factory) ──► R9 (DbCluster) ─┤
                                                              │
R3 (MethodRegistry) ──► R5 (ClassLoader) ──► R6 (path cfg)    │
        │                      │                              │
        └──────────────────────┴──► R7 (repo en Criminal) ◄──┘ (necesita R9)
                                                              
R2 ─┐
R9 ─┴─► R10 (logging de todo) ──► R11 (test entendible) ──► R8 (sacar _meta, ALTO, último)
```

### 7.2 Secuencia por fases (orden de ejecución recomendado)

| Fase | Items | Objetivo | Por qué en este orden |
| ---- | ----- | -------- | --------------------- |
| **F0 — Cimientos de config** | R1 | Partir config por concern | Todo lo demás necesita inyectar slices de config. Riesgo bajo, no cambia comportamiento. |
| **F1 — Desacople de carga de clases** | R3, R5, R6 | MethodRegistry instanciable + ClassLoader cacheado + path configurable | Saca singletons e `import()` por request del lado BO. Independiente de la DB. |
| **F2 — Desacople de DB** | R4, R9(mín), R7 | Factory de pools + DbCluster (mínimo) + repo inyectado en Criminal | Saca el pool de la clase de dominio. R9 mínimo ahora; avanzado documentado. |
| **F3 — DI del Dispatcher** | R2 | Dispatcher recibe ports por constructor | Cierra la inyección del lado server. |
| **F4 — Observabilidad total** | R10 | Logging estructurado de todo, una sola instancia | Necesita R2 (logger inyectado) y R9 (eventos de DB). |
| **F5 — Test entendible** | R11 | loadTest por fases y responsabilidades | Consume el logger (R10). |
| **F6 — Contrato versionado (ALTO)** | R8 | Sacar `_meta`, versionar el envelope | **Último y aislado**: cambia un contrato observable. Se hace sobre base ya desacoplada. |
| **F7 — DbCluster avanzado** | R9(full) | Health checks, métricas por réplica, lag-aware | Encima del DbCluster mínimo, cuando la base esté estable. |

---

## 8. Contratos que no deben romperse sin querer

Estos contratos son **observables** (cliente, BO, otros procesos dependen de
ellos). Cambiarlos sin versión rompe en silencio. R8 los versiona; el resto de
los items NO debe tocarlos.

### 8.1 Respuesta de negocio — `{ msg, result }`

Forma de toda respuesta de BO. `ClientRSI.parseBOResponse` y el `loadTest`
dependen de ella. No cambiar las claves ni los tipos. Hoy convive con `_meta` en
el mismo objeto (`Dispatcher.js:110-115`) — **eso** es lo que R8 separa y
versiona, sin tocar `{msg,result}` en sí.

```js
{ msg: 'Criminal created', result: { /* fila */ } }
```

### 8.2 Payload RPC — `{ className, method, args }`

Lo que el cliente manda y el BO ejecuta por reflexión
(`BOServer.handleRequest`, `methodResolver`). El Dispatcher lo reenvía como
`{ type:'rpc', method, className, args }` (`Dispatcher.js:67`). No renombrar
`method`/`args`/`className`.

```js
{ type: 'rpc', className: 'Criminal', method: 'getById', args: { id: 7 } }
```

### 8.3 Framing — JSON delimitado por newline

`shared/jsonStream.js` enmarca cada mensaje como JSON + `\n`. Todo el transporte
(cliente↔dispatcher↔BO, register/heartbeat) usa este framing. No cambiar el
delimitador ni el encoding.

### 8.4 Mensajes de control — `register` / `heartbeat`

Protocolo del Load Balancer (`docs/load-balancer.md §4.2`). El BO abre conexión
persistente, manda `register` (capacidad estática, una vez) y `heartbeat`
periódicos. **No se toca** (ver No-goals). El Dispatcher ramifica por `type`
(`Dispatcher.js:39-52`).

```js
{ type: 'register', serverId, className, host, port, caps: { cpuCores, cpuSpeed, totalMem } }
{ type: 'heartbeat', serverId, metrics: { freeMem, inFlight, rps, cpuUtil } }
```

> **Compatibilidad hacia atrás:** un mensaje sin `type` se trata como `rpc`
> (`Dispatcher.js:40`). Mantener este default mientras R8 introduce el envelope
> versionado, para no romper clientes viejos.

---

## 9. No-goals (qué NO se hace)

- **Sin TypeScript ni bundler.** El proyecto sigue en JS/ESM puro. Los "contratos"
  son JSDoc + esta spec, no tipos compilados.
- **Sin framework de DI** (inversify, tsyringe, awilix, typedi…). La inyección es
  **manual**, por constructor, en el composition root. Cero magia/decoradores.
- **No se toca el scoring del LB.** La fórmula de `rank()` (`docs/load-balancer.md §5`)
  y los pesos quedan igual. R2 solo cambia cómo se inyecta el LB, no cómo puntúa.
- **No se toca el protocolo de heartbeat.** `register`/`heartbeat`, intervalo,
  stale timeout y conexión persistente quedan como están.
- **No se agregan features de negocio.** El dominio criminal (CRUD) no crece: no
  hay campos nuevos, ni endpoints nuevos, ni reglas nuevas. Esto es refactor
  estructural, no producto.
- **No se cambia el algoritmo de balanceo de BO.** El DbCluster (R9) reutiliza el
  *patrón* round-robin/failover, pero es un componente aparte; no modifica el LB.

---

## 10. Apéndice A — Cómo retomar

### A.1 Orden de lectura (para volver a context)

1. Este archivo (`docs/refactor-decouple.md`) — el plan.
2. `docs/load-balancer.md` — diseño del LB (no se toca, pero R9 se inspira en él).
3. `docs/plan-definitiva.md` — BO único + Postgres + load test (el estado base).

### A.2 Orden de ejecución (resumen de §7)

```
F0 R1  →  F1 R3,R5,R6  →  F2 R4,R9(mín),R7  →  F3 R2  →  F4 R10  →  F5 R11  →  F6 R8 (ALTO)  →  F7 R9(full)
```

Regla: **R8 va último** (cambia contrato observable). El **DbCluster avanzado**
(R9 full) va al final, sobre el mínimo ya estable.

### A.3 Archivos críticos (dónde mirar primero)

| Archivo | Qué tiene | Items que lo tocan |
| ------- | --------- | ------------------ |
| `shared/config.js` | Config monolítica a partir | R1 |
| `server/Dispatcher.js` | Orquestación, ruteo, `_meta` | R2, R8, R10 |
| `BO_Servers/methodMapper.js` | Singleton global del registro | R3, R5, R6 |
| `BO_Servers/methodResolver.js` | `import()` por request, path clavado | R5, R6 |
| `BO_Servers/server/BOServer.js` | Server BO; cablea registry/loader/repo | R3, R5, R7 |
| `db/pool.js` | Pools eager singletons | R4, R9 |
| `BO_Servers/class/Criminal.js` | Dominio que importa el pool | R7, R9 |
| `shared/logger.js` | Logger (global redundante) | R10 |
| `client/loadTest.js` | Test pesado monolítico | R11 |
| `start.js` / `start-bo.js` | Composition root (cablea todo) | R2, R4, R5, R7, R10 |

### A.4 Checklist de "no rompí nada" antes de cerrar cada fase

- [ ] `{msg,result}` intacto (§8.1).
- [ ] Payload `{className,method,args}` intacto (§8.2).
- [ ] Framing JSON-newline intacto (§8.3).
- [ ] `register`/`heartbeat` intactos (§8.4).
- [ ] Mensaje sin `type` sigue tratándose como `rpc`.
- [ ] El criterio de aceptación del/los principio(s) de la fase (§6) se verifica.

---

> **Siguiente paso al retomar:** arrancar por **F0 (R1)** — partir
> `shared/config.js` por concern. Riesgo bajo, no cambia comportamiento, y
> desbloquea la inyección de todo lo demás.
