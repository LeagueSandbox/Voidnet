import { suite, test } from "mocha-typescript"
import { expect } from "chai"

import { VoidnetNodeMeta } from "../voidnet"

@suite("Test Voidnet Components")
class Tests {
    @test
    "VoidnetNodeMeta"() {
        const meta = new VoidnetNodeMeta("www.test.domain", 404)
        expect(meta.hostname).to.equal("www.test.domain")
        expect(meta.port).to.equal(404)
        expect(meta.uri).to.equal("www.test.domain:404")
        expect(meta.guid).to.not.be.null
    }
}


