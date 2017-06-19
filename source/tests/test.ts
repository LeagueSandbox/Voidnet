import { suite, test, timeout } from "mocha-typescript"
import { expect } from "chai"
import * as sleep from "sleep-promise"

import { VoidnetNodeMeta, VoidnetServer } from "../voidnet"
import { VoidnetHandshakeHandler } from "../handshake"
import { VoidnetMessageHandler, VoidnetMessageTracker, VoidnetMessage } from "../message"
import { ValueMonitor } from "../utils"


class VoidnetTestInvalidServer extends VoidnetServer {
    protected CreateHandshakeHandler(meta: VoidnetNodeMeta) {
        return new VoidnetTestInvalidHandshakeHandler(this.meta)
    }

    public get getHandshakeHandler(): VoidnetHandshakeHandler {
        return this.handshakeHandler
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

const message = (sender, id, type, data) => {
    return new VoidnetMessage({
        sender: sender,
        id: id,
        type: type,
        data: data
    })
}

let lastUsedPort = 8000
function GetUnusedPort(): number {
    return lastUsedPort++
}

@suite("Test Utils")
class TestUtils {
    @test
    "Test ValueMonitor get"(done) {
        const monitor = new ValueMonitor<number>(2)
        monitor.on("get", (value) => {
            expect(value).to.equal(2)
            done()
        })
        expect(monitor.value).to.equal(2)
    }

    @test
    "Test ValueMonitor set"(done) {
        const monitor = new ValueMonitor<number>(2)
        expect(monitor.value).to.equal(2)
        monitor.on("set", (newValue, oldValue) => {
            expect(oldValue).to.equal(2)
            expect(newValue).to.equal(3)
            done()
        })
        monitor.value = 3
        expect(monitor.value).to.equal(3)
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
        const srv1 = new VoidnetServer("localhost", GetUnusedPort())
        const srv2 = new VoidnetServer("localhost", GetUnusedPort())
        srv1.OnConnection(() => {
            expect(srv1.connectionCount).to.equal(1)
            expect(srv2.connectionCount).to.equal(1)
            done()
        })
        srv1.Connect(srv2.meta.uri)
    }

    @test
    "VoidnetServer connection failure [invalid node meta]"(done) {
        const srv1 = new VoidnetServer("localhost", GetUnusedPort())
        const srv2 = new VoidnetServer("localhost", GetUnusedPort())
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
        const srv1 = new VoidnetTestInvalidServer("localhost", GetUnusedPort())
        const srv2 = new VoidnetServer("localhost", GetUnusedPort())
        srv1.Connect(srv2.meta.uri)
        srv1.getHandshakeHandler.on("failure", () => {
            expect(srv1.connectionCount).to.equal(0)
            expect(srv2.connectionCount).to.equal(0)
            done()
        })
    }

    @test
    async "VoidnetMessageTracker timeout"() {

        const tracker = new VoidnetTestMessageTracker()
        const msgOld = message("00000000-0000-0000-0000-000000000001", 0, "test", "data")
        const msgMiddle = message("00000000-0000-0000-0000-000000000001", 1, "test", "data 2")
        const msgNewest = message("00000000-0000-0000-0000-000000000001", 2, "test", "data 2")
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

        const msg1 = handler.MakeMessage("test", "top")
        expect(msg1.id).to.equal(0)
        expect(msg1.sender).to.equal(meta.guid)
        expect(msg1.data).to.equal("top")

        const msg2 = handler.MakeMessage("test", "kek")
        expect(msg2.id).to.equal(1)
        expect(msg2.sender).to.equal(meta.guid)
        expect(msg2.data).to.equal("kek")

        const msg3 = handler.MakeMessage("test", {"more": "complex", "data": 1})
        expect(msg3.id).to.equal(2)
        expect(msg3.sender).to.equal(meta.guid)
        expect(msg3.data).to.deep.equal({"more": "complex", "data": 1})
    }

    @test
    async "VoidnetMessageHandler local message processing"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        const handler = new VoidnetTestMessageHandler(meta)
        handler.ProcessMessage(handler.MakeMessage("test", "don't pass"))
        await sleep(TEST_MESSAGE_TIMEOUT)
        expect(handler.rejectedMessageCount).to.equal(1)
    }

    @test
    async "VoidnetMessageHandler remote message processing"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        let receivedCount = 0

        const handler = new VoidnetTestMessageHandler(meta)
        handler.OnMessage("test", (message: VoidnetMessage) => {
            receivedCount++
        })

        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 0, "test", ""))
        expect(receivedCount).to.equal(1)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 0, "test", "b"))
        expect(receivedCount).to.equal(1)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000002", 0, "test", ""))
        expect(receivedCount).to.equal(2)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000002", 0, "test", "a"))
        expect(receivedCount).to.equal(2)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 1, "test", ""))
        expect(receivedCount).to.equal(3)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000002", 1, "test", ""))
        expect(receivedCount).to.equal(4)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 10, "test", ""))
        expect(receivedCount).to.equal(5)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 6, "test", ""))
        expect(receivedCount).to.equal(6)
        await sleep(TEST_MESSAGE_TIMEOUT)
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 7, "test", ""))
        expect(receivedCount).to.equal(6)
    }

    @test
    async "VoidnetMessageHandler invalid message processing"() {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        const testMessage = new VoidnetMessage({
            sender: "garbagesender",
            id: 5,
            type: "test",
            data: "Some data"
        })
        const handler = new VoidnetMessageHandler(meta)
        handler.ProcessMessage(message("garbage", 1, "test", ""))
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", "garbage", "test", ""))
        handler.ProcessMessage(message("00000000-0000-0000-0000-000000000001", 2, "", "TypeIsGarbage"))
        handler.ProcessMessage(<VoidnetMessage><any>{"kek": "top"})
        await sleep(TEST_MESSAGE_TIMEOUT)
        expect(handler.rejectedMessageCount).to.equal(4)
    }

    @test
    "VoidnetMessageHandler received event"(done) {
        const meta = new VoidnetNodeMeta({
            hostname: "www.test.domain",
            port: 404
        })

        const testMessage = new VoidnetMessage({
            sender: "00000000-0000-0000-0000-000000000001",
            id: 5,
            type: "test",
            data: "Some data"
        })
        const handler = new VoidnetMessageHandler(meta)
        handler.OnMessage("test", (message: VoidnetMessage) => {
            expect(message).to.deep.equal(testMessage)
            done()
        })

        handler.ProcessMessage(testMessage)
    }

    @test
    "VoidnetMessage validation"() {
        const valid = message("00000000-0000-0000-0000-000000000001", 5, "test", "")
        const invalid1 = message("invalid", 5, "test", "")
        const invalid2 = message("00000000-0000-0000-0000-000000000001", "invalid", "test", "")
        const invalid3 = message("00000000-0000-0000-0000-000000000001", 5, "", "")
        const invalid4 = new VoidnetMessage(<VoidnetMessage><any>{"asd": "dsa"})
        const invalid5 = new VoidnetMessage(<VoidnetMessage><any>"test")
        expect(valid.Validate()).to.be.true
        expect(invalid1.Validate()).to.be.false
        expect(invalid2.Validate()).to.be.false
        expect(invalid3.Validate()).to.be.false
        expect(invalid4.Validate()).to.be.false
        expect(invalid5.Validate()).to.be.false
    }

    @test
    "VoidnetConnection"() {
        // IMPLEMENT
    }
}

@suite("Test Voidnet Networking")
class TestNetworking {
    @test
    "Broadcasting [3 node chain network]"(done) {
        const srv1 = new VoidnetServer("localhost", GetUnusedPort())
        const srv2 = new VoidnetServer("localhost", GetUnusedPort())
        const srv3 = new VoidnetServer("localhost", GetUnusedPort())

        const validMessages = new ValueMonitor<number>(0)
        validMessages.on("set", (newVal) => {
            if(newVal == 2) done()
        })

        const connections = new ValueMonitor<number>(0)
        connections.on("set", (newVal) => {
            if(newVal == 4) {
                expect(srv1.connectionCount).to.equal(1)
                expect(srv2.connectionCount).to.equal(2)
                expect(srv3.connectionCount).to.equal(1)
                srv3.Broadcast("test", "data")
            }
        })

        srv1.Connect(srv2.meta.uri)
        srv2.Connect(srv3.meta.uri)

        srv1.OnConnection(() => connections.value++)
        srv2.OnConnection(() => connections.value++)
        srv3.OnConnection(() => connections.value++)

        srv2.OnMessage("test", (message: VoidnetMessage) => {
            expect(message.sender).to.equal(srv3.meta.guid)
            expect(message.data).to.equal("data")
            validMessages.value++
        })
        srv1.OnMessage("test", (message: VoidnetMessage) => {
            expect(message.sender).to.equal(srv3.meta.guid)
            expect(message.data).to.equal("data")
            validMessages.value++
        })
    }
}
