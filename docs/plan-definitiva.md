# Plan — RSI Definitiva: BO único contra Postgres + prueba de carga del Load Balancer

> Documento de planificación. **No es implementación.** Define los cambios, la
> topología, los contratos y las fases para la versión definitiva del proyecto.
> Rama: `definitiva` (basada en `cositas`, que ya tiene el Load Balancer
> embebido, heartbeat y failover funcionando y verificados).

---

## 1. Objetivo

Pasar de los dos BO de demo (Calculator / Equations, en memoria) a **un único BO
real** que hace CRUD de **criminales** sobre **PostgreSQL**, **replicado 3 veces
en 3 máquinas**, para **probar de verdad el balanceador de carga** bajo miles de
peticiones por segundo, con **logs formateados** que muestren el comportamiento
del ruteo (qué cliente, a qué BO, por qué).

Tres pilares:

1. **BO único + Postgres (Docker + Adminer).** Reemplaza Calculator/Equations.
2. **3 réplicas distribuidas** del mismo BO (config por IP) contra la misma DB.
3. **Cliente de carga + observabilidad**: miles de req/s, dashboard agregado en
   vivo + stream muestreado de decisiones de ruteo.

---

## 2. Qué se mantiene, qué se va, qué entra

| Componente | Acción | Detalle |
| ---------- | ------ | ------- |
| `server/LoadBalancer.js` | **Se mantiene** + extiende | rank() devuelve también `score` y `reason` para loggear el "por qué". |
| `server/Dispatcher.js` | **Se mantiene** + extiende | ramificación por type, failover en cascada; agrega logging de ruteo y `_meta` en la respuesta. |
| `BO_Servers/MetricsCollector.js` | **Se mantiene** | sin cambios. |
| `BO_Servers/HeartbeatClient.js` | **Se mantiene** | sin cambios (sirve para cualquier BO). |
| `BO_Servers/methodMapper.js` / `methodResolver.js` | **Se mantiene** | la reflexión RPC sigue igual; cambia el set de clases. |
| `shared/jsonStream.js` | **Se mantiene** | protocolo `\n`-delimitado. |
| BO Calculator / Equations (`class/`, `method/`, `server/*Server.js`) | **Se va** | reemplazados por un BO genérico + `CriminalService`. |
| Proxies de cliente (`ProxyCalculator`, `ProxyEquations`) | **Se va / reemplaza** | por `ProxyCriminal`. |
| `ClientRSI.js` | **Se mantiene** + extiende | agrega `clientId` al payload y lee `_meta` de la respuesta. |
| **Postgres + Adminer** | **Entra** | `docker-compose.yml` + esquema + seed. |
| **BO genérico (`BOServer`)** | **Entra** | un solo server, instanciable N veces, con pool `pg`. |
| **`shared/logger.js`** | **Entra** | logging formateado con ANSI, niveles y tags por componente. |
| **`client/loadTest.js`** | **Entra** | generador de carga + dashboard + stream muestreado. |
| Dependencia `pg` | **Entra** | driver de PostgreSQL (pool). |

---

## 3. Topología

Máquina principal **M0** corre cliente(s) + dispatcher + DB; las réplicas del BO
viven en **M1/M2/M3**, todas apuntando al mismo Postgres de M0.

```
                         ┌──────────────────────── M0 (principal) ────────────────────────-┐
                         │                                                                 │
   loadTest.js  ──RPC──► │  Dispatcher (:3000)  ──► LoadBalancer (rank + reason)           │
   (miles req/s,         │      ▲  logs de ruteo (dashboard + stream muestreado)           │
    N clientes virt.)    │      │ heartbeat (register + métricas) de cada BO               │
                         │                                                                 │
                         │  Docker:  Postgres (:5432, expuesto a LAN)  +  Adminer (:8080)  │
                         └─────────────────────────────────────────────────────────────────┘
                                 ▲ forward (rank 1, failover 2,3)   ▲ TCP 5432 (consultas SQL)
                                 │                                  │
        ┌────────────────────────┼──────────────────-┬──-───────────┴──────────────-─┐
        │                        │                   │                               │
   ┌────┴─────┐            ┌─────┴────┐        ┌─────┴────┐                          │
   │  M1      │            │  M2      │        │  M3      │                          │
   │ BOServer │            │ BOServer │        │ BOServer │   (mismo código,         │
   │ bo-1     │            │ bo-2     │        │ bo-3     │    distinto id/host)     │
   │ pg pool ─┼────────────┼─ pg pool─┼────────┼─ pg pool─┼────────────────────────--┘
   └──────────┘            └──────────┘        └──────────┘   todos → Postgres de M0
```

Notas de red:
- Postgres se expone en la LAN (`0.0.0.0:5432`) y `pg_hba.conf` permite el rango
  de la subred. Los 3 BO usan `DB_HOST = IP_de_M0`.
- El Dispatcher hace forward a `host:port` de cada BO (M1/M2/M3) según el ranking.
- El heartbeat de cada BO viaja a `M0:3000` (mismo socket persistente del LB).

---

## 4. Base de datos

### 4.1 `docker-compose.yml` (en M0)

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: rsi
      POSTGRES_PASSWORD: rsi
      POSTGRES_DB: criminals
    ports:
      - "0.0.0.0:5432:5432"        # expuesto a la LAN para M1/M2/M3
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d   # esquema + seed al crear
  adminer:
    image: adminer:latest
    ports:
      - "8080:8080"
volumes:
  pgdata:
```

### 4.2 Esquema — `db/init/01_schema.sql`

```sql
CREATE TABLE IF NOT EXISTS criminals (
  id           SERIAL PRIMARY KEY,
  full_name    TEXT        NOT NULL,
  alias        TEXT,
  nationality  TEXT,
  crime        TEXT        NOT NULL,
  danger_level SMALLINT    NOT NULL DEFAULT 1 CHECK (danger_level BETWEEN 1 AND 5),
  captured     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_criminals_alias ON criminals (alias);
```

### 4.3 Seed — `db/init/02_seed.sql`

Insertar ~50–100 criminales de ejemplo para que las lecturas por id/búsqueda
tengan contra qué pegar desde el primer arranque. (Datos ficticios.)

### 4.4 Acceso

- **Adminer**: `http://M0:8080` (system: PostgreSQL, server: `db`, user/pass `rsi`).
- **DB directa**: `postgres://rsi:rsi@M0:5432/criminals`.

---

## 5. BO único contra Postgres

### 5.1 `BOServer` genérico — `BO_Servers/server/BOServer.js`

Un solo server, instanciable N veces (`new BOServer({ id, host, port })`),
reemplaza a Calculator/EquationServer. Mantiene:
- `MetricsCollector` (in-flight, rps EWMA, caps).
- `HeartbeatClient` (register + heartbeat al Dispatcher).
- `handleRequest` con reflexión (`resolveClassInstance`).
- **Nuevo**: crea un **pool `pg`** compartido (`new Pool({ host: DB_HOST, ... })`)
  y lo inyecta en el `CriminalService`.

### 5.2 `CriminalService` — `BO_Servers/class/Criminal.js`

Clase de negocio expuesta por reflexión (`className: 'Criminal'`). Métodos =
operaciones RPC, cada una usa el pool `pg`:

| Método | Args | SQL |
| ------ | ---- | --- |
| `create` | `{ full_name, alias, nationality, crime, danger_level }` | `INSERT ... RETURNING *` |
| `getById` | `{ id }` | `SELECT * WHERE id=$1` |
| `list` | `{ limit=20, offset=0 }` | `SELECT ... LIMIT $1 OFFSET $2` |
| `search` | `{ q }` | `SELECT ... WHERE full_name ILIKE $1 OR alias ILIKE $1` |
| `update` | `{ id, ...campos }` | `UPDATE ... WHERE id=$1 RETURNING *` |
| `remove` | `{ id }` | `DELETE ... WHERE id=$1` |

Respuesta uniforme: `{ msg, result }` (igual que hoy) para no romper
`ClientRSI.parseBOResponse`.

> El mecanismo de reflexión (`methodMapper`/`methodResolver`) se mantiene: solo
> cambia el directorio de clases (queda `Criminal`, se quitan Calculator/Equations).
> A confirmar: si el pool se inyecta por constructor del service o se toma de un
> singleton del módulo (ver §11).

### 5.3 Arranque del BO — `start-bo.js`

Script para levantar **una** réplica en su máquina:
```
node start-bo.js --id bo-2 --port 4001
# o por env: BO_ID=bo-2 BO_PORT=4001 DB_HOST=192.168.0.10 node start-bo.js
```
Lee `DB_HOST`/credenciales de env (cada máquina apunta al Postgres de M0).

---

## 6. Configuración — `shared/config.js`

```js
boServers: {
  Criminal: [
    { id: 'bo-1', host: '192.168.0.21', port: 4001 },
    { id: 'bo-2', host: '192.168.0.22', port: 4001 },
    { id: 'bo-3', host: '192.168.0.23', port: 4001 },
  ],
},
db: {
  host: process.env.DB_HOST || '192.168.0.10', // IP de M0
  port: 5432, user: 'rsi', password: 'rsi', database: 'criminals',
  max: 10, // tamaño del pool por réplica
},
loadBalancer: { /* heartbeatIntervalMs, staleTimeoutMs, weights — ya existe */ },
loadTest: {
  targetRps: 2000, durationSec: 30, virtualClients: 50,
  readWriteRatio: 0.9,        // 90% lecturas, 10% escrituras
  sampleEvery: 200,           // loggear 1 de cada 200 decisiones de ruteo
  dashboardIntervalMs: 500,
},
log: { level: 'info', color: true, routingStream: true },
```

> El Dispatcher mapea `className → boServers.Criminal`. Se elimina el split
> Calculator/Equations.

---

## 7. Dispatcher + LB: exponer y loggear el "porqué"

### 7.1 `LoadBalancer.rank()` enriquecido

Hoy devuelve `[{ rank, id, host, port }]`. Se agrega el detalle del scoring:

```js
{ rank: 1, id: 'bo-2', host, port,
  score: 0.8731,
  reason: 'mayor score del cluster',
  snapshot: { capacity: 0.74, inFlight: 12, rps: 240.5, cpuUtil: 0.31, freeMemPct: 0.62 } }
```

Casos de `reason`: `mayor score del cluster`, `único sano`, `fallback estático
(sin heartbeats)`, `failover: rank N (anteriores cayeron)`.

### 7.2 Logging de ruteo en el Dispatcher

En cada `rpc`, tras elegir destino, emite (según muestreo) una línea:

```
[ROUTE] req #128443 · client c17 → bo-2  (rank 1/3 · score 0.873 · inFlight 12 · rps 240)  motivo: mayor score del cluster
```

En failover:
```
[FAILOVER] req #128501 · bo-1 no respondió (ECONNREFUSED) → reintenta bo-3 (rank 2)
```

### 7.3 `_meta` en la respuesta (para el dashboard del cliente)

El Dispatcher envuelve la respuesta con metadata mínima para que el cliente
agregue la distribución por BO sin acoplarse al LB:

```js
{ msg, result, _meta: { servedBy: 'bo-2', rank: 1, attempts: 1 } }
```

`ClientRSI.parseBOResponse` ignora `_meta` para el resultado de negocio, pero el
`loadTest` lo lee para las métricas de distribución.

---

## 8. Logger formateado — `shared/logger.js`

- **Sin dependencias**: helpers ANSI (color + negrita) detrás de un flag
  (`log.color`), desactivable para archivos/pipes.
- **Tags por componente** con color fijo: `CLIENT` (azul), `DISPATCHER`
  (violeta), `LB` (naranja), `BO` (verde), `DB` (cian), `ROUTE`/`FAILOVER`.
- **Niveles**: `debug | info | warn | error` (filtrados por `log.level`).
- **Formato**: `HH:MM:SS.mmm [TAG] mensaje` + helpers estructurados
  (`logger.route({...})`, `logger.failover({...})`).
- Throttling/muestreo lo decide el llamador (Dispatcher), no el logger.

---

## 9. Cliente de carga — `client/loadTest.js`

### 9.1 Generador

- Lanza `virtualClients` clientes virtuales; cada uno dispara requests en bucle
  hasta cubrir `targetRps` agregado (control de ritmo por ventanas).
- Mezcla de operaciones según `readWriteRatio` (mayoría `getById`/`list`/`search`,
  algunas `create`/`update`).
- Cada payload lleva `clientId` (`c0..cN`) y un `reqId` incremental.
- **Fase 1 (transporte simple)**: una conexión TCP por request (como hoy) +
  recomendación de subir `ulimit -n` y `net.ipv4.ip_local_port_range`. Suficiente
  para cientos / bajos miles de req/s en LAN. Ver §10.

### 9.2 Observabilidad (decisión tomada: dashboard + stream muestreado)

- **Dashboard agregado** (refresca cada `dashboardIntervalMs`, redibuja en sitio):
  - RPS objetivo vs real, total enviadas/ok/error.
  - **Distribución por BO** (de `_meta.servedBy`): `bo-1 32% | bo-2 41% | bo-3 27%`.
  - Latencia `p50 / p95 / p99`, en vuelo, errores por tipo.
- **Stream muestreado**: el Dispatcher imprime 1 de cada `sampleEvery` decisiones
  de ruteo (líneas `[ROUTE]`/`[FAILOVER]` de §7.2). Como cliente y dispatcher
  comparten M0, ambas vistas salen en la misma pantalla.

### 9.3 Métricas finales

Al terminar (`durationSec`): resumen — RPS promedio, distribución final por BO,
percentiles de latencia, conteo de failovers, errores.

---

## 10. Alta carga: transporte (decisión: simple primero)

- **Fase 1 — simple**: conexión por request en ambos saltos (cliente→dispatcher,
  dispatcher→BO). Tuning del SO: `ulimit -n 65535`, ampliar rango de puertos
  efímeros, `TIME_WAIT`. Objetivo: validar LB, ranking, failover y logs.
- **Fase 2 — opcional/futura** (si el techo de Fase 1 no alcanza): conexiones
  **persistentes con pool** y **multiplexado por `reqId`** en ambos saltos.
  Requiere: correlación de respuestas por id, manejo de back-pressure y de
  cierres. Se planifica aparte; no bloquea la entrega inicial.

---

## 11. Decisiones abiertas (a confirmar antes de implementar)

1. **Nombre del service / tabla**: `Criminal` / `criminals`. ¿OK o preferís otro
   dominio o más campos (foto URL, última_ubicación, recompensa)?
2. **Inyección del pool**: ¿pool como singleton de módulo (`db/pool.js`) que el
   `CriminalService` importa, o inyectado por constructor desde `BOServer`?
   (Recomiendo singleton de módulo: simple y un pool por proceso.)
3. **IPs reales** de M0/M1/M2/M3 para `shared/config.js` (placeholders por ahora).
4. **Credenciales DB**: `rsi/rsi` para dev. ¿Mover a `.env`? (Recomiendo `.env` +
   `.env.example`, no commitear secretos.)
5. **`reqId` global vs por cliente**: para los logs, ¿numeración global del
   dispatcher o `clientId#seq`? (Recomiendo `clientId#seq` + un id global corto.)
6. **Mix de operaciones del load test**: ¿el 90/10 lectura/escritura está bien o
   querés otro perfil (p.ej. 100% lectura para estresar solo SELECTs)?

---

## 12. Estructura de archivos resultante

```
docker-compose.yml                 (nuevo)  Postgres + Adminer
.env.example                       (nuevo)  DB_HOST, credenciales
db/init/01_schema.sql              (nuevo)  tabla criminals
db/init/02_seed.sql                (nuevo)  datos de ejemplo
db/pool.js                         (nuevo)  pool pg (singleton)            [según §11.2]
shared/config.js                   (edita)  service Criminal x3, db, loadTest, log
shared/logger.js                   (nuevo)  logging formateado ANSI
server/Dispatcher.js               (edita)  logging de ruteo + _meta
server/LoadBalancer.js             (edita)  rank() con score + reason
BO_Servers/server/BOServer.js      (nuevo)  BO genérico + pool
BO_Servers/class/Criminal.js       (nuevo)  CriminalService (CRUD)
BO_Servers/class/{Calculator,Equations}.js  (borra)
BO_Servers/method/*                (borra)  métodos aritméticos de demo
BO_Servers/server/{Calculator,Equation}Server.js (borra)
client/ClientRSI.js                (edita)  clientId + lee _meta
client/ProxyCriminal.js            (nuevo)  proxy del dominio criminales
client/{ProxyCalculator,ProxyEquations}.js  (borra)
client/loadTest.js                 (nuevo)  generador de carga + dashboard
start-bo.js                        (nuevo)  arranca una réplica (id/port/env)
start.js                           (edita)  M0: dispatcher (+ cliente opcional)
package.json                       (edita)  dep `pg` + scripts
```

---

## 13. Cómo correr (resumen)

**M0 (principal):**
```
docker compose up -d            # Postgres + Adminer
node start.js                   # Dispatcher :3000
node client/loadTest.js         # genera carga + dashboard
```
**M1 / M2 / M3 (cada réplica):**
```
DB_HOST=<IP_M0> BO_ID=bo-1 BO_PORT=4001 node start-bo.js
```

---

## 14. Fases de implementación (orden propuesto)

0. **Infra DB**: `docker-compose.yml`, esquema, seed, `db/pool.js`. Verificar
   conexión y Adminer.
1. **BO único**: `BOServer` + `CriminalService` (CRUD con `pg`); borrar demos.
   Probar una réplica local contra la DB.
2. **Config + cliente**: `config.js` (service Criminal x3), `ProxyCriminal`,
   `ClientRSI` con `clientId`/`_meta`. Probar 1 request end-to-end.
3. **Logger + ruteo**: `shared/logger.js`, `rank()` con `score`/`reason`,
   logging `[ROUTE]`/`[FAILOVER]` + `_meta` en respuesta.
4. **Load test**: `loadTest.js` con dashboard agregado + stream muestreado.
5. **Distribuido**: completar IPs, levantar las 3 réplicas en M1/M2/M3, correr la
   prueba de carga y observar la distribución/failover.
6. **(Opcional) Fase 2 transporte**: pooling + multiplexado si hace falta más RPS.

---

> **Siguiente paso**: revisás este plan, confirmás las decisiones abiertas (§11)
> y arranco por la Fase 0.
