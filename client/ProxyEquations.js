import ClientRSI from './ClientRSI.js';
export default class ProxyEquations extends ClientRSI {
    constructor(host, port) {
        super(host, port);
    }
    async cuadratica(a, b, c) {
        return await this.sendBO({
            className: 'Equations',
            method: 'quadratic',
            args: { a, b, c }
        });
    }
}
