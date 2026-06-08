import Net from "net";
import resolveClassInstance from "../methodResolver.js";
import { onJsonMessage, writeJson } from "../../shared/jsonStream.js";
import MetricsCollector from "../MetricsCollector.js";
import HeartbeatClient from "../HeartbeatClient.js";
import { config } from "../../shared/config.js";

export default class CalculatorServer {
  constructor({ id = "calc-1", port = 4001, host = "0.0.0.0" } = {}) {
    this.id = id;
    this.className = "Calculator";
    this.port = port;
    this.host = host;
    this.socketServer = null;
    this.metrics = new MetricsCollector();
    this.heartbeat = null;
  }

  init() {
    this.metrics.start();

    this.socketServer = Net.createServer((socket) => {
      onJsonMessage(socket, (payload) => {
        this.handleRequest(payload, socket);
      });

      socket.on("error", (err) => console.error("Socket error:", err));
    });

    this.socketServer.listen(this.port, this.host, () => {
      console.log(`CalculatorServer escuchando en ${this.host}:${this.port}`);
      this._startHeartbeat();
    });
  }

  // Conexión persistente al Dispatcher: register + heartbeat (Fase 2).
  _startHeartbeat() {
    this.heartbeat = new HeartbeatClient({
      serverId: this.id,
      className: this.className,
      host: this.host,
      port: this.port,
      dispatcher: config.dispatcher,
      metrics: this.metrics,
      intervalMs: config.loadBalancer?.heartbeatIntervalMs,
    });
    this.heartbeat.start();
  }

  async handleRequest(payload, socket) {
    this.metrics.requestStarted();
    try {
      const { className, method, args } = payload || {};

      if (!className || !method) {
        writeJson(socket, {
          message: "Solicitud inválida: className y method son requeridos",
        });
        return;
      }

      const classInstance = await resolveClassInstance({ className, method });

      if (typeof classInstance === "string") {
        writeJson(socket, { message: classInstance });
        return;
      }

      const fn = classInstance[method];
      if (typeof fn !== "function") {
        writeJson(socket, {
          message: `Método '${method}' no disponible en '${className}'`,
        });
        return;
      }

      try {
        const result = await fn(args || {});
        const response =
          typeof result === "string" ? { message: result } : result;
        writeJson(socket, response);
      } catch (error) {
        writeJson(socket, {
          message: `Error al ejecutar '${method}': ${error.message}`,
        });
      }
    } finally {
      this.metrics.requestFinished();
    }
  }
}
