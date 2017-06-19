import * as SocketIOServer from "socket.io"
import * as SocketIOClient from "socket.io-client"
import * as http from "http"
import * as Guid from "guid"
import * as events from "events"

import { GetUri } from "./utils"
import { VoidnetHandshakeHandler } from "./handshake"
import { VoidnetMessage, VoidnetMessageHandler } from "./message"

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
}

export class VoidnetConnection {
    public clientSocket: SocketIOClient.Socket
    public serverSocket: SocketIO.Socket
    protected eventEmitter: events.EventEmitter
    public readonly remoteMeta: VoidnetNodeMeta

    public connected(): boolean { return this.clientSocket.connected && this.serverSocket.connected }

    constructor(client: SocketIOClient.Socket, server: SocketIO.Socket, remoteMeta: VoidnetNodeMeta) {
        this.clientSocket = client
        this.serverSocket = server
        this.remoteMeta = remoteMeta
        this.eventEmitter = new events.EventEmitter()
        this.MapEvents()
    }

    private OnDisconnection = () => {
        if(this.clientSocket.connected) this.clientSocket.disconnect()
        if(this.serverSocket.connected) this.serverSocket.disconnect(true)
        this.eventEmitter.emit("disconnected", this)
    }

    private MapEvents(): void {
        this.clientSocket.on("disconnected", this.OnDisconnection)
        this.serverSocket.on("disconnect", this.OnDisconnection)
        this.clientSocket.on("message", (message) => this.eventEmitter.emit("message", message))
    }

    public on(event: string, listener: Function): void {
        this.eventEmitter.on(event, listener)
    }

    public send(message: VoidnetMessage): void {
        this.serverSocket.emit("message", message)
    }

    public disconnect() {
        this.eventEmitter.removeAllListeners()
        this.clientSocket.disconnect()
        this.serverSocket.disconnect(true)
    }
}

export class VoidnetServer {
    protected server: http.Server
    protected io: SocketIO.Server
    protected eventEmitter: events.EventEmitter
    protected handshakeHandler: VoidnetHandshakeHandler
    protected messageHandler: VoidnetMessageHandler

    public readonly meta: VoidnetNodeMeta
    protected connections: Map<string, VoidnetConnection>

    get connectionCount(): Number { return this.connections.size }

    constructor(hostname: string, port: number) {
        this.meta = new VoidnetNodeMeta({
            hostname: hostname,
            port: port
        })
        this.handshakeHandler = this.CreateHandshakeHandler(this.meta)
        this.handshakeHandler.on("success", this.HandleSuccessfullHandshake)
        this.messageHandler = new VoidnetMessageHandler(this.meta)
        this.messageHandler.OnEvent("received", (message) => this.SendToAll(message))
        this.server = http.createServer()
        this.io = SocketIOServer(this.server)
        this.io.on("connection", this.handshakeHandler.HandleIncoming)
        this.server.listen(port, hostname)
        this.connections = new Map<string, VoidnetConnection>()
    }

    // Voidnet events
    // voidnet-connect (remoteGuid) -- broadcasted by a node when it forms a connection
    // voidnet-disconnect (remoteGuid) -- broadcasted by a node when it disconnects

    protected CreateHandshakeHandler(meta: VoidnetNodeMeta): VoidnetHandshakeHandler {
        return new VoidnetHandshakeHandler(this.meta)
    }

    private HandleSuccessfullHandshake = (connection: VoidnetConnection) => {
        this.connections.set(connection.remoteMeta.guid, connection)
        connection.on("message", (message) => {
            this.messageHandler.ProcessMessage(message)
        })
        this.Broadcast("voidnet-connect", connection.remoteMeta.guid)
    }

    public Connect(uri: string) {
        this.handshakeHandler.Connect(uri)
    }

    public OnConnection(listener: Function) {
        this.handshakeHandler.on("success", listener)
    }

    public OnMessage(event: string, listener: Function) {
        this.messageHandler.OnMessage(event, listener)
    }

    private SendToAll(message: VoidnetMessage) {
        this.connections.forEach(connection => {
            connection.send(message)
        })
    }

    public Broadcast(type: string, data: any) {
        this.SendToAll(this.messageHandler.MakeMessage(type, data))
    }

    public Disconnect(guid: string) {
        if(this.connections.has(guid)) {
            const connection = this.connections.get(guid)
            this.connections.delete(guid)
            connection.disconnect()
        }
        this.Broadcast("voidnet-disconnect", guid)
    }
}
