# Guía para probar la app RSI completa

Esta guía te lleva paso a paso para levantar y probar **todo el sistema** en tu
máquina: cluster de PostgreSQL, Dispatcher, BO Servers, cliente y tests
automatizados.

No necesitás leer otros documentos antes; al final hay una sección de
**problemas frecuentes**.

---

## Qué vas a probar

```
Cliente (ProxyCriminal)
        │
        ▼
Dispatcher :3000
        │
        ▼
BO Server :4001 (Criminal.js)
        │
        ├── escrituras → Primary  :5432
        └── lecturas   → Réplica  :5433
```

---

## Requisitos previos

- **Node.js** 18+ instalado
- **Docker Desktop** corriendo
- Terminal con acceso al proyecto

Verificá:

```bash
node --version
docker --version
```

---

## Paso 0 — Ir a la carpeta del proyecto

```bash
cd "/Users/Shared/University/Introducción a Sistemas Distribuidos/02 - Activities/RSI"
```

---

## Paso 1 — Configurar el entorno (`.env`)

Si no tenés `.env`, copiá el ejemplo:

```bash
cp .env.example .env
```

> `shared/config.js` lee los hosts desde `.env` (`DISPATCHER_HOST`, `BO_1_HOST`,
> etc.). Si no exportás el `.env`, usa `RSI_HOST` o la IP local detectada
> automáticamente.

Para pruebas **locales**, tu `.env` debe tener al menos:

```env
RSI_HOST=127.0.0.1
DISPATCHER_HOST=127.0.0.1
DISPATCHER_PORT=3000

BO_1_HOST=127.0.0.1
BO_1_PORT=4001
BO_2_HOST=127.0.0.1
BO_2_PORT=4002
BO_3_HOST=127.0.0.1
BO_3_PORT=4003

DB_WRITE_HOST=127.0.0.1
DB_WRITE_PORT=5432
DB_READ_HOST=127.0.0.1
DB_READ_PORT=5433
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```

En la **red del laboratorio**, reemplazá `127.0.0.1` por la IP de cada máquina
(M0 para Dispatcher y DB, M1/M2/M3 para los BO).

Cargá las variables en cada terminal antes de arrancar servicios Node:

```bash
export $(grep -v '^#' .env | xargs)
```

> **Tip:** ejecutá ese `export` en **cada terminal nueva** que uses para
> Dispatcher, BO o cliente.

---

## Paso 2 — Levantar el cluster de base de datos

```bash
docker compose up -d
docker compose ps
```

Deberías ver tres contenedores `Up` y los dos PostgreSQL `healthy`:

| Contenedor | Puerto |
|------------|--------|
| `rsi-db-primary` | 5432 |
| `rsi-db-replica` | 5433 |
| `rsi-adminer-1` | 8080 |

### Verificar replicación (opcional pero recomendado)

```bash
# Escribir en el Primary
docker exec rsi-db-primary psql -U rsi -d criminals -c \
  "INSERT INTO criminals (full_name, crime) VALUES ('Mi Prueba', 'fraud');"

# Leer en la Réplica (debe aparecer)
docker exec rsi-db-replica psql -U rsi -d criminals -c \
  "SELECT id, full_name FROM criminals WHERE full_name = 'Mi Prueba';"

# Estado de replicación
docker exec rsi-db-primary psql -U rsi -d criminals -c \
  "SELECT client_addr, state, sync_state FROM pg_stat_replication;"

# Limpiar el registro de prueba
docker exec rsi-db-primary psql -U rsi -d criminals -c \
  "DELETE FROM criminals WHERE full_name = 'Mi Prueba';"
```

Resultados esperados:

- El `SELECT` en la réplica muestra el registro
- `pg_stat_replication` muestra `state = streaming`
- Un `INSERT` directo en la réplica falla con *read-only transaction*

Más detalle del cluster: [cluster-db.md](./cluster-db.md)

---

## Paso 3 — Instalar dependencias Node

```bash
pnpm install
# o, si no tenés pnpm:
npm install
```

---

## Paso 4 — Arrancar los servicios (3 terminales)

Necesitás **3 terminales** abiertas. En cada una:

```bash
cd "/Users/Shared/University/Introducción a Sistemas Distribuidos/02 - Activities/RSI"
export $(grep -v '^#' .env | xargs)
```

### Terminal 1 — Dispatcher

```bash
node start.js
```

Salida esperada:

```
Servidor escuchando en 127.0.0.1:3000
```

### Terminal 2 — BO Server 1

```bash
node start-bo.js --id bo-1 --port 4001 --host 127.0.0.1
```

Salida esperada:

```
[BO bo-1] listening on 127.0.0.1:4001
[lb] register bo-1 (Criminal) @ 127.0.0.1:4001
```

### Terminal 3 — BO Server 2 (opcional, para probar balanceo)

```bash
node start-bo.js --id bo-2 --port 4002 --host 127.0.0.1
```

> Con un solo BO alcanza para la prueba básica. Agregá `bo-3` en el puerto
> `4003` si querés simular tres réplicas.

**Orden recomendado:** Docker → Dispatcher → BO(s) → Cliente

---

## Paso 5 — Probar con el cliente demo

En una **cuarta terminal**:

```bash
export $(grep -v '^#' .env | xargs)
node client/ClientServer.js
```

Por defecto ejecuta el **flujo completo Cluster DB**:

| Paso | Método | Destino |
|------|--------|---------|
| 1 | `list` | Réplica (readPool) |
| 2 | `search` | Réplica |
| 3 | `getById(1)` | Réplica |
| 4 | `create` | Primary (writePool) |
| 5 | `getById` (retry) | Réplica — verifica sincronización |
| 6 | `update` | Primary |
| 7 | `search` | Réplica — verifica update replicado |
| 8 | `remove` | Primary |
| 9 | `getById` | Réplica — verifica eliminación |

Salida esperada: líneas con `[READ → réplica]`, `[WRITE → primary]` y al final
`=== Flujo Cluster DB completado ===`.

### Endpoints individuales

```bash
# Solo lecturas (comportamiento anterior)
node client/ClientServer.js --reads

# Escritura
node client/ClientServer.js create --name "Mi Test" --crime fraud

# Lectura por id (réplica)
node client/ClientServer.js getById --id 1

# Update / remove
node client/ClientServer.js update --id 5 --crime "updated"
node client/ClientServer.js remove --id 5

# Ayuda
node client/ClientServer.js help
```

O con npm:

```bash
pnpm client          # flujo completo
pnpm client:reads    # solo lecturas
pnpm test:cluster    # mismo flujo, script dedicado
```

---

## Paso 6 — Verificar replicación con endpoints de escritura

Con Dispatcher y BO corriendo, probá operaciones sueltas:

```bash
# Crear en Primary
node client/ClientServer.js create --name "Manual Test" --crime fraud

# Leer en Réplica (usá el id devuelto por create)
node client/ClientServer.js getById --id <ID>

# Actualizar y eliminar
node client/ClientServer.js update --id <ID> --crime updated
node client/ClientServer.js remove --id <ID>
```

O ejecutá el flujo automático que hace todo en secuencia:

```bash
node client/ClientServer.js
```

| Operación | Pool | DB |
|-----------|------|-----|
| `create` | writePool | Primary |
| `getById` | readPool | Réplica |
| `update` | writePool | Primary |
| `remove` | writePool | Primary |

---

## Paso 7 — Probar con Adminer (interfaz web)

Abrí [http://localhost:8080](http://localhost:8080)

**Primary:**

| Campo | Valor |
|-------|-------|
| Sistema | PostgreSQL |
| Servidor | `db-primary` |
| Usuario | `rsi` |
| Contraseña | `rsi` |
| Base de datos | `criminals` |

**Réplica:** mismo usuario/contraseña/base, servidor `db-replica`.

Después de un `create` desde el cliente, el registro debe aparecer en **ambas**
bases (con un pequeño retraso en la réplica).

---

## Paso 8 — Tests automatizados

Con Docker y `.env` cargado:

```bash
export $(grep -v '^#' .env | xargs)

# Tests unitarios (Dispatcher, LoadBalancer, logger)
node --test --test-reporter=spec

# E2E Cluster DB: Criminal.js directo contra Primary/Réplica
node test/cluster-db-e2e.mjs

# E2E RSI completo: Cliente → Dispatcher → BO → DB
node test/rsi-full-e2e.mjs
```

Los tres deben terminar sin errores.

---

## Paso 9 — Prueba de carga (opcional)

Con Dispatcher y al menos un BO corriendo:

```bash
export $(grep -v '^#' .env | xargs)
node client/loadTest.js
```

Muestra un dashboard en consola con RPS, latencias y ratio lectura/escritura.
Por defecto el 90% de las operaciones son lecturas (`READ_WRITE_RATIO=0.9`).

---

## Checklist rápido

Marca cada ítem cuando funcione:

- [ ] `docker compose ps` → primary y réplica `healthy`
- [ ] `pg_stat_replication` → `streaming`
- [ ] Dispatcher escuchando en `:3000`
- [ ] BO registrado (`[lb] register bo-1 ...`)
- [ ] `node client/ClientServer.js` devuelve datos
- [ ] `create` + `getById` funcionan (con posible delay de ~500 ms)
- [ ] Adminer muestra la tabla `criminals` en ambas DBs

---

## Problemas frecuentes

### El Dispatcher no arranca (`EADDRNOTAVAIL` o similar)

**Causa:** `DISPATCHER_HOST` en `.env` apunta a una IP que tu máquina no tiene.

**Solución:** usá `DISPATCHER_HOST=127.0.0.1` en `.env` y volvé a exportar.

### El BO arranca pero el cliente dice "No se encontró el servidor de objetos de negocio"

**Causa:** el heartbeat no llegó al Dispatcher.

**Solución:**

1. Verificá que el Dispatcher esté corriendo **antes** que el BO
2. Confirmá que `DISPATCHER_HOST` en `.env` coincide con donde escucha el Dispatcher
3. Arrancá el BO con `--host 127.0.0.1` si probás en local

### Error de conexión a PostgreSQL (`ECONNREFUSED` en 5432 o 5433)

**Causa:** Docker no está levantado o faltan variables de entorno.

**Solución:**

```bash
docker compose up -d
export $(grep -v '^#' .env | xargs)
```

### `create` funciona pero `getById` no encuentra el registro

**Causa:** **replication lag** — la réplica va unos milisegundos detrás.

**Solución:** esperá 300–500 ms y reintentá. Es comportamiento normal.

### Las variables del `.env` no se aplican

**Causa:** Node no carga `.env` automáticamente.

**Solución:** siempre ejecutá `export $(grep -v '^#' .env | xargs)` antes de
`node start.js`, `node start-bo.js` o el cliente.

---

## Apagar todo

```bash
# Ctrl+C en cada terminal de Node (Dispatcher, BO, cliente)

# Detener Docker (conserva datos)
docker compose down

# Detener Docker y borrar volúmenes (reinicia schema + seed)
docker compose down -v
```

---

## Resumen de puertos

| Servicio | Puerto | Rol |
|----------|--------|-----|
| Dispatcher | 3000 | Entrada del cliente |
| BO bo-1 | 4001 | Lógica de negocio |
| BO bo-2 | 4002 | Réplica BO (opcional) |
| BO bo-3 | 4003 | Réplica BO (opcional) |
| PostgreSQL Primary | 5432 | Escrituras |
| PostgreSQL Réplica | 5433 | Lecturas |
| Adminer | 8080 | UI web de depuración |

---

## Referencias

- [cluster-db.md](./cluster-db.md) — cómo funciona Primary + Réplica
- [como-funciona.md](./como-funciona.md) — recorrido completo del código RSI
