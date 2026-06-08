import ClientRSI from './ClientRSI.js';

export default class ProxyCriminal extends ClientRSI {
    constructor(host, port, options = {}) {
        super(host, port, options);
    }

    async create(args) {
        return this.sendBO({ className: 'Criminal', method: 'create', args });
    }

    async getById(id) {
        return this.sendBO({ className: 'Criminal', method: 'getById', args: { id } });
    }

    async list(args = {}) {
        return this.sendBO({ className: 'Criminal', method: 'list', args });
    }

    async search(q) {
        return this.sendBO({ className: 'Criminal', method: 'search', args: { q } });
    }

    async update(args) {
        return this.sendBO({ className: 'Criminal', method: 'update', args });
    }

    async remove(id) {
        return this.sendBO({ className: 'Criminal', method: 'remove', args: { id } });
    }
}
