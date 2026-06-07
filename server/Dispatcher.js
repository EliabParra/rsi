import Net from "net";
import { onJsonMessage, writeJson } from "../shared/jsonStream.js";
import { config } from "../shared/config.js";
import LoadBalancer from "./LoadBalancer.js";

export default class Dispatcher {
  constructor() {
    this.boServers = new Map();
    this.loadBalancer = new LoadBalancer();
  }

  loadBOServers() {
    this.boServers.set("Calculator", config.boServers.calculator);
    this.boServers.set("Equations", config.boServers.equation);
  }

  init() {
    this.loadBOServers();

    // Arranca el pruning periódico de servers con heartbeat vencido.
    this.loadBalancer.start();

    this.socketServer = Net.createServer((socket) => {
      onJsonMessage(socket, (payload) => {
        const { type } = payload || {};

        switch (type) {
          case "register":
            this.handleBORegistration(payload, socket);
            break;

          case "heartbeat":
            this.handleBOHeartbeat(payload);
            break;

          case "rpc":
          default:
            this.handleRequest(payload, socket);
            break;
        }
      });
      socket.on("error", (err) => console.error("Dispatcher error:", err));
    });

    this.socketServer.listen(
      config.dispatcher.port,
      config.dispatcher.host,
      () =>
        console.log(
          `Servidor escuchando en ${config.dispatcher.host}:${config.dispatcher.port}`,
        ),
    );
  }

  handleRequest(payload, socket) {
    const { method, className, args } = payload;

    // Lista de instancias ordenada de mejor a peor según el LoadBalancer.
    const rankedInstances = this.loadBalancer.rank(className);

    if (!rankedInstances || rankedInstances.length === 0) {
      writeJson(socket, {
        message: `No se encontraron servidores de negocio activos para la clase ${className}`,
      });
      socket.end();
      return;
    }

    const forwardPayload = { method, className, args };

    // Intenta el rank 1; si falla, cae en cascada al rank 2, 3...
    this.tryConnectToRank(rankedInstances, 0, forwardPayload, socket, className);
  }

  handleBORegistration(payload) {
    const { serverId, className, caps, host, port } = payload;
    this.loadBalancer.register(className, serverId, host, port, caps);
  }

  handleBOHeartbeat(payload) {
    const { serverId, metrics } = payload;
    const updated = this.loadBalancer.heartbeat(serverId, metrics);
    if (!updated) {
      console.warn(
        `[Dispatcher] Heartbeat ignorado: el servidor [${serverId}] no se ha registrado.`,
      );
    }
  }

  // Forward con failover en cascada sobre la lista rankeada.
  // onDispatch al despachar (anti-thundering herd) y onResponse al recibir
  // respuesta o ante un fallo de conexión.
  tryConnectToRank(instances, index, forwardPayload, clientSocket, className) {
    if (index >= instances.length) {
      writeJson(clientSocket, {
        message: `Todos los servidores de la clase ${className} fallaron.`,
      });
      clientSocket.end();
      return;
    }

    const boServer = instances[index];
    this.loadBalancer.onDispatch(className, boServer.id);
    let settled = false;

    const forwardSocket = Net.createConnection(
      { port: boServer.port, host: boServer.host },
      () => {
        writeJson(forwardSocket, forwardPayload);
      },
    );

    onJsonMessage(forwardSocket, (response) => {
      if (settled) return;
      settled = true;
      this.loadBalancer.onResponse(className, boServer.id);
      writeJson(clientSocket, response);
      forwardSocket.end();
      clientSocket.end();
    });

    forwardSocket.on("error", (err) => {
      if (settled) return;
      settled = true;
      this.loadBalancer.onResponse(className, boServer.id);
      console.warn(
        `[Failover] Servidor ${boServer.id} (${className}) falló: ${err.message}. Intentando con el siguiente de la lista...`,
      );
      forwardSocket.destroy();

      // Intento en cascada recursivo al siguiente de la lista rankeada.
      this.tryConnectToRank(
        instances,
        index + 1,
        forwardPayload,
        clientSocket,
        className,
      );
    });
  }
}
