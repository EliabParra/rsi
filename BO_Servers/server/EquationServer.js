import Net from "net";
import resolveClassInstance from "../methodResolver.js";
import { onJsonMessage, writeJson } from "../../shared/jsonStream.js";

export default class EquationServer {
  constructor({ port = 4002, host = "0.0.0.0" } = {}) {
    this.port = port;
    this.host = host;
    this.socketServer = null;
  }

  init() {
    this.socketServer = Net.createServer((socket) => {
      onJsonMessage(socket, (payload) => {
        this.handleRequest(payload, socket);
      });

      socket.on("error", (err) => console.error("Socket error:", err));
    });

    this.socketServer.listen(this.port, this.host, () => {
      console.log(`EquationServer escuchando en ${this.host}:${this.port}`);
    });
  }

  async handleRequest(payload, socket) {
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
  }
}
