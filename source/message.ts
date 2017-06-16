import * as events from "events"
import * as Guid from "guid"
import * as Validator from "validator"

import { VoidnetNodeMeta } from "./voidnet"

export class VoidnetMessage {
    public readonly sender: string
    public readonly id: number
    public readonly type: string
    public readonly data: any

    constructor(params: {sender: string, id: number, type: string, data: any}) {
        this.sender = params.sender
        this.id = params.id
        this.type = params.type
        this.data = params.data
    }

    public Validate(): boolean {
        return (
            Guid.isGuid(String(this.sender)) &&
            Validator.isInt(String(this.id)) &&
            Validator.isLength(String(this.type), 1)
        )
    }
}

// Minimum time messages have to arrive before assuming loss, default 10 seconds
// Also the time packet IDs are kept in memory for duplicate checking
const MESSAGE_TIMEOUT: number = 10 * 1000

export class VoidnetMessageTracker {
    protected seenMessageIds: number[]
    protected highestDiscardedId: number

    public get messageTimeout(): number { return MESSAGE_TIMEOUT }

    constructor() {
        this.seenMessageIds = []
        this.highestDiscardedId = -1
    }

    public IsMessageOld(message: VoidnetMessage): boolean {
        if(message.id <= this.highestDiscardedId) return true
        return message.id in this.seenMessageIds
    }

    public Track(message: VoidnetMessage): void {
        this.seenMessageIds[message.id] = undefined
        setTimeout(() => {
            if(this.highestDiscardedId < message.id) {
                this.highestDiscardedId = message.id
            }
            delete this.seenMessageIds[message.id]
        }, this.messageTimeout)
    }
}

export class VoidnetMessageHandler {
    protected meta: VoidnetNodeMeta
    protected lastId: number
    protected messageTrackers: Map<string, VoidnetMessageTracker>
    protected eventEmitter: events.EventEmitter
    protected rejectedCounter: number

    public get rejectedMessageCount(): number { return this.rejectedCounter }

    constructor(meta: VoidnetNodeMeta) {
        this.meta = meta
        this.lastId = 0
        this.messageTrackers = new Map<string, VoidnetMessageTracker>()
        this.messageTrackers.set(meta.guid, this.CreateMessageTracker())
        this.eventEmitter = new events.EventEmitter()
        this.rejectedCounter = 0
    }

    public MakeMessage(type: string, data: any): VoidnetMessage {
        const message = new VoidnetMessage({
            sender: this.meta.guid,
            id: this.lastId++,
            type: type,
            data: data
        })
        this.messageTrackers.get(this.meta.guid).Track(message)
        return message
    }

    public on(event: string, listener: Function): void {
        this.eventEmitter.on(event, listener)
    }

    protected CreateMessageTracker(): VoidnetMessageTracker {
        return new VoidnetMessageTracker()
    }

    public ProcessMessage = (message: VoidnetMessage) => this._ProcessMessage(message)
    protected _ProcessMessage(message: VoidnetMessage): void {
        // Re-initialize the object, since we actually have received just it's data (and no functions)
        message = new VoidnetMessage(message)

        // Validate the message, return if it isn't valid
        if(!message.Validate()) {
            this.rejectedCounter++
            return
        }

        // Make sure we have a map of seen messages for the sender
        if(!this.messageTrackers.has(message.sender)) {
            this.messageTrackers.set(message.sender, this.CreateMessageTracker())
        }

        // Ignore this message if we've already seen it once
        if(this.messageTrackers.get(message.sender).IsMessageOld(message)) {
            this.rejectedCounter++
            return
        }

        // This is a new message; add it to our seen messages and fire the message received event
        this.messageTrackers.get(message.sender).Track(message)
        this.eventEmitter.emit(message.type, message)
    }
}
