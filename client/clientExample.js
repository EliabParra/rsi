import Net from 'net'
import { onJsonMessage, writeJson } from '../shared/jsonStream.js'

const dispatcherIP = '192.168.10.7' // Reemplaza con tu IP local

const calcJson = {
    className: 'Calculadora',
    methodName: 'sumar',
    params: [5, 3]
}


const client = Net.createConnection({ port: 3000, host: dispatcherIP }, () => {
    writeJson(client, calcJson)
})

onJsonMessage(client, (jsonData) => {
    console.log('Respuesta del servidor:', jsonData)
})

client.on('end', () => console.log('Desconectado del servidor'))
client.on('error', (err) => console.error(err))