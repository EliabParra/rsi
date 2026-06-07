import { getLocalIP } from "./getLocalIP.js";

export const config = {
  dispatcher: {
    host: getLocalIP(),
    port: 3000,
  },
  boServers: {
    calculator: [{ id: "calc-1", host: "172.20.243.176", port: 4001 }],
    equation: [{ id: "eq-1", host: "172.20.243.176", port: 4002 }],
  },
  clients: {
    client1: {
      host: "172.20.243.244",
      port: 5001,
    },
    client2: {
      host: "172.20.243.244",
      port: 5002,
    },
  },
  heartbeat: { interval: 2000, deadTimeout: 6000 },

  loadBalancer: {
    maxCores: 1,
    maxSpeed: 1,
    maxTotalMem: 1,
    maxInFlight: 1,
    maxRps: 1,

    wsCores: 0.2,
    wsSpeed: 0.2,
    wsMem: 0.1,
    wdInFlight: 0.3,
    wdRps: 0.2,
    interval: 2000,
  },
};
