import { suite, test } from "mocha-typescript"
import { expect } from "chai"

import {
    VoidnetNodeMeta, VoidnetServer,
    VoidnetHandshakeHandler
} from "../voidnet"


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
    "VoidnetServer invalid connection"(done) {
        const srv1 = new VoidnetServer("localhost", 8085)
        const srv2 = new VoidnetServer("localhost", 8086)
        const fake = new VoidnetHandshakeHandler(new VoidnetNodeMeta({hostname: srv1.meta.hostname, port: srv1.meta.port}))
        fake.on("failure", () => {done()})
        fake.Connect(srv2.meta.uri)
    }
}
