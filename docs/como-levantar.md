# RSI — Cómo levantar todo (paso a paso)

Guía para correr el proyecto en sus **dos versiones** y en **dos topologías** (1 laptop / 3 laptops).

Cómo funciona por dentro: [explicacion-simple.md](./explicacion-simple.md) · Guion de presentación: [guion-presentacion.md](./guion-presentacion.md).

## Las dos versiones (qué cambia)

El **load balancer es el MISMO** en las dos. Lo que cambia es la **capa de datos**:

| Versión | Rama | Base de datos | Qué demuestra |
|---|---|---|---|
| **Anterior (LB)** | `master` | 1 sola Postgres | Balanceo de cómputo entre 3 BOs + failover |
| **Nueva (Cluster DB)** | `marcelopcx` | Primary (escritura) + Réplica (lectura) | Lo anterior + replicación + split read/write |

---

## ⚠️ ANTES DE TODO (gotcha de red)

Si **tu máquina hostea la DB/dispatcher** (sos M0) y usás Tailscale con un **exit node**, apagalo. Un exit node mete una ruta `default` que rutea TODO por la VPN (incluido Docker y tu propia LAN) y nada conecta.

```bash
sudo tailscale set --exit-node=          # apagar exit node (Tailscale sigue arriba)
# reactivar después:  sudo tailscale set --exit-node=<tu-exit-node>
```

Proton VPN **no estorba** (rutea con `suppress_prefixlength 0`, deja salir la LAN/Docker local). Detalle técnico en [explicacion-simple.md](./explicacion-simple.md).

---

## Setup común (una sola vez)

```bash
pnpm install                  # instala 'pg'
```

Patrón de variables: cada terminal nueva carga el `.env` antes de arrancar algo Node:

```bash
export $(grep -v '^#' .env | xargs)
```

> Si cambiás de versión, **bajá Docker primero** (`docker compose down -v`): los `docker-compose.yml` de cada rama definen servicios distintos y chocan.

---

# 🅰️ VERSIÓN ANTERIOR — Load Balancer (rama `master`)

```bash
git checkout master
docker compose down -v 2>/dev/null   # por si venías de la otra versión
docker compose up -d                 # 1 Postgres + Adminer
```

## A.1 — En 1 laptop (todo local, multipuerto)

`.env`:
```env
RSI_HOST=127.0.0.1
DISPATCHER_HOST=127.0.0.1
DISPATCHER_PORT=3000
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```

Necesitás **5 terminales** (en cada una: `export $(grep -v '^#' .env | xargs)`):

```bash
# T1 — Dispatcher (:3000)
node start.js

# T2/T3/T4 — tres BOs, mismo código, distinto id/puerto
node start-bo.js --id bo-1 --port 4001 --host 127.0.0.1
node start-bo.js --id bo-2 --port 4002 --host 127.0.0.1
node start-bo.js --id bo-3 --port 4003 --host 127.0.0.1

# T5 — generador de carga (LA ESTRELLA del LB)
node client/loadTest.js
```

**Qué mirar:** el dashboard del `loadTest` muestra la **distribución por BO** (`bo-1 34% | bo-2 33% | bo-3 33%`), RPS real, latencias p50/p95/p99.
**Demo de failover:** mientras corre la carga, matá un BO (Ctrl+C en T2). El Dispatcher cae en cascada al rank 2/3 y el dashboard muestra cómo se redistribuye. Cuando el heartbeat vence (~3s), el LB lo saca del ranking.

## A.2 — En 3 laptops (distribuido real)

- **M0** = Dispatcher + Postgres + loadTest.
- **M1/M2/M3** = un BO cada una.
- Todas en la misma LAN. Anotá las IPs (ej. `ip addr` → algo tipo `192.168.10.x`).

**M0** — `.env`:
```env
RSI_HOST=<IP_M0>
DISPATCHER_HOST=<IP_M0>
DISPATCHER_PORT=3000
DB_HOST=<IP_M0>
DB_PORT=5432
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
# hosts de las réplicas (fallback estático; igual el LB los aprende por heartbeat)
BO_1_HOST=<IP_M1>
BO_2_HOST=<IP_M2>
BO_3_HOST=<IP_M3>
```
```bash
# M0
docker compose up -d
export $(grep -v '^#' .env | xargs)
node start.js                 # T1
node client/loadTest.js       # T2 (cuando ya estén los BOs)
```

**M1 / M2 / M3** — `.env` (en cada una):
```env
DISPATCHER_HOST=<IP_M0>       # a dónde mandar el heartbeat
DB_HOST=<IP_M0>               # la DB vive en M0
DB_PORT=5432
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```
```bash
# M1:
export $(grep -v '^#' .env | xargs) && node start-bo.js --id bo-1 --port 4001
# M2:
export $(grep -v '^#' .env | xargs) && node start-bo.js --id bo-2 --port 4001
# M3:
export $(grep -v '^#' .env | xargs) && node start-bo.js --id bo-3 --port 4001
```
> En laptops distintas el puerto puede ser el mismo (4001) porque cambia el host. El `--host` lo detecta solo (`getLocalIP()` agarra la IP de LAN de cada máquina).

**Requisitos de red en M0:** exit node de Tailscale OFF, y que la LAN alcance los puertos `3000` (dispatcher) y `5432` (Postgres, ya publicado en `0.0.0.0`).

---

# 🅱️ VERSIÓN NUEVA — Cluster DB (rama `marcelopcx`)

```bash
git checkout marcelopcx
docker compose down -v 2>/dev/null
docker compose up -d                 # Primary :5432 + Réplica :5433 + Adminer :8080
docker compose ps                    # esperá primary y replica 'healthy'
```

> La réplica se clona sola del primary con `pg_basebackup` la primera vez (tarda unos segundos). **Ambas DBs viven en Docker en M0** — la réplica NO va en otra laptop.

## B.1 — En 1 laptop

`.env` (igual que antes + los puertos de lectura/escritura):
```env
RSI_HOST=127.0.0.1
DISPATCHER_HOST=127.0.0.1
DISPATCHER_PORT=3000
DB_WRITE_HOST=127.0.0.1
DB_WRITE_PORT=5432            # Primary  → escrituras
DB_READ_HOST=127.0.0.1
DB_READ_PORT=5433            # Réplica  → lecturas
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```

```bash
# T1 — Dispatcher
node start.js
# T2 — un BO (alcanza uno para la demo del cluster; sumá bo-2/bo-3 si querés balanceo también)
node start-bo.js --id bo-1 --port 4001 --host 127.0.0.1
# T3 — flujo completo del cluster (lecturas→réplica, escrituras→primary, verifica replicación)
node client/ClientServer.js
```

**Qué mirar:** las líneas `[READ → réplica]` y `[WRITE → primary]`, y el paso donde un `create` en el primary aparece en la réplica tras el lag. También `pnpm test:cluster` corre el mismo flujo como smoke test.

## B.2 — En 3 laptops

Igual que A.2, pero las DBs (primary + réplica) corren en Docker **en M0**, y cada BO apunta a las dos:

**M0** — `.env`: lo de A.2 pero la parte de DB cambia a:
```env
DB_WRITE_HOST=<IP_M0>
DB_WRITE_PORT=5432
DB_READ_HOST=<IP_M0>
DB_READ_PORT=5433
```
```bash
# M0
docker compose up -d
export $(grep -v '^#' .env | xargs) && node start.js
```

**M1 / M2 / M3** — `.env`:
```env
DISPATCHER_HOST=<IP_M0>
DB_WRITE_HOST=<IP_M0>
DB_WRITE_PORT=5432
DB_READ_HOST=<IP_M0>
DB_READ_PORT=5433
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```
```bash
# M1 / M2 / M3 (cambiando --id):
export $(grep -v '^#' .env | xargs) && node start-bo.js --id bo-1 --port 4001
```

## (Opcional) El "wow" de CAP

Comprobar que la réplica es de solo lectura y ver el estado de replicación:
```bash
docker exec rsi-db-replica psql -U rsi -d criminals -c \
  "INSERT INTO criminals (full_name, crime) VALUES ('x','y');"   # debe fallar: read-only
docker exec rsi-db-primary psql -U rsi -d criminals -c \
  "SELECT client_addr, state, sync_state FROM pg_stat_replication;"  # state = streaming
```

---

## 🔌 Tabla de puertos

| Servicio | Puerto | Rol |
|---|---|---|
| Dispatcher | 3000 | Entrada del cliente |
| BO bo-1/2/3 | 4001/4002/4003 | Lógica de negocio (réplicas de cómputo) |
| Postgres Primary | 5432 | Escrituras |
| Postgres Réplica | 5433 | Lecturas (solo versión nueva) |
| Adminer | 8080 | UI web para inspeccionar la DB |

## 🧯 Si algo falla

| Síntoma | Causa | Arreglo |
|---|---|---|
| `ECONNRESET` / `timeout` a la DB | **exit node de Tailscale** secuestra la ruta | `sudo tailscale set --exit-node=` |
| Dispatcher no arranca (`EADDRNOTAVAIL`) | `DISPATCHER_HOST` apunta a una IP que tu máquina no tiene | poné `127.0.0.1` (1 laptop) o la IP real de M0 |
| BO arranca pero "no se encontró el servidor de objetos de negocio" | el heartbeat no llegó | arrancá el Dispatcher ANTES; revisá `DISPATCHER_HOST` |
| `create` ok pero `getById` no lo ve | **replication lag** (la réplica va unos ms atrás) | esperá ~300–500 ms y reintentá (es normal, no es bug) |
| Choca al levantar Docker | restos de la otra versión | `docker compose down -v` y volvé a `up -d` |

## Apagar todo

```bash
# Ctrl+C en cada terminal Node
docker compose down       # para los containers (conserva datos)
docker compose down -v    # para + borra volúmenes (reinicia schema + seed)
```

> Más detalle: [load-balancer.md](./load-balancer.md), [como-funciona.md](./como-funciona.md), [cluster-db.md](./cluster-db.md), [guia-pruebas.md](./guia-pruebas.md).
