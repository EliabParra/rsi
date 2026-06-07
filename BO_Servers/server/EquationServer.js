import Net from "net";
import resolveClassInstance from "../methodResolver.js";
import { onJsonMessage, writeJson } from "../../shared/jsonStream.js";
import MetricsCollector from "../MetricsCollector.js";
import { config } from "../../shared/config.js";

export default class EquationServer {
  constructor({ id = "eq-1", port = 4002, host = "0.0.0.0" } = {}) {
    this.id = id;
    this.port = port;
    this.host = host;
    this.socketServer = null;
    this.metrics = new MetricsCollector();

    this.className = "Equations";
    this.dispatcherSocket = null;
    this.isReconnecting = false;
    this.heartbeatIntervalId = null;
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
      console.log(`EquationServer escuchando en ${this.host}:${this.port}`);

      this.connectToDispatcher();
    });
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

  connectToDispatcher() {
    console.log(
      `[${this.id}] Intentando establecer conexión persistente con el Dispatcher...`,
    );

    // Conexión persistente hacia el puerto del Dispatcher (3000).
    this.dispatcherSocket = Net.createConnection(
      {
        port: config.dispatcher.port,
        host: config.dispatcher.host,
      },
      () => {
        this.isReconnecting = false;
        console.log(
          `[${this.id}] Conectado al Dispatcher con éxito. Enviando 'register'...`,
        );

        // Mensaje (1): Registro de capacidades estáticas.
        const registerMsg = {
          type: "register",
          serverId: this.id,
          className: this.className,
          host: this.host === "0.0.0.0" ? "127.0.0.1" : this.host, // Evitar enviar la IP comodín
          port: this.port,
          caps: this.metrics.getStaticCaps(),
        };

        writeJson(this.dispatcherSocket, registerMsg);

        // Envío periódico (2): Heartbeats con métricas dinámicas.
        this.startHeartbeatLoop();
      },
    );

    this.dispatcherSocket.on("close", () => {
      console.warn(`[${this.id}] Conexión con el Dispatcher cerrada.`);
      this.handleDispatcherDisconnect();
    });

    this.dispatcherSocket.on("error", (err) => {
      console.error(
        `[${this.id}] Error en el socket del Dispatcher:`,
        err.message,
      );
      // El evento 'close' se disparará inmediatamente después de 'error'.
    });
  }

  handleDispatcherDisconnect() {
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }

    if (!this.isReconnecting) {
      this.isReconnecting = true;
      // Reintentar la conexión cada 5 segundos hasta que el Dispatcher vuelva.
      setTimeout(() => {
        this.connectToDispatcher();
      }, 5000);
    }
  }

  startHeartbeatLoop() {
    if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId);

    this.heartbeatIntervalId = setInterval(() => {
      if (this.dispatcherSocket && !this.dispatcherSocket.destroyed) {
        const heartbeatMsg = {
          type: "heartbeat",
          serverId: this.id,
          metrics: this.metrics.getDynamicMetrics(),
        };
        writeJson(this.dispatcherSocket, heartbeatMsg);
      }
    }, config.heartbeat.interval);
  }
}
