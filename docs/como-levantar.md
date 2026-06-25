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

# 🧭 Runbook de despliegue (referencia rápida)

Esta sección es **autoexplicativa**: con esto solo, levantar en 1 o en N laptops debería ser trivial. Resume las dos topologías, qué variable setear en cada máquina y **por qué**. El detalle paso a paso por versión está más arriba; esto es el mapa.

## Cómo se descubren los BOs (leé esto y entendés todas las variables)

El sistema tiene tres piezas que se hablan por TCP: **Cliente → Dispatcher → BO server → DB**.

1. Cada **BO** escucha en `this.host:this.port` y, al arrancar, le manda un `register` + heartbeats al **Dispatcher**. ¿A qué dirección de Dispatcher disca? A `config.dispatcher`, o sea **`DISPATCHER_HOST` / `DISPATCHER_PORT`**. → Si esto está mal, el BO **nunca registra**, el LoadBalancer nunca lo rankea, y el Dispatcher dirá *"no se encontró el servidor de objetos de negocio"*.
2. En ese `register`, el BO **anuncia su propio `host`** (el `this.host`, que sale de `--host` o `RSI_HOST` o `getLocalIP()`). El **Dispatcher guarda ese host** y, cuando elige ese BO, **reenvía la request a ese `host:port` anunciado**. → Si el BO anuncia `127.0.0.1`, el Dispatcher intenta reenviar a *sí mismo*, no al BO. Por eso en N laptops **`RSI_HOST` debe ser la IP LAN propia de cada máquina**, no `127.0.0.1`.
3. El **BO** (no el Dispatcher) abre los pools de DB con **`DB_WRITE_HOST` / `DB_READ_HOST`**. → En N laptops debe ser la **IP LAN del host de la DB** (M0), nunca `localhost`: `localhost` en un BO remoto apunta a *esa* laptop, donde no hay Postgres.

En una sola laptop todo esto colapsa a `127.0.0.1` y no hay que pensarlo. El cuidado es exclusivamente para N laptops.

## Tabla de variables — qué es cada una

| Variable | Qué es / por qué | Ejemplo (config viva) |
|---|---|---|
| `DISPATCHER_HOST` | IP del Dispatcher (M0). El HeartbeatClient de **cada** BO disca acá para registrarse. **Debe apuntar al M0 en TODAS las máquinas.** | `10.239.207.156` |
| `DISPATCHER_PORT` | Puerto del Dispatcher. | `3000` |
| `RSI_HOST` | IP que el BO **anuncia** al Dispatcher (a dónde reenviar). Debe ser la **IP LAN propia** de cada máquina. En 1 laptop: `127.0.0.1`. | `10.239.207.176` (en BO-2) |
| `BO_ID` | Identificador único del BO. No puede repetirse entre réplicas. | `bo-2` |
| `BO_PORT` | Puerto donde el BO escucha. Debe ser **alcanzable por el Dispatcher** desde la LAN. En laptops distintas puede repetirse (`4001`) porque cambia el host. | `4001` |
| `DB_WRITE_HOST` | IP del host de la DB primary (escrituras). **IP LAN de M0**, no `localhost`. | `10.239.207.156` |
| `DB_WRITE_PORT` | Puerto del primary. | `5432` |
| `DB_READ_HOST` | IP del host de la réplica (lecturas). Misma máquina M0 (ambas DBs viven en Docker en M0). | `10.239.207.156` |
| `DB_READ_PORT` | Puerto de la réplica. | `5433` |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Credenciales y base. Iguales en todas las máquinas. | `rsi` / `rsi` / `criminals` |
| `BO_1_HOST` / `BO_2_HOST` / `BO_3_HOST` | (Solo en M0) Fallback estático de hosts de las réplicas. El LB igual los aprende por heartbeat; esto es respaldo. | `.156` / `.176` / `.244` |

> En la **versión anterior (LB)** la DB es una sola: usá `DB_HOST` / `DB_PORT` en vez de los `WRITE/READ`. El código hace fallback (`DB_WRITE_HOST || DB_HOST`), así que cualquiera de los dos esquemas funciona.

## Escenario A — Una sola laptop

Todo en `127.0.0.1`, multipuerto. Pasos:

```bash
docker compose up -d                 # DB primary (5432) + réplica (5433) + Adminer (8080)
export $(grep -v '^#' .env | xargs)  # cargar variables (con RSI_HOST=127.0.0.1, DISPATCHER_HOST=127.0.0.1, DB_*_HOST=127.0.0.1)

# Terminal 1 — Dispatcher
node start.js

# Terminales 2/3/4 — tres BOs (mismo código, distinto id y puerto)
node start-bo.js --id bo-1 --port 4001
node start-bo.js --id bo-2 --port 4002
node start-bo.js --id bo-3 --port 4003

# Terminal 5 — cliente
node client/ClientServer.js          # flujo del cluster
# o bien:  node client/loadTest.js   # generador de carga (demo del balanceo)
```

El `--host` lo detecta solo con `getLocalIP()`; en 1 laptop conviene que el `.env` tenga `RSI_HOST=127.0.0.1` para que todo apunte a loopback.

## Escenario B — N laptops (config viva, red `10.239.207.x`)

Topología real en uso:

| Máquina | IP LAN | Procesos | Puertos inbound a abrir (firewall) |
|---|---|---|---|
| **M0** | `10.239.207.156` | Dispatcher + DB primary + DB réplica (Docker) + **BO-1** + cliente/loadTest | `3000` (dispatcher), `4001` (BO-1), `5432` (primary), `5433` (réplica) |
| **M2** | `10.239.207.176` | **BO-2** | `4001` (BO-2) |
| **M3** | `10.239.207.244` | **BO-3** | `4001` (BO-3) |

> "Inbound" = lo que la máquina debe **aceptar** desde la LAN. El Dispatcher (M0) disca a `4001` de cada BO para reenviar; cada BO disca a `3000` de M0 (heartbeat) y a `5432/5433` de M0 (DB). Adminer (`8080`) es opcional, solo si querés la UI web de la DB.

### `.env` por máquina (lo mínimo que cambia)

**M0 (`10.239.207.156`)** — corre Dispatcher + DBs + BO-1:
```env
DISPATCHER_HOST=10.239.207.156   # el Dispatcher escucha acá y los BOs discan acá
DISPATCHER_PORT=3000
RSI_HOST=10.239.207.156          # BO-1 (local en M0) anuncia esta IP
BO_ID=bo-1
BO_PORT=4001
DB_WRITE_HOST=10.239.207.156     # primary, en Docker local
DB_WRITE_PORT=5432
DB_READ_HOST=10.239.207.156      # réplica, en Docker local
DB_READ_PORT=5433
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```

**M2 (`10.239.207.176`)** — solo BO-2:
```env
DISPATCHER_HOST=10.239.207.156   # apunta al M0 (NO a sí misma)
DISPATCHER_PORT=3000
RSI_HOST=10.239.207.176          # su propia IP LAN (lo que anuncia al Dispatcher)
BO_ID=bo-2
BO_PORT=4001
DB_WRITE_HOST=10.239.207.156     # la DB vive en M0
DB_WRITE_PORT=5432
DB_READ_HOST=10.239.207.156
DB_READ_PORT=5433
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```

**M3 (`10.239.207.244`)** — solo BO-3: idéntico a M2, cambiando `RSI_HOST=10.239.207.244` y `BO_ID=bo-3`.

### Orden de arranque (importante)

El BO necesita que el Dispatcher y la DB ya estén arriba; si no, no registra (heartbeat sin destino) o falla al abrir el pool.

```
1) M0:  docker compose up -d        # primero la DB (primary + réplica)
2) M0:  export $(grep -v '^#' .env | xargs) && node start.js      # Dispatcher
3) M2:  export $(grep -v '^#' .env | xargs) && node start-bo.js   # BO-2 (lee BO_ID/BO_PORT/RSI_HOST del .env)
4) M3:  export $(grep -v '^#' .env | xargs) && node start-bo.js   # BO-3
5) M0:  export $(grep -v '^#' .env | xargs) && node start-bo.js   # BO-1 (local)
6) M0:  export $(grep -v '^#' .env | xargs) && node client/ClientServer.js   # o loadTest.js
```

> `start-bo.js` toma `BO_ID`/`BO_PORT` del `.env`, así que en cada máquina no hace falta pasar flags si el `.env` ya está bien. Si querés ser explícito: `node start-bo.js --id bo-2 --port 4001`. Las flags `--id/--port/--host` pisan al `.env`.

### Checklist de firewall (la causa #1 de "no registra")

Abrí en la LAN, por máquina, los puertos **inbound** de la tabla de arriba:

```bash
# M0 — debe aceptar: 3000 (dispatcher), 4001 (BO-1), 5432 + 5433 (DB)
sudo ufw allow from 10.239.207.0/24 to any port 3000,4001,5432,5433 proto tcp
# M2 / M3 — cada una debe aceptar 4001 (su BO)
sudo ufw allow from 10.239.207.0/24 to any port 4001 proto tcp
```

> Postgres ya publica en `0.0.0.0` vía Docker (`ports: 5432:5432`, `5433:5432`), así que del lado app solo falta abrir el firewall del host. Si la máquina no usa `ufw`, abrí los mismos puertos con la herramienta que tengas (`firewalld`, reglas de `iptables`, etc.).

### Patrón de carga de variables (en cada terminal nueva)

```bash
export $(grep -v '^#' .env | xargs)
```

Esto exporta cada línea `CLAVE=valor` del `.env` (ignorando comentarios) al entorno del shell, que es de donde `config.js` y `db/pool.js` leen. **Hacelo en cada terminal antes de lanzar cualquier proceso Node.**

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

## 🛰️ Despliegue con un comando (topology.json)

Una sola **fuente de verdad del despliegue** vive en `topology.json` (separada del contrato `.sdl`). Describe qué máquina corre qué: dispatcher, DB (primary/réplicas) y qué BO (`bo-1/2/3`). De ahí salen los `.env` y el arranque, sin tocar `start.js`, `start-bo.js` ni `shared/config.js`.

**Flujo (3 pasos):**

1. **Editá `topology.json`.** Por defecto trae el cluster real (M0 `10.239.207.156` = dispatcher + DB + bo-1; M1 `10.239.207.176` = bo-2; M2 `10.239.207.244` = bo-3). Para correr TODO en **una sola laptop**, dejá una sola máquina con `host: "127.0.0.1"` que corra `dispatcher + db + [bo-1, bo-2, bo-3]` y apuntá `dispatcher`/`db` a `127.0.0.1` (hay un bloque `$example_single_machine` listo para copiar).

2. **Generá los `.env` una vez** (desde cualquier máquina, suele ser la tuya):

   ```bash
   npm run topogen
   ```

   Escribe un `.env.<máquina>` por entrada (ej. `.env.M0`, `.env.M1`, `.env.M2`) con EXACTAMENTE las variables que consume `shared/config.js` (`RSI_HOST`, `DISPATCHER_HOST/PORT`, `DB_WRITE_*`, `DB_READ_*`/`DB_READ_HOSTS`, y los `BO_n_HOST/PORT/ID` posicionales). Es idempotente.

3. **En cada laptop**, levantá lo suyo:

   ```bash
   docker compose up -d              # SOLO si esa máquina corre la DB
   npm run up -- --machine M0        # arranca dispatcher + sus BO según topology.json
   ```

   `npm run up` (sin `--machine`) **auto-detecta** la máquina comparando tu IP local contra los `host` de `topology.json`. Si no encuentra match, te pide `--machine` explícito.

**Verificar sin cluster vivo (`--dry-run`):** imprime exactamente qué procesos arrancaría y con qué env, sin spawnear nada.

```bash
node tools/up.js --machine M0 --dry-run   # dispatcher + bo-1
node tools/up.js --machine M1 --dry-run   # solo bo-2
```

> `up` **no** levanta Postgres: si la máquina corre la DB, te recuerda correr `docker compose up -d`. El stdout/stderr de cada hijo sale con prefijo `[dispatcher]` / `[bo-1]` para que sepas quién dice qué. Ctrl+C tumba a todos.

> Más detalle: [load-balancer.md](./load-balancer.md), [como-funciona.md](./como-funciona.md), [cluster-db.md](./cluster-db.md), [guia-pruebas.md](./guia-pruebas.md).
