import ProxyCalculator from './ProxyCalculator.js';
import ProxyEquations from './ProxyEquations.js';

const BO_HOST = '127.0.0.1';
const CALCULATOR_PORT = 4001;
const EQUATIONS_PORT = 4002;

async function runClientApp() {
    console.log('Inicializando Servidor Cliente...');

    const calcProxy = new ProxyCalculator(BO_HOST, CALCULATOR_PORT);
    const ecProxy = new ProxyEquations(BO_HOST, EQUATIONS_PORT);

    try {
        const resSuma = await calcProxy.suma(5, 5);
        console.log('Suma(5, 5) — mensaje:', resSuma.msg, 'resultado:', resSuma.result);

        const resResta = await calcProxy.resta(20, 8);
        console.log('Resta(20, 8) — mensaje:', resResta.msg, 'resultado:', resResta.result);

        const resMult = await calcProxy.multiplicacion(4, 5);
        console.log('Multiplicacion(4, 5) — mensaje:', resMult.msg, 'resultado:', resMult.result);

        const resDiv = await calcProxy.division(10, 2);
        console.log('Division(10, 2) — mensaje:', resDiv.msg, 'resultado:', resDiv.result);

        const resCuadratica = await ecProxy.cuadratica(1, -5, 6);
        console.log('Cuadratica(1, -5, 6) — mensaje:', resCuadratica.msg, 'resultado:', resCuadratica.result);

    } catch (err) {
        console.error('Error:', err.message);
    }
}

runClientApp();