import os from 'os'

export function getLocalIP() {
    let interfaces

    try {
        interfaces = os.networkInterfaces()
    } catch (error) {
        console.warn(`No se pudo obtener la IP local (${error.message}). Usando 127.0.0.1`)
        return '127.0.0.1'
    }

    for (const interfaceName in interfaces) {
        const addresses = interfaces[interfaceName]
        for (const address of addresses)
            if (address.family === 'IPv4' && !address.internal)
                return address.address
    }
    return '127.0.0.1'
}
