import { suite, test } from "mocha-typescript"
import { expect } from "chai"

import {
    VoidnetNodeMeta, VoidnetServer,
    VoidnetHandshakeHandler
} from "../voidnet"


class FakeVoidnetServer extends VoidnetServer {
    protected GetHandshakeHandler(meta: VoidnetNodeMeta) {
        return new FakeVoidnetHandshakeHandler(this.meta)
    }
}

class FakeVoidnetHandshakeHandler extends VoidnetHandshakeHandler {
    protected HandleHandshakeAck = (serverSocket: SocketIO.Socket, remoteMeta: VoidnetNodeMeta, verify: Function) => {
        if(this.pendingHandshakes.has(remoteMeta.guid)) {
            const pendingHandshake = this.pendingHandshakes.get(remoteMeta.guid)
            pendingHandshake.serverSocket = serverSocket
            pendingHandshake.handshakeDatum.data += "a" // Modify the secret so it always differs, thus becoming invalid
            verify(pendingHandshake.handshakeDatum)
        }
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
        const srv1 = new FakeVoidnetServer("localhost", 8087)
        const srv2 = new VoidnetServer("localhost", 8088)
        srv1.Connect(srv2.meta.uri)
        srv1.handshakeHandler.on("failure", () => {
            expect(srv1.connectionCount).to.equal(0)
            expect(srv2.connectionCount).to.equal(0)
            done()
        })
    }
}
