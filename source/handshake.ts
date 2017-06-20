import * as SocketIOServer from "socket.io"
import * as SocketIOClient from "socket.io-client"
import * as events from "events"

import { VoidnetNodeMeta, VoidnetConnection } from "./voidnet"
import { GetUri } from "./utils"

export interface VoidnetHandshakeDatum {
    hostname: string
    port: number
    guid: string
    data: string
}

function MakeHandshakeDatum(meta: VoidnetNodeMeta, data: string): VoidnetHandshakeDatum {
    return {
        "hostname": meta.hostname,
        "port": meta.port,
        "guid": meta.guid,
        "data": data
    }
}

export class VoidnetPendingHandshake {
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
    protected pendingHandshakes: Map<string, VoidnetPendingHandshake>
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
            pendingHandshake.clientSocket.removeEventListener("handshake-result", this.HandleHandshakeResult)
            if(result.data === "success") {
                this.eventEmitter.emit("success", pendingHandshake.ToVoidnetConnection())
            }
            else {
                this.eventEmitter.emit("failure", pendingHandshake.remoteMeta.uri)
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
                serverSocket.emit("handshake-result", MakeHandshakeDatum(this.meta, "fail"))
                this.eventEmitter.emit("failure", GetUri(remoteHandshake))
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
                    serverSocket.emit("handshake-result", MakeHandshakeDatum(this.meta, "success"))
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

    private AttemptConnect(uri: string): void {
        const clientSocket = SocketIOClient(uri).connect()
        const handshakeDatum = MakeHandshakeDatum(this.meta, "kek")
        clientSocket.on("handshake-result", this.HandleHandshakeResult)
        clientSocket.on("connect", () => {
            clientSocket.emit("handshake", handshakeDatum, (remoteMeta: VoidnetNodeMeta) => {
                this.pendingHandshakes.set(remoteMeta.guid, new VoidnetPendingHandshake(
                    clientSocket,
                    handshakeDatum,
                    new VoidnetNodeMeta(remoteMeta)
                ))
            })
        })
    }

    public Connect(uri: string): Promise<VoidnetConnection> {
        return new Promise((resolve, reject) => {
            this.AttemptConnect(uri)
            const handleSuccess = (connection: VoidnetConnection) => {
                if(connection.remoteMeta.uri !== uri) return
                this.eventEmitter.removeListener("success", handleSuccess)
                this.eventEmitter.removeListener("failure", handleFailure)
                resolve(connection)
            }
            const handleFailure = (failUri) => {
                if(failUri !== uri) return
                this.eventEmitter.removeListener("success", handleSuccess)
                this.eventEmitter.removeListener("failure", handleFailure)
                reject()
            }
            this.eventEmitter.on("success", handleSuccess)
            this.eventEmitter.on("failure", handleFailure)
        })
    }

    public on(event: string, callback: Function) {
        this.eventEmitter.on(event, callback)
    }
}