import Net from 'net';
import { onJsonMessage, writeJson } from '../shared/jsonStream.js';

export default class ClientRSI {
    constructor(host = '127.0.0.1', port = 3000) {
        this.host = host;
        this.port = port;
    }

    send(payload) {
        return new Promise((resolve, reject) => {
            const client = Net.createConnection({ port: this.port, host: this.host }, () => {
                writeJson(client, payload);
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
            return { msg: data.msg, result: data.result };
        }
        if (data?.message) {
            throw new Error(data.message);
        }
        throw new Error('Respuesta inválida del servidor de objetos de negocio');
    }

    async sendBO(payload) {
        const raw = await this.send(payload);
        return this.parseBOResponse(raw);
    }
}

