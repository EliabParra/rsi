import Net from 'net';
import { onJsonMessage, writeJson } from '../shared/jsonStream.js';

export default class ClientRSI {
    constructor(host = '127.0.0.1', port = 3000, options = {}) {
        this.host = host;
        this.port = port;
        this.clientId = options.clientId ?? null;
        this._reqSeq = 0;
    }

    send(payload) {
        return new Promise((resolve, reject) => {
            const client = Net.createConnection({ port: this.port, host: this.host }, () => {
                const outbound = { ...payload };
                if (this.clientId != null) {
                    this._reqSeq += 1;
                    outbound.clientId = this.clientId;
                    outbound.reqId = `${this.clientId}#${this._reqSeq}`;
                }
                writeJson(client, outbound);
            });

            onJsonMessage(client, (jsonData) => {
                resolve(jsonData);
                client.end();
            });

            client.on('error', (err) => {
                reject(err);
            });
        });
    }

    parseBOResponse(data) {
        if (data?.msg !== undefined && data?.result !== undefined) {
            // Deliberately exclude _meta — business result only.
            return { msg: data.msg, result: data.result };
        }
        if (data?.message) {
            throw new Error(data.message);
        }
        throw new Error('Respuesta inválida del servidor de objetos de negocio');
    }

    async sendBO(payload) {
        const raw = await this.send(payload);
        const business = this.parseBOResponse(raw);
        // Expose _meta alongside business data for callers that need routing info
        // (e.g. loadTest dashboard). Business fields are always at top level.
        if (raw._meta !== undefined) {
            business._meta = raw._meta;
        }
        return business;
    }
}
