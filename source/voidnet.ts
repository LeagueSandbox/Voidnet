import * as SocketIOServer from "socket.io"
import * as SocketIOClient from "socket.io-client"
import * as http from "http"
import * as Guid from "guid"

export class VoidnetNodeMeta {
    public readonly hostname: string
    public readonly port: number
    public readonly guid: string

    get uri(): string { return this.hostname + ":" + this.port }

    constructor(hostname: string, port: number) {
        this.hostname = hostname
        this.port = port
        this.guid = Guid.create().value;
    }
}

class VoidnetHandshakeDatum {
    public readonly meta: VoidnetNodeMeta
    public readonly extra: string

    get hostname(): string { return this.meta.hostname }
    get port(): number { return this.meta.port }
    get guid(): string { return this.meta.guid }
    get uri(): string { return this.meta.uri }

    constructor(meta: VoidnetNodeMeta, extra: string) {
        this.meta = meta
        this.extra = extra
    }
}

// Voidnet Connection Handshake
//
// away node opens websocket client connection to local node
// away node client sends a "handshake" event with node meta + secret
// local node server responds with own node meta
// local node opens a websocket client connection to away node
// local node client sends a "handshake-ack" event with node meta
// away node server responds with node meta + secret
// local node validates meta + secret and server sends "handshake-result" with "success" or "fail"
//
// If any step fails, the connection is terminated

function HandleHandshake(
    serverSocket: SocketIO.Socket,
    localMeta: VoidnetNodeMeta,
    handshakeAckCallback: Function,
    successfullHandshakeCallback: Function) {

    // Away node is initiating connection to local node
    serverSocket.on("handshake", (remoteHandshake: VoidnetHandshakeDatum, respond: Function) => {
        serverSocket.removeAllListeners("handshake")
        serverSocket.removeAllListeners("handshake-ack")

        // Respond with our meta
        respond(localMeta)

        // Form a client connection to the node wanting to connect
        const clientSocket = SocketIOClient(remoteHandshake.uri)
        clientSocket.on("connect", () => {

            // Send the "handshake-ack" event with our meta
            clientSocket.emit("handshake-ack", localMeta, (remoteVerify: VoidnetHandshakeDatum) => {

                // Make sure we connected to the same node that connected to us
                // Do this by verifying the meta and the secret are the same
                const check = (
                    remoteHandshake.uri == remoteVerify.uri &&
                    remoteHandshake.guid == remoteVerify.guid &&
                    remoteHandshake.extra == remoteVerify.extra // Secret
                )

                // This wasn't the same node
                // Inform the node the handshake failed and close connections
                if(!check) {
                    serverSocket.emit("handshake-result", new VoidnetHandshakeDatum(localMeta, "fail"))
                    serverSocket.disconnect(true)
                    clientSocket.disconnect()
                    return
                }

                // This was the same node, handshake should be Successfull
                // We now have connected to the node as the client and as the server
                serverSocket.emit("handshake-result", new VoidnetHandshakeDatum(localMeta, "success"))
                console.log("Successfull handshake")
                successfullHandshakeCallback(new VoidnetConnection(
                    clientSocket,
                    serverSocket,
                    remoteHandshake.meta
                ))
            })
        })
    })

    // Local node is initiating connection to away node
    serverSocket.on("handshake-ack", (remoteMeta: VoidnetNodeMeta, verify: Function) => {
        serverSocket.removeAllListeners("handshake")
        serverSocket.removeAllListeners("handshake-ack")
        handshakeAckCallback(serverSocket, remoteMeta, verify)
    })
}

class PendingHandshake {
    public readonly handshakeDatum: VoidnetHandshakeDatum
    public readonly remoteMeta: VoidnetNodeMeta
    public readonly clientSocket: SocketIOClient.Socket
    public serverSocket: SocketIO.Socket

    constructor(
        clientSocket: SocketIOClient.Socket,
        handshakeDatum: VoidnetHandshakeDatum,
        remoteMeta: VoidnetNodeMeta) {
            this.clientSocket = clientSocket
            this.remoteMeta = remoteMeta
            this.handshakeDatum = handshakeDatum
    }

    public ToVoidnetConnection(): VoidnetConnection {
        return new VoidnetConnection(
            this.clientSocket,
            this.serverSocket,
            this.remoteMeta
        )
    }
}

interface Dictionary<T> {
    [x: string]: T
}

class VoidnetHandshakeHandler {
    meta: VoidnetNodeMeta
    pendingHandshakes: Dictionary<PendingHandshake>
    handshakeSuccessHandler: Function

    constructor(meta: VoidnetNodeMeta, handshakeSuccessHandler: Function) {
        this.meta = meta
        this.pendingHandshakes = {}
        this.handshakeSuccessHandler = handshakeSuccessHandler
    }

    public HandleIncoming(socket): void {
        HandleHandshake(socket, this.meta, this.HandleHandshakeAck, this.handshakeSuccessHandler)
    }

    private HandleHandshakeAck(serverSocket: SocketIO.Socket, remoteMeta: VoidnetNodeMeta, verify: Function) {
        if(this.pendingHandshakes.hasOwnProperty(remoteMeta.guid)) {
            const pendingHandshake = this.pendingHandshakes[remoteMeta.guid]
            pendingHandshake.serverSocket = serverSocket
            verify(pendingHandshake.handshakeDatum)
        } else {
            serverSocket.disconnect(true)
        }
    }

    private HandleHandshakeReslt(result: VoidnetHandshakeDatum) {
        if(this.pendingHandshakes.hasOwnProperty(result.guid)) {
            const pendingHandshake = this.pendingHandshakes[result.guid]
            delete this.pendingHandshakes[result.guid]
            if(result.extra === "success") {
                this.handshakeSuccessHandler(pendingHandshake.ToVoidnetConnection())
            }
            else {
                pendingHandshake.clientSocket.disconnect()
                pendingHandshake.serverSocket.disconnect(true)
            }
        }
    }

    public Connect(uri: string): void {
        const clientSocket = SocketIOClient(uri)
        const handshakeDatum = new VoidnetHandshakeDatum(this.meta, "kek")
        clientSocket.on("handshake-result", this.HandleHandshakeReslt)
        clientSocket.emit("handshake", handshakeDatum, (remoteMeta: VoidnetNodeMeta) => {
            this.pendingHandshakes[remoteMeta.guid] = new PendingHandshake(
                clientSocket,
                handshakeDatum,
                remoteMeta
            )
        })
    }
}

class VoidnetServer {
    protected server: http.Server
    protected io: SocketIO.Server
    protected handshakeHandler: VoidnetHandshakeHandler

    protected meta: VoidnetNodeMeta
    protected connections: VoidnetConnection[]

    constructor(hostname: string, port: number) {
        this.meta = new VoidnetNodeMeta(hostname, port)
        this.handshakeHandler = new VoidnetHandshakeHandler(this.meta, this.HandleSuccessfullHandshake)
        this.io = SocketIOServer(this.server)
        this.io.on("connection", this.handshakeHandler.HandleIncoming)
        this.server = http.createServer(io)
        this.server.listen(port, hostname)
    }

    private HandleSuccessfullHandshake(connection: VoidnetConnection) {
        this.connections.push(connection)
    }

    public Connect(uri: string) {
        this.handshakeHandler.Connect(uri)
    }
}

class VoidnetConnection {
    protected clientSocket: SocketIOClient.Socket
    protected serverSocket: SocketIO.Socket
    public readonly remoteMeta: VoidnetNodeMeta

    constructor(client: SocketIOClient.Socket, server: SocketIO.Socket, remoteMeta: VoidnetNodeMeta) {
        this.clientSocket = client
        this.serverSocket = server
        this.remoteMeta = remoteMeta
    }
}
