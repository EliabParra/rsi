import { config } from "../shared/config.js";

/**
 * Clase LoadBalancer - Fase 3 (Corregida)
 * Centraliza el estado del cluster, calcula el ranking matemático y limpia nodos caídos.
 */
export default class LoadBalancer {
  constructor({
    heartbeatTimeoutMs = config.heartbeat.deadTimeout,
    wsCores = config.loadBalancer.wsCores || 0.2,
    wsSpeed = config.loadBalancer.wsSpeed || 0.2,
    wsMem = config.loadBalancer.wsMem || 0.1,
    wdInFlight = config.loadBalancer.wdInFlight || 0.3,
    wdRps = config.loadBalancer.wdRps || 0.2,
  } = {}) {
    this.servers = new Map();
    this.timeoutLimit = heartbeatTimeoutMs;
    this.weights = { wsCores, wsSpeed, wsMem, wdInFlight, wdRps };
    this.pruningTimer = null;
  }

  start() {
    if (this.pruningTimer) return;
    this.pruningTimer = setInterval(() => {
      this.pruneDeadServers();
    }, config.loadBalancer.interval || 2000);
  }

  stop() {
    if (this.pruningTimer) {
      clearInterval(this.pruningTimer);
      this.pruningTimer = null;
    }
  }

  register(className, serverId, host, port, caps) {
    if (!this.servers.has(className)) {
      this.servers.set(className, new Map());
    }

    const classMap = this.servers.get(className);
    const existing = classMap.get(serverId) || {
      metrics: { freeMem: 0, inFlight: 0, rps: 0, cpuUtil: 0 },
    };

    classMap.set(serverId, {
      id: serverId,
      className,
      host,
      port,
      caps: {
        cpuCores: caps.cpuCores || 1,
        cpuSpeed: caps.cpuSpeed || 0,
        totalMem: caps.totalMem || 0,
      },
      metrics: existing.metrics,
      lastSeen: Date.now(),
    });

    console.log(
      `[LB] Servidor registrado -> [${className}][${serverId}] en ${host}:${port}`,
    );
  }

  heartbeat(serverId, metrics) {
    for (const [className, classMap] of this.servers.entries()) {
      if (classMap.has(serverId)) {
        const serverData = classMap.get(serverId);

        serverData.metrics.freeMem = metrics.freeMem;
        serverData.metrics.rps = metrics.rps;
        serverData.metrics.cpuUtil = metrics.cpuUtil;

        // Suavizado: previene desfases si el LB decrementó antes de que el BO server procesara
        serverData.metrics.inFlight = Math.max(
          serverData.metrics.inFlight,
          metrics.inFlight,
        );
        serverData.lastSeen = Date.now();
        return true;
      }
    }
    return false;
  }

  onDispatch(className, serverId) {
    const server = this.servers.get(className)?.get(serverId);
    if (server) {
      server.metrics.inFlight++;
    }
  }

  onResponse(className, serverId) {
    const server = this.servers.get(className)?.get(serverId);
    if (server && server.metrics.inFlight > 0) {
      server.metrics.inFlight--;
    }
  }

  rank(className) {
    const classMap = this.servers.get(className);
    if (!classMap || classMap.size === 0) return [];

    const instances = Array.from(classMap.values());
    if (instances.length === 1) return instances;

    // Inicializar los máximos con los valores base de la config o 0
    const maxs = {
      maxCores: config.loadBalancer.maxCores || 1,
      maxSpeed: config.loadBalancer.maxSpeed || 1,
      maxTotalMem: config.loadBalancer.maxTotalMem || 1,
      maxInFlight: config.loadBalancer.maxInFlight || 1,
      maxRps: config.loadBalancer.maxRps || 1,
    };

    // Buscar los máximos reales del cluster de forma segura
    for (const s of instances) {
      if (s.caps.cpuCores > maxs.maxCores) maxs.maxCores = s.caps.cpuCores;
      if (s.caps.cpuSpeed > maxs.maxSpeed) maxs.maxSpeed = s.caps.cpuSpeed;
      if (s.caps.totalMem > maxs.maxTotalMem)
        maxs.maxTotalMem = s.caps.totalMem;
      if (s.metrics.inFlight > maxs.maxInFlight)
        maxs.maxInFlight = s.metrics.inFlight;
      if (s.metrics.rps > maxs.maxRps) maxs.maxRps = s.metrics.rps;
    }

    // Calcular el Score de cada instancia aplicando la normalización defensiva
    const scoredInstances = instances.map((server) => {
      const score = this.calculateServerScore(server, maxs);
      return { ...server, finalScore: Number(score.toFixed(4)) };
    });

    // Ordenar de Mayor Score a Menor Score
    return scoredInstances.sort((a, b) => b.finalScore - a.finalScore);
  }

  calculateServerScore(server, maxs) {
    const { caps, metrics } = server;
    const w = this.weights;

    // Normalización estática (Evitando divisiones por cero)
    const normCores = maxs.maxCores > 0 ? caps.cpuCores / maxs.maxCores : 1;
    const normSpeed = maxs.maxSpeed > 0 ? caps.cpuSpeed / maxs.maxSpeed : 1;
    const normTotalMem =
      maxs.maxTotalMem > 0 ? caps.totalMem / maxs.maxTotalMem : 1;

    // Normalización dinámica inversa (A menor carga, mejor score)
    const normInFlight =
      maxs.maxInFlight > 0 ? 1 - metrics.inFlight / maxs.maxInFlight : 1;
    const normRps = maxs.maxRps > 0 ? 1 - metrics.rps / maxs.maxRps : 1;

    // Ecuación final ponderada
    const staticScore =
      normCores * w.wsCores + normSpeed * w.wsSpeed + normTotalMem * w.wsMem;
    const dynamicScore = normInFlight * w.wdInFlight + normRps * w.wdRps;

    return staticScore + dynamicScore;
  }

  pruneDeadServers() {
    const now = Date.now();

    for (const [className, classMap] of this.servers.entries()) {
      for (const [serverId, serverData] of classMap.entries()) {
        const elapsed = now - serverData.lastSeen;

        if (elapsed > this.timeoutLimit) {
          console.warn(
            `[LB - PRUNING] Servidor [${serverId}] de la clase [${className}] removido por inactividad (${(elapsed / 1000).toFixed(1)}s sin heartbeat)`,
          );
          classMap.delete(serverId);
        }
      }

      if (classMap.size === 0) {
        this.servers.delete(className);
      }
    }
  }
}
