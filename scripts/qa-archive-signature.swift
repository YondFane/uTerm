import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 6 else { fatalError("Usage: generate|verify MANIFEST PRIVATE PUBLIC SIGNATURE") }
let data = try Data(contentsOf: URL(fileURLWithPath: args[2]))
switch args[1] {
case "generate":
    let key = Curve25519.Signing.PrivateKey()
    try key.rawRepresentation.write(to: URL(fileURLWithPath: args[3]), options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: args[3])
    try key.publicKey.rawRepresentation.write(to: URL(fileURLWithPath: args[4]), options: .atomic)
    try key.signature(for: data).write(to: URL(fileURLWithPath: args[5]), options: .atomic)
case "verify":
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: Data(contentsOf: URL(fileURLWithPath: args[4])))
    let signature = try Data(contentsOf: URL(fileURLWithPath: args[5]))
    guard key.isValidSignature(signature, for: data) else { throw NSError(domain: "QA_ARCHIVE_SIGNATURE", code: 1) }
default: fatalError("Unknown QA signing operation")
}
