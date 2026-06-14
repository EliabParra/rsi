# Cluster DB — Cómo funciona la base de datos del proyecto RSI

Esta guía explica **desde cero** cómo está armado el cluster de PostgreSQL del
proyecto RSI: qué problemas resuelve, qué contenedores hay, cómo se sincronizan
los datos y cómo la aplicación Node.js decide a cuál base conectarse.

No necesitás saber nada previo sobre replicación ni Docker para entenderla.

---

## 1. ¿Qué problema resuelve?

En un sistema distribuido, una sola base de datos puede convertirse en cuello de
botella: muchas lecturas (`SELECT`) compiten con pocas escrituras (`INSERT`,
`UPDATE`, `DELETE`) y todo pasa por el mismo servidor.

La solución que usa RSI es **separar lectura y escritura**:

| Operación | Va a… | Por qué |
|-----------|-------|---------|
| `INSERT`, `UPDATE`, `DELETE` | **Primary** (principal) | Solo él puede modificar datos |
| `SELECT` | **Réplica** (copia) | Descarga al principal; escala lecturas |

La réplica **no se actualiza a mano**. PostgreSQL la mantiene sincronizada en
tiempo casi real mediante **streaming replication** (replicación por flujo de
WAL).

---

## 2. Vista general del cluster

Cuando corrés `docker compose up -d`, se levantan **tres contenedores** relacionados
con la base de datos:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tu máquina (host)                        │
│                                                                 │
│   App Node.js (BO Servers)                                      │
│        │                              │                         │
│        │ escrituras                   │ lecturas                │
│        ▼                              ▼                         │
│   localhost:5432                 localhost:5433                 │
│        │                              │                         │
│   ┌────┴────────┐              ┌──────┴───────┐                 │
│   │ db-primary  │  streaming   │  db-replica  │                 │
│   │  (Primary)  │ ──────────►  │  (Réplica)   │                 │
│   │  escritura  │  replication │  solo lectura│                 │
│   └─────────────┘              └──────────────┘                 │
│                                                                 │
│   Adminer :8080  →  herramienta web para inspeccionar ambas DBs │
└─────────────────────────────────────────────────────────────────┘
```

| Contenedor | Imagen | Puerto en tu PC | Rol |
|------------|--------|-----------------|-----|
| `rsi-db-primary` | `postgres:16-alpine` | **5432** | Base principal. Crea tablas, carga datos, acepta escrituras |
| `rsi-db-replica` | `postgres:16-alpine` | **5433** | Copia del primary. Solo lectura |
| `rsi-adminer-1` | `adminer:4` | **8080** | Interfaz web para ver tablas y ejecutar SQL (solo depuración) |

**Importante:** dentro de Docker, ambos PostgreSQL escuchan en el puerto interno
`5432`. En tu máquina el primary se expone como `5432` y la réplica como `5433`
para que no choquen.

---

## 3. Credenciales

Todas las conexiones de la app y de Adminer usan las mismas credenciales de
usuario de aplicación:

| Campo | Valor |
|-------|-------|
| Usuario | `rsi` |
| Contraseña | `rsi` |
| Base de datos | `criminals` |

Además existe un usuario **interno** solo para la replicación entre contenedores:

| Campo | Valor |
|-------|-------|
| Usuario | `replicator` |
| Contraseña | `replicator` |

No necesitás `replicator` para revisar datos con Adminer o con la app.

Estas variables están en el archivo `.env` del proyecto:

```env
DB_WRITE_HOST=127.0.0.1
DB_WRITE_PORT=5432
DB_READ_HOST=127.0.0.1
DB_READ_PORT=5433
DB_USER=rsi
DB_PASSWORD=rsi
DB_NAME=criminals
```

---

## 4. ¿Qué pasa cuando levantás el cluster?

### 4.1 Arranque del Primary (`db-primary`)

Es el **primero** en iniciarse. Al crearse por primera vez (volumen vacío),
PostgreSQL ejecuta automáticamente los scripts de la carpeta `db/init/`, en orden
alfabético:

| Script | Qué hace |
|--------|----------|
| `00-replication-user.sql` | Crea el usuario `replicator` con permiso de replicación |
| `01_schema.sql` | Crea la tabla `criminals` y sus índices |
| `02_seed.sql` | Inserta los 50 registros iniciales de ejemplo |

Estos scripts **solo corren en el Primary**. La réplica nunca los ejecuta: recibe
todo por clonación y replicación.

El Primary también se configura con parámetros de replicación (en
`docker-compose.yml`):

- `wal_level=replica` — guarda suficiente información en el WAL para replicar
- `max_wal_senders=10` — permite hasta 10 conexiones de réplicas
- `hot_standby=on` — permite que la réplica atienda consultas mientras recibe datos

El archivo `db/primary/pg_hba.conf` define quién puede conectarse:

- Usuario `rsi` → acceso normal a la base `criminals`
- Usuario `replicator` → acceso de replicación desde la red de Docker

### 4.2 Arranque de la Réplica (`db-replica`)

La réplica **espera** a que el Primary esté sano (`depends_on` + healthcheck).
Luego ejecuta el script `db/replica/entrypoint.sh`:

1. **¿Ya tiene datos?** Si encuentra `PG_VERSION` en su volumen, arranca directo.
2. **Si es la primera vez:**
   - Espera a que el Primary responda
   - Ejecuta `pg_basebackup` para **clonar** una copia exacta del Primary
   - Configura la conexión de replicación automáticamente (flag `-R`)
3. Inicia PostgreSQL en modo **standby** (réplica)

A partir de ahí, cada cambio que ocurre en el Primary se transmite por streaming
y la réplica lo aplica sola.

### 4.3 Adminer

Adminer es independiente del flujo de la app. Abrís `http://localhost:8080` y te
conectás con `rsi` / `rsi` / `criminals`. Desde dentro de Docker:

- Primary → servidor `db-primary`
- Réplica → servidor `db-replica`

---

## 5. ¿Cómo se sincronizan los datos?

PostgreSQL no copia tablas enteras cada vez. Usa el **WAL** (Write-Ahead Log): un
diario donde el Primary registra cada cambio **antes** de confirmarlo.

```
Primary                              Réplica
   │                                    │
   │  INSERT en criminals               │
   │  ──► escribe en WAL                │
   │                                    │
   │  envía WAL por red (streaming)     │
   │ ─────────────────────────────────► │ aplica el mismo cambio
   │                                    │
   │                                    │  SELECT ve el dato nuevo
```

Esto es **automático**. No hay scripts de sincronización en la app Node.js.

### Replication lag (retraso)

La réplica puede ir **unos milisegundos detrás** del Primary. Si creás un
criminal y enseguida hacés un `getById`, a veces la lectura aún no lo ve. Es
comportamiento normal en sistemas distribuidos, no un error de configuración.

---

## 6. ¿Cómo sabe la app a qué base conectarse?

La app **no detecta** automáticamente si una operación es lectura o escritura a
nivel de PostgreSQL. La decisión está en el código de `Criminal.js` y en
`db/pool.js`.

### 6.1 Dos pools de conexión (`db/pool.js`)

Al iniciar un BO Server se crean **dos pools** independientes con la librería `pg`:

```javascript
export const writePool = new Pool({
  host: DB_WRITE_HOST,   // → localhost:5432 → Primary
  port: DB_WRITE_PORT,
  ...
})

export const readPool = new Pool({
  host: DB_READ_HOST,    // → localhost:5433 → Réplica
  port: DB_READ_PORT,
  ...
})
```

Un pool es un conjunto de conexiones reutilizables. `writePool` siempre apunta al
Primary; `readPool` siempre apunta a la Réplica.

### 6.2 Regla en `Criminal.js`

Cada método elige explícitamente qué pool usar:

| Método RPC | SQL | Pool |
|------------|-----|------|
| `create` | `INSERT` | `writePool` |
| `update` | `UPDATE` | `writePool` |
| `remove` | `DELETE` | `writePool` |
| `getById` | `SELECT` | `readPool` |
| `list` | `SELECT` | `readPool` |
| `search` | `SELECT` | `readPool` |

Ejemplo simplificado:

```javascript
// Escritura → Primary
await writePool.query('INSERT INTO criminals ...')

// Lectura → Réplica
await readPool.query('SELECT * FROM criminals WHERE id = $1', [id])
```

### 6.3 Flujo completo con el sistema RSI

```
Cliente
   │
   ▼
Dispatcher (puerto 3000)
   │
   ▼
BO Server (puerto 4001, 4002, …)
   │
   ▼
Criminal.js
   │
   ├── create / update / remove ──► writePool ──► Primary :5432
   │
   └── getById / list / search    ──► readPool  ──► Réplica :5433
```

El Dispatcher y el Load Balancer **no saben** que existen dos bases. Solo
reenvían la llamada al BO; el BO decide el pool según el método.

---

## 7. Archivos del proyecto relacionados con el cluster

```
RSI/
├── docker-compose.yml          # Define db-primary, db-replica y adminer
├── .env                        # Credenciales y puertos (no se sube a git)
├── db/
│   ├── pool.js                 # writePool y readPool
│   ├── init/
│   │   ├── 00-replication-user.sql
│   │   ├── 01_schema.sql
│   │   └── 02_seed.sql
│   ├── primary/
│   │   ├── replication.conf    # Referencia de parámetros WAL
│   │   └── pg_hba.conf         # Reglas de acceso del Primary
│   └── replica/
│       └── entrypoint.sh       # Clonación inicial con pg_basebackup
└── BO_Servers/class/
    └── Criminal.js             # Usa writePool o readPool según el método
```

---

## 8. Comandos útiles

### Levantar el cluster

```bash
cd "/Users/Shared/University/Introducción a Sistemas Distribuidos/02 - Activities/RSI"
docker compose up -d
```

### Ver estado de los contenedores

```bash
docker compose ps
```

### Conectarse por terminal

```bash
# Primary
docker exec -it rsi-db-primary psql -U rsi -d criminals

# Réplica
docker exec -it rsi-db-replica psql -U rsi -d criminals
```

### Probar que la replicación funciona

```bash
# 1. Escribir en el Primary
docker exec rsi-db-primary psql -U rsi -d criminals -c \
  "INSERT INTO criminals (full_name, crime) VALUES ('Test Replica', 'fraud');"

# 2. Leer en la Réplica (debe aparecer el registro)
docker exec rsi-db-replica psql -U rsi -d criminals -c \
  "SELECT id, full_name, crime FROM criminals WHERE full_name = 'Test Replica';"

# 3. Ver estado de replicación en el Primary
docker exec rsi-db-primary psql -U rsi -d criminals -c \
  "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

Deberías ver `state = streaming` en el paso 3.

### Probar que la réplica es solo lectura

```bash
docker exec rsi-db-replica psql -U rsi -d criminals -c \
  "INSERT INTO criminals (full_name, crime) VALUES ('No debe guardarse', 'test');"
```

Debe fallar con: `cannot execute INSERT in a read-only transaction`.

### Borrar todo y empezar de cero

```bash
docker compose down -v
docker compose up -d
```

El flag `-v` borra los volúmenes. El Primary vuelve a ejecutar schema y seed; la
réplica se clona de nuevo.

---

## 9. Escenario en red LAN (varias máquinas)

En laboratorio con varias PCs, el concepto es el mismo pero las IPs cambian:

| Máquina | Rol | Puerto típico |
|---------|-----|---------------|
| M0 (ej. `10.35.112.156`) | Primary (escritura) | 5432 |
| M1 (ej. `10.35.112.244`) | Réplica (lectura) | 5432 o 5433 |

En cada BO Server del proyecto:

```env
DB_WRITE_HOST=10.35.112.156
DB_WRITE_PORT=5432
DB_READ_HOST=10.35.112.244
DB_READ_PORT=5432
```

En la máquina réplica, el `entrypoint.sh` usa `PRIMARY_HOST=10.35.112.156` para
clonarse del Primary remoto. Hay que abrir el firewall para el puerto 5432 entre
ambas máquinas.

---

## 10. Preguntas frecuentes

### ¿Por qué hay tres contenedores y no dos?

Solo **dos** son bases de datos (`db-primary` y `db-replica`). **Adminer** es una
herramienta extra para inspeccionar datos desde el navegador; la app RSI no lo
usa.

### ¿La réplica tiene sus propios 50 registros del seed?

No los carga sola. Los recibe al clonarse del Primary con `pg_basebackup` y
después se mantiene al día por streaming.

### ¿Qué pasa si cae la réplica?

Las escrituras en el Primary siguen funcionando. Las lecturas fallan hasta que
la réplica vuelva. La app intentaría conectar a `readPool` y recibiría error de
conexión.

### ¿Qué pasa si cae el Primary?

Ni escrituras ni réplica nueva funcionan correctamente: la réplica solo refleja
lo que ya tenía y no puede recibir cambios nuevos.

### ¿Puedo leer del Primary en vez de la réplica?

Sí, técnicamente podrías usar `writePool` para todo, pero perdés el beneficio de
descargar lecturas. El diseño actual separa explícitamente ambos roles.

### ¿Cómo cargo las variables del `.env` en Node?

El proyecto lee `process.env`. Si las variables no están exportadas en la
terminal, podés cargarlas así antes de arrancar un BO:

```bash
export $(grep -v '^#' .env | xargs) && node start-bo.js
```

---

## 11. Resumen en una frase

**El Primary guarda y modifica los datos; la Réplica es una copia de solo lectura
sincronizada por PostgreSQL; la app manda escrituras al puerto 5432 y lecturas al
5433 eligiendo `writePool` o `readPool` en cada método de `Criminal.js`.**
