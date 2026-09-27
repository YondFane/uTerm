export interface HistoryState<T> {
  items: T[];
  loading: boolean;
  more: boolean;
  error: string;
}

/** Formats a commit timestamp with enough precision to distinguish nearby commits. */
export function formatCommitTimestamp(timestamp: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(timestamp));
}

export class HistoryPager<T extends { id: string }> {
  state: HistoryState<T> = { items: [], loading: false, more: true, error: "" };
  private generation = 0;
  private offset = 0;

  invalidate() {
    this.generation++;
    this.state = { ...this.state, loading: false };
  }

  async load(
    fetchPage: (skip: number) => Promise<T[]>,
    publish: (state: HistoryState<T>) => void,
    reset = false,
  ): Promise<void> {
    if (!reset && (this.state.loading || !this.state.more)) return;
    const generation = ++this.generation;
    if (reset) {
      this.offset = 0;
      this.state = { items: [], loading: false, more: true, error: "" };
    }
    this.state = { ...this.state, loading: true, error: "" };
    publish(this.state);
    try {
      const next = await fetchPage(this.offset);
      if (generation !== this.generation) return;
      // New commits can shift page boundaries between requests; keep each commit once.
      const seen = new Set(this.state.items.map((item) => item.id));
      const items = [...this.state.items];
      for (const item of next) {
        if (!seen.has(item.id)) items.push(item);
        seen.add(item.id);
      }
      this.offset += next.length;
      this.state = { items, more: next.length === 100, loading: false, error: "" };
    } catch (reason) {
      if (generation !== this.generation) return;
      this.state = { ...this.state, error: String(reason) };
    } finally {
      if (generation === this.generation) {
        this.state = { ...this.state, loading: false };
        publish(this.state);
      }
    }
  }
}

export interface GraphCommit {
  id: string;
  parents: string[];
}
export interface GraphRow {
  lane: number;
  color: number;
  incoming: boolean;
  width: number;
  continuations: { from: number; to: number; color: number }[];
  parents: { lane: number; color: number }[];
}

export function commitGraph(commits: GraphCommit[]): GraphRow[] {
  let lanes: { id: string; color: number }[] = [];
  let nextColor = 0;
  return commits.map((commit) => {
    let lane = lanes.findIndex((item) => item.id === commit.id);
    const incoming = lane >= 0;
    if (!incoming) {
      lane = lanes.length;
      lanes.push({ id: commit.id, color: nextColor++ });
    }
    const color = lanes[lane].color;
    const before = [...lanes];
    lanes.splice(lane, 1);
    const parents = [...new Set(commit.parents)];
    parents.forEach((id, index) => {
      if (lanes.some((item) => item.id === id)) return;
      lanes.splice(index === 0 ? lane : lanes.length, 0, {
        id,
        color: index === 0 ? color : nextColor++,
      });
    });
    return {
      lane,
      color,
      incoming,
      width: Math.max(before.length, lanes.length),
      continuations: before.flatMap((item, from) =>
        from === lane
          ? []
          : [{ from, to: lanes.findIndex((next) => next.id === item.id), color: item.color }],
      ),
      parents: parents.map((id) => {
        const target = lanes.findIndex((item) => item.id === id);
        return { lane: target, color: lanes[target].color };
      }),
    };
  });
}
