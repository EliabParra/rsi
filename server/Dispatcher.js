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

    // 1. Obtener la lista ordenada (de mejor a peor)
    const rankedInstances = this.lb.rank(className);

    if (!rankedInstances || rankedInstances.length === 0) {
      writeJson(socket, {
        message: `No se encontraron servidores de negocio activos para la clase ${className}`,
      });
      socket.end();
      return;
    }

    // 2. Seleccionar el mejor objetivo
    const targetServer = rankedInstances[0];

    // 3. Registrar despacho local inmediato (Anti-Thundering Herd)
    this.lb.onDispatch(className, targetServer.id);

    const forwardPayload = { method, className, args };

    // 4. Modificar forward para decrementar al terminar
    this.forwardToBOServer(targetServer, forwardPayload, socket, className);
  }

  // Selección de la instancia destino.
  // Fase 0: sin LoadBalancer todavía, se toma la primera instancia disponible.
  // En la Fase 4 esto se reemplaza por la decisión rankeada del LoadBalancer.
  selectBOServer(instances) {
    return instances[0];
  }

  forwardToBOServer(boServer, forwardPayload, socket, className) {
    const forwardSocket = Net.createConnection(
      { port: boServer.port, host: boServer.host },
      () => {
        writeJson(forwardSocket, forwardPayload);
      },
    );

    onJsonMessage(forwardSocket, (response) => {
      this.lb.onResponse(className, boServer.id); // <-- Liberar contador local al recibir respuesta
      writeJson(socket, response);
      forwardSocket.end();
      socket.end();
    });

    forwardSocket.on("error", (err) => {
      this.lb.onResponse(className, boServer.id); // <-- Liberar contador local si el nodo muere en pleno vuelo
      console.error(
        `Error al conectar con el servidor de objetos de negocio ${className}:`,
        err,
      );
      console.error(
        `Error al conectar con el servidor de objetos de negocio ${className}:`,
        err,
      );
      writeJson(socket, {
        message: `Error al conectar con el servidor de objetos de negocio ${className}`,
      });
      socket.end();
    });
  }

  // Métodos temporales de la Fase 2 (Se conectarán al LoadBalancer en la Fase 4)
  handleBORegistration(payload, socket) {
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

  // Ejemplo conceptual de cómo estructurar la cascada recursiva:
  tryConnectToRank(instances, index, forwardPayload, clientSocket, className) {
    if (index >= instances.length) {
      writeJson(clientSocket, {
        message: `Todos los servidores de la clase ${className} fallaron.`,
      });
      clientSocket.end();
      return;
    }

    const boServer = instances[index];
    this.lb.onDispatch(className, boServer.id);

    const forwardSocket = Net.createConnection(
      { port: boServer.port, host: boServer.host },
      () => {
        writeJson(forwardSocket, forwardPayload);
      },
    );

    onJsonMessage(forwardSocket, (response) => {
      this.lb.onResponse(className, boServer.id);
      writeJson(clientSocket, response);
      forwardSocket.end();
      clientSocket.end();
    });

    forwardSocket.on("error", (err) => {
      this.lb.onResponse(className, boServer.id);
      console.warn(
        `[Failover] Servidor ${boServer.id} falló. Intentando con el siguiente de la lista...`,
      );

      // Intento en cascada recursivo al siguiente de la lista rankeada
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
