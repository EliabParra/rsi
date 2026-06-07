import os from "os";

/**
 * Recolecta las métricas que el balanceador necesita de cada BO server.
 *
 * - Capacidad estática (CPU, memoria total): se calcula una vez. La consumirá
 *   el mensaje 'register' en la Fase 2.
 * - Estado dinámico (memoria libre, in-flight, RPS, uso de CPU): snapshot en
 *   vivo. Lo consumirá el 'heartbeat' en la Fase 2.
 *
 * El RPS se calcula como media móvil exponencial (EWMA) para que un pico puntual
 * no distorsione la medición.
 */
export default class MetricsCollector {
  constructor({ rpsAlpha = 0.3, rpsIntervalMs = 1000 } = {}) {
    this.inFlight = 0;

    this.rps = 0; // EWMA de respuestas por segundo
    this._completedInWindow = 0;
    this._alpha = rpsAlpha;
    this._intervalMs = rpsIntervalMs;
    this._timer = null;
  }

  // Capacidad estática del equipo. No cambia en runtime → se calcula una vez.
  getStaticCaps() {
    const cpus = os.cpus();
    return {
      cpuCores: cpus.length,
      cpuSpeed: cpus[0]?.speed ?? 0,
      totalMem: os.totalmem(),
    };
  }

  // Estado dinámico en vivo. Se muestrea en cada heartbeat.
  getDynamicMetrics() {
    return {
      freeMem: os.freemem(),
      inFlight: this.inFlight,
      rps: Number(this.rps.toFixed(2)),
      cpuUtil: this._cpuUtil(),
    };
  }

  // Uso de CPU aproximado: load average de 1 min normalizado por núcleos.
  _cpuUtil() {
    const cores = os.cpus().length || 1;
    const load1 = os.loadavg()[0];
    return Math.min(load1 / cores, 1);
  }

  // Contabilidad de peticiones en vuelo.
  requestStarted() {
    this.inFlight++;
  }

  requestFinished() {
    if (this.inFlight > 0) this.inFlight--;
    this._completedInWindow++;
  }

  // Arranca el cálculo periódico del EWMA de RPS.
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      const instantRps = this._completedInWindow / (this._intervalMs / 1000);
      this.rps = this._alpha * instantRps + (1 - this._alpha) * this.rps;
      this._completedInWindow = 0;
    }, this._intervalMs);
    // No mantener el proceso vivo solo por este timer.
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
