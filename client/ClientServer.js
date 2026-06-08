import ProxyCriminal from './ProxyCriminal.js';

import { config } from '../shared/config.js';

const DISPATCHER_HOST = config.dispatcher.host;
const DISPATCHER_PORT = config.dispatcher.port;

async function runClientApp() {
    console.log('Inicializando Servidor Cliente...');

    const criminalProxy = new ProxyCriminal(DISPATCHER_HOST, DISPATCHER_PORT, { clientId: 'demo-client' });

    try {
        const resList = await criminalProxy.list({ limit: 5 });
        console.log('list(limit:5) — mensaje:', resList.msg, 'resultado:', resList.result);

        const resSearch = await criminalProxy.search('El Chapo');
        console.log('search("El Chapo") — mensaje:', resSearch.msg, 'resultado:', resSearch.result);

        const resGet = await criminalProxy.getById(1);
        console.log('getById(1) — mensaje:', resGet.msg, 'resultado:', resGet.result);

    } catch (err) {
        console.error('Error:', err.message);
    }
}

runClientApp();
