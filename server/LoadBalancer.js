// Evita divisiones por cero al normalizar (norm respecto al máximo del conjunto).
const EPS = 1e-6;

/**
 * Balanceador embebido en el Dispatcher (Fases 3-5, ver docs/load-balancer.md).
 *
 * Mantiene en memoria el último estado conocido de cada BO server (push por
 * heartbeat). La decisión `rank()` es PURO CPU sobre Maps en memoria: cero I/O
 * de red en el camino crítico.
 *
 * Estado: Map<className, Map<serverId, ServerState>>
 */
export default class LoadBalancer {
  constructor({ staleTimeoutMs = 3000, weights } = {}) {
    this.staleTimeoutMs = staleTimeoutMs;
    this.ws = weights?.static ?? { cpuCores: 0.4, cpuSpeed: 0.3, totalMem: 0.3 };
    this.wd = weights?.dynamic ?? {
      inFlight: 0.4,
      mem: 0.2,
      cpu: 0.2,
      rps: 0.2,
    };
    this.registry = new Map();
  }

  _bucket(className) {
    if (!this.registry.has(className)) this.registry.set(className, new Map());
    return this.registry.get(className);
  }

  // 'register' — capacidad estática, una vez al arrancar el BO server.
  register(msg) {
    const { serverId, className, host, port, caps } = msg;
    const bucket = this._bucket(className);
    const prev = bucket.get(serverId);

    bucket.set(serverId, {
      id: serverId,
      host,
      port,
      caps, // { cpuCores, cpuSpeed, totalMem }

      // dinámico (se completa con el primer heartbeat)
      freeMem: prev?.freeMem ?? 0,
      totalMem: caps?.totalMem ?? prev?.totalMem ?? 0,
      inFlight: prev?.inFlight ?? 0,
      rps: prev?.rps ?? 0,
      cpuUtil: prev?.cpuUtil ?? 0,

      // control interno del LB
      lastSeen: Date.now(),
      localInFlight: prev?.localInFlight ?? 0,
    });

    console.log(`[lb] register ${serverId} (${className}) @ ${host}:${port}`);
  }

  // 'heartbeat' — estado dinámico, cada N ms.
  heartbeat(msg) {
    const { serverId, metrics } = msg;
    const s = this._find(serverId);
    if (!s) return; // heartbeat sin register previo: esperar el register (reconexión).

    s.freeMem = metrics.freeMem;
    s.totalMem = metrics.totalMem ?? s.totalMem;
    s.inFlight = metrics.inFlight;
    s.rps = metrics.rps;
    s.cpuUtil = metrics.cpuUtil;
    s.lastSeen = Date.now();
  }

  // Candidatos sanos: heartbeat reciente y capacidad conocida.
  _healthy(className) {
    const bucket = this.registry.get(className);
    if (!bucket) return [];
    const now = Date.now();
    const out = [];
    for (const s of bucket.values()) {
      if (s.caps && now - s.lastSeen <= this.staleTimeoutMs) out.push(s);
    }
    return out;
  }

  /**
   * Corazón del balanceador. Devuelve la lista rankeada de candidatos
   * (rank 1 = mejor). El rank 2+ es el fallback para failover.
   *
   * Normaliza las métricas respecto al máximo del conjunto de candidatos para
   * que magnitudes dispares (bytes de RAM vs nº de CPUs) sean comparables.
   */
  rank(className) {
    const cands = this._healthy(className);
    if (cands.length === 0) return [];

    const maxCores = Math.max(...cands.map((s) => s.caps.cpuCores || 0), EPS);
    const maxSpeed = Math.max(...cands.map((s) => s.caps.cpuSpeed || 0), EPS);
    const maxTotalMem = Math.max(...cands.map((s) => s.caps.totalMem || 0), EPS);
    const maxInFlight = Math.max(
      ...cands.map((s) => s.inFlight + s.localInFlight),
      EPS,
    );
    const maxRps = Math.max(...cands.map((s) => s.rps || 0), EPS);

    const scored = cands.map((s) => {
      // Capacidad: peso estático del server (normalizado al conjunto).
      const capacity = Math.max(
        this.ws.cpuCores * (s.caps.cpuCores / maxCores) +
          this.ws.cpuSpeed * (s.caps.cpuSpeed / maxSpeed) +
          this.ws.totalMem * (s.caps.totalMem / maxTotalMem),
        EPS,
      );

      const totalInFlight = s.inFlight + s.localInFlight;
      const memPressure = s.totalMem > 0 ? 1 - s.freeMem / s.totalMem : 0;
      const freeMemPct = s.totalMem > 0 ? s.freeMem / s.totalMem : 0;

      // Carga: in-flight y RPS pesan MÁS sobre servers de poca capacidad
      // (relativos a capacity). RPS es carga, no premio.
      const load =
        (this.wd.inFlight * (totalInFlight / maxInFlight)) / capacity +
        this.wd.mem * memPressure +
        this.wd.cpu * s.cpuUtil +
        (this.wd.rps * (s.rps / maxRps)) / capacity;

      const score = capacity * (1 - load);
      return {
        s,
        score,
        snapshot: {
          capacity,
          inFlight: totalInFlight,
          rps: s.rps,
          cpuUtil: s.cpuUtil,
          freeMemPct,
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((e, i) => ({
      rank: i + 1,
      id: e.s.id,
      host: e.s.host,
      port: e.s.port,
      score: e.score,
      reason: cands.length === 1 ? 'único sano' : 'mayor score del cluster',
      snapshot: e.snapshot,
    }));
  }

  // Anti thundering herd: contar in-flight localmente sin esperar el heartbeat.
  onDispatch(id) {
    const s = this._find(id);
    if (s) s.localInFlight++;
  }

  onResponse(id) {
    const s = this._find(id);
    if (s && s.localInFlight > 0) s.localInFlight--;
  }

  _find(id) {
    for (const bucket of this.registry.values()) {
      const s = bucket.get(id);
      if (s) return s;
    }
    return null;
  }

  // Limpia servers cuyo heartbeat venció (liberar memoria del registro).
  prune() {
    const now = Date.now();
    for (const bucket of this.registry.values()) {
      for (const [id, s] of bucket) {
        if (now - s.lastSeen > this.staleTimeoutMs) {
          bucket.delete(id);
          console.log(`[lb] prune ${id} (stale)`);
        }
      }
    }
  }
}
