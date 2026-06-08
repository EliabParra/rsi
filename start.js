import os from 'os';
global.os = os;
import Dispatcher from './server/Dispatcher.js';

// Phase 1: demo BO servers (Calculator, Equations) removed.
// Phase 2 will wire config.boServers.Criminal into Dispatcher.loadBOServers.
const d = new Dispatcher();
d.init();
