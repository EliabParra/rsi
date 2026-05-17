export function onJsonMessage(socket, callback) {
    let buffer = ''

    socket.on('data', (chunk) => {
        buffer += chunk.toString()

        let newlineIndex
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const raw = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)

            if (!raw) continue

            try {
                callback(JSON.parse(raw))
            } catch {
                console.error('Invalid message:', raw)
            }
        }
    })
}

export function writeJson(socket, data) {
    socket.write(JSON.stringify(data) + '\n')
}
