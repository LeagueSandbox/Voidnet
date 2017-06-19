import * as events from "events"

export function GetUri({hostname, port}): string {
    return "http://" + hostname + ":" + port
}

export class ValueMonitor<T> {
    protected _value: T
    protected eventEmitter: events.EventEmitter

    constructor(initial?: T) {
        this._value = initial
        this.eventEmitter = new events.EventEmitter()
    }

    get value(): T {
        this.eventEmitter.emit("get", this._value)
        return this._value
    }
    set value(value: T) {
        this.eventEmitter.emit("set", value, this._value)
        this._value = value
    }

    public on(event: string, listener: Function) {
        this.eventEmitter.on(event, listener)
    }
}
