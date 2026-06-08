import Net from "net";
import { onJsonMessage, writeJson } from "../shared/jsonStream.js";

/**
 * Conexión persistente BO server → Dispatcher para empujar métricas (Fase 2).
 *
 * Principio de diseño (ver docs/load-balancer.md §2.1): el balanceador NUNCA
 * pregunta métricas en el camino crítico. Cada BO server abre UNA conexión de
 * larga vida, manda 'register' (capacidad estática) al arrancar y luego envía
 * 'heartbeat' (estado dinámico) cada N ms por el mismo socket. Si la conexión
 * se cae, reconecta y vuelve a registrarse.
 *
 * El Dispatcher no responde a estos mensajes: la conexión es unidireccional en
 * la práctica (solo se usa para empujar).
 */
export default class HeartbeatClient {
  constructor({
    serverId,
    className,
    host,
    port,
    dispatcher,
    metrics,
    intervalMs = 1000,
    reconnectMs = 2000,
  }) {
    this.serverId = serverId;
    this.className = className;
    // host/port propios: dónde el Dispatcher debe conectarse para hacer forward.
    this.host = host;
    this.port = port;
    this.dispatcher = dispatcher; // { host, port }
    this.metrics = metrics;
    this.intervalMs = intervalMs;
    this.reconnectMs = reconnectMs;

    this.socket = null;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  _connect() {
    if (this.stopped) return;

    this.socket = Net.createConnection(
      { host: this.dispatcher.host, port: this.dispatcher.port },
      () => {
        this._register();
        this._startHeartbeat();
      },
    );

    // El Dispatcher no contesta register/heartbeat, pero drenamos por las dudas.
    onJsonMessage(this.socket, () => {});

    this.socket.on("error", (err) => {
      console.error(
        `[heartbeat ${this.serverId}] error de conexión al Dispatcher: ${err.message}`,
      );
    });

    this.socket.on("close", () => {
      this._stopHeartbeat();
      if (!this.stopped) {
        const t = setTimeout(() => this._connect(), this.reconnectMs);
        t.unref?.();
      }
    });
  }

  _register() {
    writeJson(this.socket, {
      type: "register",
      serverId: this.serverId,
      className: this.className,
      host: this.host,
      port: this.port,
      caps: this.metrics.getStaticCaps(),
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.timer = setInterval(() => {
      if (!this.socket || this.socket.destroyed) return;
      writeJson(this.socket, {
        type: "heartbeat",
        serverId: this.serverId,
        metrics: this.metrics.getDynamicMetrics(),
      });
    }, this.intervalMs);
    // No mantener vivo el proceso solo por el heartbeat.
    this.timer.unref?.();
  }

  _stopHeartbeat() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    this.stopped = true;
    this._stopHeartbeat();
    if (this.socket) this.socket.end();
  }
}
