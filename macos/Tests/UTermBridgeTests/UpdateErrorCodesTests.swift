import Foundation
import XCTest
@testable import UTermBridge

final class UpdateErrorCodesTests: XCTestCase {
    func testOnlyThePinnedSDKVerifierCauseProvesSignatureMismatch() {
        let cause = NSError(domain: "SUSparkleErrorDomain", code: 3002, userInfo: [NSLocalizedDescriptionKey: "EdDSA signature does not match. Data of the update being checked is different."])
        let outer = NSError(domain: "SUSparkleErrorDomain", code: 4005, userInfo: [NSUnderlyingErrorKey: cause])
        XCTAssertTrue(updateHasSignatureMismatch(outer))
        XCTAssertFalse(updateHasSignatureMismatch(NSError(domain: "SUSparkleErrorDomain", code: 4005)))
        XCTAssertFalse(updateHasSignatureMismatch(NSError(domain: "SUSparkleErrorDomain", code: 3002, userInfo: [NSLocalizedDescriptionKey: "No suitable install is found in the update."])))
        XCTAssertFalse(updateHasSignatureMismatch(NSError(domain: "other", code: 3002, userInfo: cause.userInfo)))
    }
    func testWrappedSignatureCodeIsRetainedWithoutErrorDescriptions() {
        let inner = NSError(domain: "SUSparkleErrorDomain", code: 3001, userInfo: [NSLocalizedDescriptionKey: "private fixture"])
        let outer = NSError(domain: "SUSparkleErrorDomain", code: 4005, userInfo: [NSUnderlyingErrorKey: inner])
        XCTAssertEqual(updateErrorCodes(outer), ["SUSparkleErrorDomain:4005", "SUSparkleErrorDomain:3001"])
        XCTAssertEqual(updateErrorCodes(NSError(domain: "SUSparkleErrorDomain", code: 4005)), ["SUSparkleErrorDomain:4005"])
    }
    func testAggregateErrorsAreBoundedAndDeduplicated() {
        let inner = NSError(domain: "NSURLErrorDomain", code: -1009)
        let outer = NSError(domain: "fixture", code: 1, userInfo: [NSUnderlyingErrorKey: inner, "NSMultipleUnderlyingErrors": [inner, inner]])
        XCTAssertEqual(updateErrorCodes(outer), ["fixture:1", "NSURLErrorDomain:-1009"])
        var nested = inner
        for _ in 0..<100 { nested = NSError(domain: "wrapper", code: 2, userInfo: [NSUnderlyingErrorKey: nested]) }
        XCTAssertEqual(updateErrorCodes(nested).count, 8)
    }
}
