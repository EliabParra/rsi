# RSI — Cómo funciona, raspao

Cada concepto arranca por **la línea directa**. El detalle de abajo es opcional, leélo solo si querés.

Cómo levantarlo: [como-levantar.md](./como-levantar.md) · Guion: [guion-presentacion.md](./guion-presentacion.md) · Versión larga: [como-funciona.md](./como-funciona.md).

## Las piezas
4 procesos que se hablan por TCP: **Cliente** (hace pedidos) → **Dispatcher** (:3000, reparte) → **BO Server** (ejecuta la lógica; hay N copias) → **Postgres** (la DB). Todos mandan JSON con un `\n` al final.

---

## 1. Cómo se mandan los mensajes
> **En una línea:** cada mensaje es un JSON con un `\n` pegado al final; recibir = cortar el string por `\n` y parsear.

Detalle: TCP te da bytes en fila y no avisa dónde termina un mensaje (pueden llegar pegados o cortados). Entonces se manda `JSON.stringify(obj) + "\n"`, y del otro lado se acumula lo que llega en un string y se corta en cada `\n`. Es todo `shared/jsonStream.js`, 25 líneas.

---

## 2. RPC + reflexión
> **En una línea:** el cliente manda `{className, method, args}` y el BO llama a ese método por su nombre, sin tenerlo cableado en un switch.

Detalle: el BO al arrancar lee la carpeta `class/`, importa cada archivo y guarda en un `Map` qué métodos tiene cada clase. Cuando llega el pedido, busca la clase, agarra la instancia y hace `instancia[method](args)`. Por eso si agregás `class/Vehicle.js` funciona solo. **Reflexión = llamar a un método por su nombre en string, descubierto en runtime.**

---

## 3. El Dispatcher
> **En una línea:** un proceso en :3000 que mira el campo `type` y con un `if` decide: guardar un BO, actualizar sus números, o reenviar el pedido al mejor BO.

Detalle:
```
type === 'register'  → un BO se presenta       → lo guarda
type === 'heartbeat' → un BO mandó sus números → los actualiza
otra cosa            → es un pedido            → lo reenvía al mejor BO
```

---

## 4. Heartbeat
> **En una línea:** cada BO tiene un `setInterval` que cada 1s le manda sus números al dispatcher; así decidir es leer un Map, no preguntar por la red.

Detalle: los números son memoria libre, pedidos en curso, RPS, CPU. Si el dispatcher tuviera que preguntar en el momento de decidir, sería un viaje de red por cada pedido = lento. Eso es **push** (el BO empuja) en vez de **pull** (preguntar). Lo que no cambia (núcleos, RAM total) se manda una sola vez; lo que cambia, en cada latido.

---

## 5. Load balancer
> **En una línea:** le pone a cada BO un `score = capacidad × (1 − carga)` y manda al más alto; si ese falla, al siguiente de la lista.

Detalle:
- **capacidad** = hardware (núcleos, velocidad, RAM). **carga** = qué tan ocupado (pedidos en curso, memoria, CPU, RPS).
- **Normalizar:** para sumar núcleos (8) con bytes de RAM (16000000000) sin que la RAM aplaste todo, se divide cada uno por el máximo del grupo → quedan entre 0 y 1.
- **Contador propio (anti-amontonamiento):** entre latido y latido pasa 1s; si llegan 50 pedidos, el LB suma 1 a un contador suyo por cada uno que manda (y resta al volver), así sabe que está cargado sin esperar el latido.
- **Failover:** un bucle que prueba rank 1, si falla rank 2, después 3. **Prune:** si un BO no late en 3s, lo borra.

---

## 6. Cluster DB
> **En una línea:** dos Postgres — escrituras al primary, lecturas a la réplica — y la copia la hace Postgres solo con el WAL, la app no copia nada.

Detalle: en el código son dos pools (`writePool` → primary :5432, `readPool` → réplica :5433); en `Criminal.js` los métodos que escriben usan uno y los que leen el otro. El primary anota cada cambio en su WAL y se lo manda a la réplica, que lo reproduce.

### Síncrono vs asíncrono
> **En una línea:** **async** = el primary confirma apenas guardó en él (rápido, pero podés perder lo último); **sync** = no confirma hasta que la réplica también lo tenga (seguro, pero si la réplica cae las escrituras se traban).

Detalle: la diferencia es **cuándo el primary le dice "listo" a la app**. Async: apenas lo escribió en SU WAL, sin esperar a la réplica (queda una ventana de unos ms = el **replication lag**, por eso un read inmediato a veces no lo ve). Sync: espera a que la réplica confirme que lo recibió, y recién ahí confirma.

**Conexión con CAP** (apagás la réplica):
- async → el primary sigue confirmando = sigue disponible pero desparejo → **AP**.
- sync → el primary se traba hasta que la réplica vuelva = consistente pero no disponible → **CP**.

---

## El viaje de un pedido, de arriba a abajo
```
Cliente:  proxy.list({limit:5})
   → arma {className:'Criminal', method:'list', args:{limit:5}} y abre TCP al Dispatcher :3000
Dispatcher:
   → mira type → es pedido
   → el load balancer ordena los BO por score → rank 1, 2, 3
   → abre TCP al rank 1 (:4001) y le reenvía. Si falla, rank 2, 3.
BO Server:
   → busca clase/método por reflexión y ejecuta Criminal.list(args)
   → list hace SELECT por readPool → Réplica :5433
   → devuelve {msg, result}
Dispatcher: le pega _meta (quién atendió, qué rank) y se lo manda al cliente
Cliente:  recibe la respuesta
```
De fondo, todo el tiempo: cada BO late cada 1s, el Dispatcher guarda los números y borra a los que no latieron en 3s.

---

## Palabras (cada una en su línea)
- **Serializar:** objeto → texto para mandarlo (`JSON.stringify`). Deserializar = lo inverso.
- **RPC:** correr una función de otra máquina mandándole su nombre y args.
- **Reflexión:** llamar a un método por su nombre en string, descubierto en runtime.
- **Heartbeat:** un `setInterval` que manda los números del BO cada 1s.
- **Push / pull:** el BO empuja (rápido) vs el dispatcher pregunta (lento).
- **In-flight:** pedidos que entraron y no terminaron.
- **Failover:** si el primero falla, probar el siguiente de la lista.
- **WAL:** el archivo donde Postgres anota cada cambio; la réplica lo reproduce.
- **Replication lag:** la réplica va unos ms atrás del primary.
- **CAP:** si se corta la comunicación, elegís consistencia (CP) o disponibilidad (AP).
