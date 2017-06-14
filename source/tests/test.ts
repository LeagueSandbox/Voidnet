import { suite, test } from "mocha-typescript"
import { expect } from "chai"
import * as sleep from "sleep-promise"

import { VoidnetNodeMeta, VoidnetServer } from "../voidnet"
import { VoidnetHandshakeHandler } from "../handshake"
import { VoidnetMessageHandler, VoidnetMessageTracker, VoidnetMessage } from "../message"


class VoidnetTestInvalidServer extends VoidnetServer {
    protected CreateHandshakeHandler(meta: VoidnetNodeMeta) {
        return new VoidnetTestInvalidHandshakeHandler(this.meta)
    }
}

class VoidnetTestInvalidHandshakeHandler extends VoidnetHandshakeHandler {
    protected HandleHandshakeAck = (serverSocket: SocketIO.Socket, remoteMeta: VoidnetNodeMeta, verify: Function) => {
        if(this.pendingHandshakes.has(remoteMeta.guid)) {
            const pendingHandshake = this.pendingHandshakes.get(remoteMeta.guid)
            pendingHandshake.serverSocket = serverSocket
            pendingHandshake.handshakeDatum.data += "a" // Modify the secret so it always differs, thus becoming invalid
            verify(pendingHandshake.handshakeDatum)
        }
    }
}

const TEST_MESSAGE_TIMEOUT: number = 20
class VoidnetTestMessageTracker extends VoidnetMessageTracker {
    public get messageTimeout(): number { return TEST_MESSAGE_TIMEOUT; }
}

class VoidnetTestMessageHandler extends VoidnetMessageHandler {
    protected CreateMessageTracker(): VoidnetMessageTracker {
        return new VoidnetTestMessageTracker()
    }
}


@suite("Test Voidnet Components")
class TestComponents {
    @test
    "VoidnetNodeMeta creation and properties"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })
        expect(meta.hostname).to.equal("www.test.domain")
        expect(meta.port).to.equal(404)
        expect(meta.uri).to.equal("http://www.test.domain:404")
        expect(meta.guid).to.not.be.null
    }

    @test
    "VoidnetServer cross connection"(done) {
        const srv1 = new VoidnetServer("localhost", 8081)
        const srv2 = new VoidnetServer("localhost", 8082)
        srv1.on("connection", () => {
            expect(srv1.connectionCount).to.equal(1)
            expect(srv2.connectionCount).to.equal(1)
            done()
        })
        srv1.Connect(srv2.meta.uri)
    }

    @test
    "VoidnetServer connection failure [invalid node meta]"(done) {
        const srv1 = new VoidnetServer("localhost", 8085)
        const srv2 = new VoidnetServer("localhost", 8086)
        const fake = new VoidnetHandshakeHandler(new VoidnetNodeMeta({hostname: srv1.meta.hostname, port: srv1.meta.port}))
        fake.on("failure", () => {
            expect(srv1.connectionCount).to.equal(0)
            expect(srv2.connectionCount).to.equal(0)
            done()
        })
        fake.Connect(srv2.meta.uri)
    }

    @test
    "VoidnetServer connection failure [invalid secret]"(done) {
        const srv1 = new VoidnetTestInvalidServer("localhost", 8087)
        const srv2 = new VoidnetServer("localhost", 8088)
        srv1.Connect(srv2.meta.uri)
        srv1.handshakeHandler.on("failure", () => {
            expect(srv1.connectionCount).to.equal(0)
            expect(srv2.connectionCount).to.equal(0)
            done()
        })
    }

    @test
    async "VoidnetMessageTracker timeout"() {
        const tracker = new VoidnetTestMessageTracker()
        const msgOld = new VoidnetMessage("tester", 0, "data")
        const msgMiddle = new VoidnetMessage("tester", 1, "data 2")
        const msgNewest = new VoidnetMessage("tester", 2, "data 2")
        expect(tracker.IsMessageOld(msgOld)).to.be.false
        expect(tracker.IsMessageOld(msgMiddle)).to.be.false
        expect(tracker.IsMessageOld(msgNewest)).to.be.false
        tracker.Track(msgMiddle)
        expect(tracker.IsMessageOld(msgOld)).to.be.false
        expect(tracker.IsMessageOld(msgMiddle)).to.be.true
        expect(tracker.IsMessageOld(msgNewest)).to.be.false
        await sleep(tracker.messageTimeout)
        expect(tracker.IsMessageOld(msgOld)).to.be.true
        expect(tracker.IsMessageOld(msgMiddle)).to.be.true
        expect(tracker.IsMessageOld(msgNewest)).to.be.false
    }

    @test
    async "VoidnetMessageHandler make message"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })
        const handler = new VoidnetTestMessageHandler(meta)

        const msg1 = handler.MakeMessage("top")
        expect(msg1.id).to.equal(0)
        expect(msg1.sender).to.equal(meta.guid)
        expect(msg1.data).to.equal("top")

        const msg2 = handler.MakeMessage("kek")
        expect(msg2.id).to.equal(1)
        expect(msg2.sender).to.equal(meta.guid)
        expect(msg2.data).to.equal("kek")

        const msg3 = handler.MakeMessage({"more": "complex", "data": 1})
        expect(msg3.id).to.equal(2)
        expect(msg3.sender).to.equal(meta.guid)
        expect(msg3.data).to.deep.equal({"more": "complex", "data": 1})
    }

    @test
    "VoidnetMessageHandler local message processing"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        const handler = new VoidnetTestMessageHandler(meta)
        handler.on("received", (message: VoidnetMessage) => {
            throw new Error("Own messages shouldn't be processed")
        })
        handler.ProcessMessage(handler.MakeMessage("don't pass"))
    }

    @test
    async "VoidnetMessageHandler remote message processing"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        let receivedCount = 0

        const handler = new VoidnetTestMessageHandler(meta)
        handler.on("received", (message: VoidnetMessage) => {
            receivedCount++
        })

        handler.ProcessMessage(new VoidnetMessage("a", 0, ""))
        expect(receivedCount).to.equal(1)
        handler.ProcessMessage(new VoidnetMessage("a", 0, "b"))
        expect(receivedCount).to.equal(1)
        handler.ProcessMessage(new VoidnetMessage("b", 0, ""))
        expect(receivedCount).to.equal(2)
        handler.ProcessMessage(new VoidnetMessage("b", 0, "a"))
        expect(receivedCount).to.equal(2)
        handler.ProcessMessage(new VoidnetMessage("a", 1, ""))
        expect(receivedCount).to.equal(3)
        handler.ProcessMessage(new VoidnetMessage("b", 1, ""))
        expect(receivedCount).to.equal(4)
        handler.ProcessMessage(new VoidnetMessage("a", 10, ""))
        expect(receivedCount).to.equal(5)
        handler.ProcessMessage(new VoidnetMessage("a", 6, ""))
        expect(receivedCount).to.equal(6)
        await sleep(TEST_MESSAGE_TIMEOUT)
        handler.ProcessMessage(new VoidnetMessage("a", 7, ""))
        expect(receivedCount).to.equal(6)
    }

    @test
    "VoidnetMessageHandler received event"(done) {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        const testMessage = new VoidnetMessage("test", 5, "Some data")
        const handler = new VoidnetMessageHandler(meta)
        handler.on("received", (message: VoidnetMessage) => {
            expect(message).to.equal(testMessage)
            done()
        })

        handler.ProcessMessage(testMessage)
    }
}

@suite("Test Voidnet Networking")
class TestNetworking {
    @test
    "Broadcasting [3 node network]"(done) {
        done()
    }
}
