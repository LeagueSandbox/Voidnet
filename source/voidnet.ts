import * as SocketIOServer from "socket.io"
import * as SocketIOClient from "socket.io-client"
import * as http from "http"
import * as Guid from "guid"
import * as events from "events"

export class VoidnetNodeMeta {
    public readonly hostname: string
    public readonly port: number
    public readonly guid: string

    get uri() { return GetUri(this) }

    constructor(data: {hostname: string, port: number, guid?: string}) {
        this.hostname = data.hostname
        this.port = data.port
        this.guid = data.guid;
        if(this.guid === undefined) {
            this.guid = Guid.create().value;
        }
    }

    ToHandshakeDatum(data?: string): VoidnetHandshakeDatum {
        return {
            "hostname": this.hostname,
            "port": this.port,
            "guid": this.guid,
            "data": data
        }
    }
}

export function GetUri({hostname, port}): string {
    return "http://" + hostname + ":" + port
}

export interface VoidnetHandshakeDatum {
    hostname: string
    port: number
    guid: string
    data: string
}

export class PendingHandshake {
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

export class VoidnetHandshakeHandler {
    private readonly _meta: VoidnetNodeMeta
    protected pendingHandshakes: Map<string, PendingHandshake>
    protected handshakeSuccessHandler: Function
    protected eventEmitter: events.EventEmitter

    get meta(): VoidnetNodeMeta {
        return this._meta
    }

    constructor(meta: VoidnetNodeMeta) {
        this._meta = meta
        this.pendingHandshakes = new Map()
        this.eventEmitter = new events.EventEmitter()
    }

    public HandleIncoming = (socket): void => {
        this.HandleHandshake(socket)
    }

    protected HandleHandshakeAck = (serverSocket: SocketIO.Socket, remoteMeta: VoidnetNodeMeta, verify: Function) => {
        if(this.pendingHandshakes.has(remoteMeta.guid)) {
            const pendingHandshake = this.pendingHandshakes.get(remoteMeta.guid)
            pendingHandshake.serverSocket = serverSocket
            verify(pendingHandshake.handshakeDatum)
        } else {
            serverSocket.disconnect(true)
        }
    }

    private HandleHandshakeResult = (result: VoidnetHandshakeDatum) => {
        if(this.pendingHandshakes.has(result.guid)) {
            const pendingHandshake = this.pendingHandshakes.get(result.guid)
            this.pendingHandshakes.delete(result.guid)
            if(result.data === "success") {
                this.eventEmitter.emit("success", pendingHandshake.ToVoidnetConnection())
            }
            else {
                this.eventEmitter.emit("failure")
                pendingHandshake.clientSocket.disconnect()
                if(pendingHandshake.serverSocket !== undefined) {
                    pendingHandshake.serverSocket!.disconnect(true)
                }
            }
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
    private HandleHandshake(serverSocket: SocketIO.Socket) {

        // Away node is initiating connection to local node
        serverSocket.on("handshake", (remoteHandshake: VoidnetHandshakeDatum, respond: Function) => {
            serverSocket.removeAllListeners("handshake")
            serverSocket.removeAllListeners("handshake-ack")

            // Respond with our meta
            respond(this.meta)

            // Form a client connection to the node wanting to connect
            const clientSocket = SocketIOClient(GetUri(remoteHandshake))

            const fail = () => {
                serverSocket.emit("handshake-result", this.meta.ToHandshakeDatum("fail"))
                this.eventEmitter.emit("failure")
                serverSocket.disconnect(true)
                clientSocket.disconnect()
            }

            clientSocket.on("disconnect", fail)
            clientSocket.on("connect", () => {

                // Send the "handshake-ack" event with our meta
                clientSocket.emit("handshake-ack", this.meta, (remoteVerify: VoidnetHandshakeDatum) => {

                    // Make sure we connected to the same node that connected to us
                    // Do this by verifying the meta and the secret are the same
                    const check = (
                        GetUri(remoteHandshake) == GetUri(remoteVerify) &&
                        remoteHandshake.guid == remoteVerify.guid &&
                        remoteHandshake.data == remoteVerify.data // Should be the secret in this frame
                    )

                    // This wasn't the same node
                    // Inform the node the handshake failed and close connections
                    if(!check) {
                        return fail()
                    }

                    // This was the same node, handshake should be Successfull
                    // We now have connected to the node as the client and as the server
                    clientSocket.removeListener("disconnect", fail)
                    serverSocket.emit("handshake-result", this.meta.ToHandshakeDatum("success"))
                    this.eventEmitter.emit("success", new VoidnetConnection(
                        clientSocket,
                        serverSocket,
                        new VoidnetNodeMeta(remoteHandshake)
                    ))
                })
            })
        })

        // Local node is initiating connection to away node
        serverSocket.on("handshake-ack", (remoteMeta: VoidnetNodeMeta, verify: Function) => {
            serverSocket.removeAllListeners("handshake")
            serverSocket.removeAllListeners("handshake-ack")
            this.HandleHandshakeAck(serverSocket, remoteMeta, verify)
        })
    }

    public Connect(uri: string): void {
        const clientSocket = SocketIOClient(uri).connect()
        const handshakeDatum = this.meta.ToHandshakeDatum("kek")
        clientSocket.on("handshake-result", this.HandleHandshakeResult)
        clientSocket.on("connect", () => {
            clientSocket.emit("handshake", handshakeDatum, (remoteMeta: VoidnetNodeMeta) => {
                this.pendingHandshakes.set(remoteMeta.guid, new PendingHandshake(
                    clientSocket,
                    handshakeDatum,
                    remoteMeta
                ))
            })
        })
    }

    public on(event: string, callback: Function) {
        this.eventEmitter.on(event, callback)
    }
}

export class VoidnetServer {
    protected server: http.Server
    protected io: SocketIO.Server
    protected eventEmitter: events.EventEmitter
    public handshakeHandler: VoidnetHandshakeHandler

    public readonly meta: VoidnetNodeMeta
    protected connections: VoidnetConnection[]

    get connectionCount(): Number { return this.connections.length }

    constructor(hostname: string, port: number) {
        this.meta = new VoidnetNodeMeta({
            hostname: hostname,
            port: port
        })
        this.handshakeHandler = this.GetHandshakeHandler(this.meta)
        this.handshakeHandler.on("success", this.HandleSuccessfullHandshake)
        this.server = http.createServer()
        this.io = SocketIOServer(this.server)
        this.io.on("connection", this.handshakeHandler.HandleIncoming)
        this.server.listen(port, hostname)
        this.eventEmitter = new events.EventEmitter()
        this.connections = []
    }

    protected GetHandshakeHandler(meta: VoidnetNodeMeta): VoidnetHandshakeHandler {
        return new VoidnetHandshakeHandler(this.meta)
    }

    private HandleSuccessfullHandshake = (connection: VoidnetConnection) => {
        this.connections.push(connection)
        this.eventEmitter.emit("connection", connection)
    }

    public Connect(uri: string) {
        this.handshakeHandler.Connect(uri)
    }

    public on(event: string, callback: Function) {
        this.eventEmitter.on(event, callback)
    }
}

export class VoidnetConnection {
    protected clientSocket: SocketIOClient.Socket
    protected serverSocket: SocketIO.Socket
    public readonly remoteMeta: VoidnetNodeMeta

    constructor(client: SocketIOClient.Socket, server: SocketIO.Socket, remoteMeta: VoidnetNodeMeta) {
        this.clientSocket = client
        this.serverSocket = server
        this.remoteMeta = remoteMeta
    }
}
