import * as Guid from "guid"

import { VoidnetMessage } from "./message"

export class VoidnetMap {
    protected completeConnections: Map<string, string[]>
    protected reportedConnections: Map<string, Map<string, VoidnetMessage>>

    public get networkMap(): Map<string, string[]> {
        return this.completeConnections
    }

    constructor() {
        this.completeConnections = new Map<string, string[]>()
        this.reportedConnections = new Map<string, Map<string, VoidnetMessage>>()
    }

    public GetNewestEvents(): VoidnetMessage[] {
        const result: VoidnetMessage[] = []
        this.reportedConnections.forEach((eventMap, nodeId) => {
            eventMap.forEach(entry => {
                result.push(entry)
            })
        })
        return result
    }

    public HandleEvents = (event: VoidnetMessage | VoidnetMessage[]): void => {
        if(Array.isArray(event)) {
            (<VoidnetMessage[]>event).forEach((event) => {
                this.ProcessEvent(event)
            })
        }
        else {
            this.ProcessEvent(event)
        }
        this.AggregateConnections()
    }

    protected AggregateConnections() {
        const connectionMap = new Map<string, string[]>()
        const addConnection = (node1: string, node2: string) => {
            if(!connectionMap.has(node1)) connectionMap.set(node1, [])
            connectionMap.get(node1)[node2] = undefined
        }

        this.reportedConnections.forEach((eventMap, nodeId) => {
            eventMap.forEach((event, sourceId) => {
                // Check that both nodes claim to be connected to each other
                const check = (
                    event.type === "voidnet-connect" &&
                    this.reportedConnections.has(event.data) &&
                    this.reportedConnections.get(event.data).has(event.sender) &&
                    this.reportedConnections.get(event.data).get(event.sender).type === "voidnet-connect"
                )
                if(!check) return

                // Add the connection pair to the map
                addConnection(event.sender, event.data)
                addConnection(event.data, event.sender)
            })
        })

        this.completeConnections = connectionMap
    }

    protected ValidateEvent(event: VoidnetMessage) {
        return (
            event.Validate() &&
            Guid.isGuid(String(event.data)) &&
            (event.type === "voidnet-connect" || event.type === "voidnet-disconnect")
        )
    }

    protected ProcessEvent(event: VoidnetMessage) {
        // Re-instantiate from data and validate
        event = new VoidnetMessage(event)
        if(!this.ValidateEvent(event)) return

        // Make sure we have a mapping for the event sender's connections
        if(!this.reportedConnections.has(event.sender)) {
            this.reportedConnections.set(event.sender, new Map<string, VoidnetMessage>())
        }
        const map = this.reportedConnections.get(event.sender)

        // This event is older than our last event for said node, ignore
        if(map.has(event.data) && map.get(event.data).id >= event.id) return

        // This even is newer than our last event for said node
        map.set(event.data, event)
    }
}
