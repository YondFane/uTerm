import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const targets = {
  "windows-x64": { os: "windows", architecture: "x64" },
  "mac-x64": { os: "mac", architecture: "x64" },
  "mac-aarch64": { os: "mac", architecture: "aarch64" },
};
async function request(url) {
  const bytes = execFileSync(
    process.platform === "win32" ? "curl.exe" : "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "15",
      "--max-time",
      "120",
      url,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return {
    json: async () => JSON.parse(bytes.toString("utf8")),
    text: async () => bytes.toString("utf8"),
    arrayBuffer: async () => bytes,
  };
}
async function adoptium(version, target) {
  const query = new URLSearchParams({ ...target, image_type: "jdk", vendor: "eclipse" });
  const entries = await (
    await request(`https://api.adoptium.net/v3/assets/latest/${version}/hotspot?${query}`)
  ).json();
  const entry = entries[0];
  const archive = entry.binary.package;
  return {
    version: entry.release_name,
    url: archive.link,
    sha256: archive.checksum,
    size: archive.size,
    filename: archive.name,
  };
}
async function azulJava8() {
  const entries = await (
    await request(
      "https://api.azul.com/metadata/v1/zulu/packages/?java_version=8&os=macos&arch=aarch64&archive_type=tar.gz&java_package_type=jdk&release_status=ga&availability_types=CA&latest=true",
    )
  ).json();
  const selected = entries.find((entry) => !entry.name.includes("-fx-"));
  const entry = await (
    await request(`https://api.azul.com/metadata/v1/zulu/packages/${selected.package_uuid}`)
  ).json();
  return {
    version: `Zulu ${entry.java_version.join(".")}`,
    url: entry.download_url,
    sha256: entry.sha256_hash,
    size: entry.size,
    filename: entry.name,
  };
}
async function maven() {
  const filename = "apache-maven-3.10.0-bin.zip";
  const url = `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.10.0/${filename}`;
  const digest = (
    await (
      await request(`https://dlcdn.apache.org/maven/maven-3/3.10.0/binaries/${filename}.sha512`)
    ).text()
  )
    .trim()
    .split(/\s+/)[0];
  const bytes = Buffer.from(await (await request(url)).arrayBuffer());
  if (createHash("sha512").update(bytes).digest("hex") !== digest)
    throw new Error("Maven SHA-512 verification failed");
  await mkdir(new URL("../.qa-java-build.local/", import.meta.url), { recursive: true });
  await writeFile(new URL(`../.qa-java-build.local/${filename}`, import.meta.url), bytes);
  return {
    version: "3.10.0",
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    filename,
  };
}
const catalog = {};
const mavenArchive = await maven();
for (const [key, target] of Object.entries(targets)) {
  catalog[key] = { maven: mavenArchive };
  for (const version of [8, 11, 17, 21]) {
    catalog[key][`jdk-${version}`] =
      key === "mac-aarch64" && version === 8 ? await azulJava8() : await adoptium(version, target);
    process.stdout.write(`${key} JDK ${version}: ${catalog[key][`jdk-${version}`].version}\n`);
  }
}
await writeFile(
  new URL("../components/java/catalog.json", import.meta.url),
  `${JSON.stringify(catalog, null, 2)}\n`,
);
