import * as SocketIOServer from "socket.io"
import * as SocketIOClient from "socket.io-client"
import * as http from "http"
import * as Guid from "guid"
import * as events from "events"

import { GetUri } from "./utils"
import { VoidnetHandshakeHandler } from "./handshake"
import { VoidnetMessage, VoidnetMessageHandler } from "./message"
import { VoidnetMap } from "./map"

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
    }

    public OnEvent(event: string, listener: Function): void {
        this.eventEmitter.on(event, listener)
    }

    public OnClient(event: string, listener: Function): void {
        this.clientSocket.on(event, listener)
    }

    public OnServer(event: string, listener: Function): void {
        this.serverSocket.on(event, listener)
    }

    public Emit(event: string, args: any[]) {
        this.serverSocket.emit(event, args)
    }

    public Broadcast(message: VoidnetMessage): void {
        this.serverSocket.emit("message", message)
    }

    public Disconnect() {
        this.eventEmitter.removeAllListeners()
        this.clientSocket.removeAllListeners()
        this.serverSocket.removeAllListeners()
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
    protected voidnetMap: VoidnetMap

    public readonly meta: VoidnetNodeMeta
    protected connections: Map<string, VoidnetConnection>

    get connectionCount(): Number { return this.connections.size }
    get networkMap(): Map<string, string[]> { return this.voidnetMap.networkMap }

    constructor(hostname: string, port: number) {
        this.meta = new VoidnetNodeMeta({
            hostname: hostname,
            port: port
        })
        this.voidnetMap = new VoidnetMap()
        this.handshakeHandler = this.CreateHandshakeHandler(this.meta)
        this.handshakeHandler.on("success", this.HandleSuccessfullHandshake)
        this.messageHandler = new VoidnetMessageHandler(this.meta)
        this.messageHandler.OnEvent("received", (message) => this.SendToAll(message))
        this.messageHandler.OnMessage("voidnet-connect", this.voidnetMap.HandleEvents)
        this.messageHandler.OnMessage("voidnet-disconnect", this.voidnetMap.HandleEvents)
        this.server = http.createServer()
        this.io = SocketIOServer(this.server)
        this.io.on("connection", this.handshakeHandler.HandleIncoming)
        this.server.listen(port, hostname)
        this.connections = new Map<string, VoidnetConnection>()
    }

    // Voidnet events
    // message -> voidnet-connect (remoteGuid) -- broadcasted by a node when it forms a connection
    // message -> voidnet-disconnect (remoteGuid) -- broadcasted by a node when it disconnects
    // map (map) -- sent by both nodes in private after a successfull handshake

    protected CreateHandshakeHandler(meta: VoidnetNodeMeta): VoidnetHandshakeHandler {
        return new VoidnetHandshakeHandler(this.meta)
    }

    private HandleSuccessfullHandshake = (connection: VoidnetConnection) => {
        this.connections.set(connection.remoteMeta.guid, connection)
        connection.OnClient("message", this.messageHandler.ProcessMessage)
        connection.OnClient("map", this.voidnetMap.HandleEvents)
        const message = this.Broadcast("voidnet-connect", connection.remoteMeta.guid)
        this.voidnetMap.HandleEvents(message)
        connection.Emit("map", this.voidnetMap.GetNewestEvents())
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
            connection.Broadcast(message)
        })
    }

    public Broadcast(type: string, data: any) {
        const message = this.messageHandler.MakeMessage(type, data)
        this.SendToAll(message)
        return message
    }

    public Disconnect(guid: string) {
        if(this.connections.has(guid)) {
            const connection = this.connections.get(guid)
            this.connections.delete(guid)
            connection.Disconnect()
        }
        const message = this.Broadcast("voidnet-disconnect", guid)
        this.voidnetMap.HandleEvents(message)
    }
}
