# RSI — Guion de presentación

Qué decir y qué mostrar, en orden. Comandos completos en [como-levantar.md](./como-levantar.md) · Conceptos en [explicacion-simple.md](./explicacion-simple.md).

## Paso 0 — Antes de arrancar (checklist)
- [ ] **Exit node de Tailscale APAGADO** (`sudo tailscale set --exit-node=`). Si no, no conecta nada.
- [ ] `docker compose up -d` y `docker compose ps` → todo `healthy`.
- [ ] Terminales abiertas con el `.env` cargado (`export $(grep -v '^#' .env | xargs)`).
- [ ] Si demo en 1 laptop: `.env` con `127.0.0.1`. Si 3 laptops: IPs reales de M0/M1/M2/M3.

## Paso 1 — Qué es (1 frase)
"Es un sistema donde el cliente ejecuta métodos que viven en otras máquinas (RPC por reflexión), un dispatcher que reparte la carga entre varias réplicas según quién esté más libre, y una base de datos en cluster (una para escribir, otra para leer)."

## Paso 2 — El protocolo (10 segundos)
- **Decí:** "Todo viaja como JSON con un `\n` al final, porque TCP no te dice dónde termina un mensaje. Se corta el string por `\n` y se parsea."
- **Mostrá:** `shared/jsonStream.js` (son 25 líneas).

## Paso 3 — Load balancer en vivo (la parte fuerte)
- **Levantá:** Dispatcher + 3 BOs (bo-1/2/3) + `node client/loadTest.js`.
- **Mostrá:** el dashboard repartiendo los pedidos entre los 3 (`bo-1 34% | bo-2 33% | bo-3 33%`).
- **Decí, mientras corre:** "Cada BO le manda sus números al dispatcher cada segundo (un `setInterval`). El dispatcher les pone un score = capacidad × (1 − carga) y manda al de mayor score. No pregunta nada en el momento, ya tiene los números guardados."
- **Failover:** matá un BO (Ctrl+C). **Decí:** "Si el primero no responde, prueba el siguiente de la lista. A los 3 segundos sin latido, lo saca."

## Paso 4 — Reflexión (15 segundos)
- **Decí:** "El BO no tiene un `switch` con cada método. Lee la carpeta `class/`, guarda en un Map qué métodos hay, y llama al método por su nombre. Si agrego una clase nueva, funciona sola."
- **Mostrá:** `BO_Servers/class/Criminal.js` y nombrá `methodMapper` / `methodResolver`.

## Paso 5 — Cluster DB (versión nueva)
- **Levantá:** primary + réplica (`docker compose up -d` en `marcelopcx`) + Dispatcher + 1 BO + `node client/ClientServer.js`.
- **Mostrá:** las líneas `[READ → réplica]` y `[WRITE → primary]`, y el `create` que aparece en la réplica tras el lag.
- **Decí:** "Las escrituras van al primary, las lecturas a la réplica. En el código son dos pools, uno apunta a cada Postgres. La copia de datos la hace Postgres solo, con el WAL — la app no copia nada."

## Paso 6 — Probar la replicación (cierre técnico)
```bash
# la réplica es solo lectura:
docker exec rsi-db-replica psql -U rsi -d criminals -c "INSERT INTO criminals (full_name,crime) VALUES ('x','y');"   # falla: read-only
# el primary ve a la réplica conectada:
docker exec rsi-db-primary psql -U rsi -d criminals -c "SELECT client_addr,state FROM pg_stat_replication;"   # state = streaming
```
- **(Opcional) CAP:** "Si pongo la réplica síncrona y la apago, las escrituras se traban → elegí consistencia (CP). Asíncrona, siguen pero puedo perder lo último → disponibilidad (AP)."

## Paso 7 — Cierre (la idea grande)
"Son **dos capas de balanceo separadas**: el load balancer reparte el **cómputo** (los BO), y el cluster reparte los **datos** (escritura vs lectura). Una no reemplaza a la otra, conviven."

---

## Si algo se rompe en vivo
- Nada conecta → exit node de Tailscale. Apagalo.
- Dispatcher no arranca → `DISPATCHER_HOST` mal (poné `127.0.0.1` o la IP de M0).
- `create` ok pero no lo ves al leer → replication lag, esperá medio segundo. **Es normal, decílo como parte de la demo.**
