import type { CoreGitFavorites } from "../lib/core-contract.generated.ts";

export interface FavoriteFixtureAttempt {
  attempt: number;
  saved: boolean;
  writerBusy: boolean;
  unchangedOnBusy: boolean;
}

export async function writeFavoriteFixture(
  baseline: CoreGitFavorites,
  write: () => Promise<CoreGitFavorites>,
  read: () => Promise<CoreGitFavorites>,
  record: (attempt: FavoriteFixtureAttempt) => void,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
): Promise<CoreGitFavorites> {
  const original = structuredClone(baseline);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const saved = await write();
      record({ attempt, saved: true, writerBusy: false, unchangedOnBusy: true });
      return saved;
    } catch (reason) {
      if ((reason as { code?: string }).code !== "WRITER_BUSY") throw reason;
      const current = await read();
      const unchanged =
        current.repository === original.repository &&
        current.revision === original.revision &&
        current.sourceDigest === original.sourceDigest &&
        current.references.length === original.references.length &&
        current.references.every((reference, index) => reference === original.references[index]);
      record({ attempt, saved: false, writerBusy: true, unchangedOnBusy: unchanged });
      if (!unchanged || attempt === 3) throw reason;
      // Repeat only the fixture action after proving it made no change; never replay a UI write.
      // 仅在证明测试操作没有改动后再次执行该操作，不重放界面写入。
      await wait();
    }
  }
  throw Error("Git favorite fixture did not finish");
}
