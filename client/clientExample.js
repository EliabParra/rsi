import Net from 'net'

const dispatcherIP = '192.168.10.7' // Reemplaza con tu IP local

const client = Net.createConnection({ port: 3000, host: dispatcherIP }, () => {
    console.log('Conectado al servidor')
    client.write('Hola, servidor!')
})

client.on('data', (data) => {
    console.log('Respuesta del servidor:', data.toString())
    client.end()
})

client.on('end', () => console.log('Desconectado del servidor'))
client.on('error', (err) => console.error(err))