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
        this.eventEmitter.emit("disconnected")
    }

    private MapEvents(): void {
        this.clientSocket.on("disconnected", this.OnDisconnection)
        this.serverSocket.on("disconnect", this.OnDisconnection)
        this.clientSocket.on("message", (message) => this.eventEmitter.emit("message", message))
    }

    public on(event: string, listener: Function) {
        this.eventEmitter.on(event, listener)
    }

    public send(message: VoidnetMessage) {
        this.serverSocket.emit("message", message)
    }
}

export class VoidnetServer {
    protected server: http.Server
    protected io: SocketIO.Server
    protected eventEmitter: events.EventEmitter
    protected handshakeHandler: VoidnetHandshakeHandler
    protected messageHandler: VoidnetMessageHandler

    public readonly meta: VoidnetNodeMeta
    protected connections: VoidnetConnection[]

    get connectionCount(): Number { return this.connections.length }

    constructor(hostname: string, port: number) {
        this.meta = new VoidnetNodeMeta({
            hostname: hostname,
            port: port
        })
        this.handshakeHandler = this.CreateHandshakeHandler(this.meta)
        this.handshakeHandler.on("success", this.HandleSuccessfullHandshake)
        this.messageHandler = new VoidnetMessageHandler(this.meta)
        this.messageHandler.on("received", (message) => this.sendToAll(message))
        this.server = http.createServer()
        this.io = SocketIOServer(this.server)
        this.io.on("connection", this.handshakeHandler.HandleIncoming)
        this.server.listen(port, hostname)
        this.eventEmitter = new events.EventEmitter()
        this.connections = []
    }

    protected CreateHandshakeHandler(meta: VoidnetNodeMeta): VoidnetHandshakeHandler {
        return new VoidnetHandshakeHandler(this.meta)
    }

    private HandleSuccessfullHandshake = (connection: VoidnetConnection) => {
        this.connections.push(connection)
        connection.on("message", (message) => {
            this.messageHandler.ProcessMessage(message)
        })
        this.eventEmitter.emit("connection", connection)
    }

    public Connect(uri: string) {
        this.handshakeHandler.Connect(uri)
    }

    public on(event: string, listener: Function) {
        this.eventEmitter.on(event, listener)
    }

    public onMessage(event: string, listener: Function) {
        this.messageHandler.onMessage(event, listener)
    }

    private sendToAll(message: VoidnetMessage) {
        this.connections.forEach(connection => {
            connection.send(message)
        })
    }

    public broadcast(type: string, data: any) {
        this.sendToAll(this.messageHandler.MakeMessage(type, data))
    }
}

export class VoidnetNode {
    protected server: VoidnetServer

    public meta(): VoidnetNodeMeta { return this.server.meta }

    constructor(hostname: string, port: number) {
        this.server = new VoidnetServer(hostname, port)
    }

    public broadcast(event: string, data: any) {
        // Broadcast a packet to entire network
    }

    public on(event: string, callback: Function) {
        // Hook to internal events
    }
}
