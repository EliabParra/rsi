import ClientRSI from './ClientRSI.js';
export default class ProxyCalculator extends ClientRSI {
    constructor(host, port) {
        super(host, port);
    }
    async suma(a, b) {
        return await this.sendBO({
            className: 'Calculator',
            method: 'addition',
            args: { a, b }
        });
    }
    async resta(a, b) {
        return await this.sendBO({
            className: 'Calculator',
            method: 'subtraction',
            args: { a, b }
        });
    }
    async multiplicacion(a, b) {
        return await this.sendBO({
            className: 'Calculator',
            method: 'multiplication',
            args: { a, b }
        });
    }
    async division(a, b) {
        return await this.sendBO({
            className: 'Calculator',
            method: 'division',
            args: { a, b }
        });
    }
}
