import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { TerminalView } from "./TerminalView";
import {
  clampRatio,
  fullFrame,
  paneLayout,
  resizeSplit,
  splitGroup,
  selectedRoster,
  sessionEntries,
  selectSession,
  moveSessionPane,
} from "../lib/workspace";
import type { Divider, PaneFrame, Workspace } from "../lib/workspace";

const frameStyle = (frame: PaneFrame): CSSProperties => ({
  left: `${frame.x * 100}%`,
  top: `${frame.y * 100}%`,
  width: `${frame.width * 100}%`,
  height: `${frame.height * 100}%`,
});

export function TerminalWorkspace({
  workspace,
  zoomed,
  focusRequest,
  closeRequest,
  update,
  onClosed,
  onAgentState,
  onDetectedAgent,
  onSessionViewed,
  agentStates,
}: {
  agentStates: Record<string, string>;
  onAgentState: (id: string, state: string, initial: boolean) => void;
  onDetectedAgent: (id: string, agent: string | null) => void;
  onSessionViewed: (id: string) => void;
  workspace: Workspace;
  zoomed: boolean;
  focusRequest: number;
  closeRequest: { id: string; sequence: number } | null;
  update: (change: (value: Workspace) => Workspace) => void;
  onClosed: (id: string) => void;
}) {
  useUiLanguage();

  const container = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ project: string; branch: string; ratio: number } | null>(null);
  const [drop, setDrop] = useState<{
    id: string;
    edge: "left" | "right" | "top" | "bottom";
  } | null>(null);
  const moving = useRef<{ id: string; x: number; y: number } | null>(null);
  const selected = selectedRoster(workspace);
  const effective = drag
    ? resizeSplit(workspace, drag.project, drag.branch, drag.ratio)
    : workspace;
  const project = selectedRoster(effective);
  const root =
    project && workspace.selectedSession
      ? splitGroup(project, workspace.selectedSession)
      : undefined;
  const layout =
    root && !zoomed
      ? paneLayout(root)
      : {
          panes: workspace.selectedSession ? { [workspace.selectedSession]: fullFrame } : {},
          dividers: [],
        };

  function pointerRatio(event: React.PointerEvent, divider: Divider) {
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return divider.node.ratio;
    return clampRatio(
      divider.node.axis === "horizontal"
        ? ((event.clientX - bounds.left) / bounds.width - divider.frame.x) / divider.frame.width
        : ((event.clientY - bounds.top) / bounds.height - divider.frame.y) / divider.frame.height,
    );
  }

  function pointerTarget(x: number, y: number) {
    for (const pane of container.current?.querySelectorAll<HTMLElement>(".session-panel.visible") ??
      []) {
      const box = pane.getBoundingClientRect();
      const id = pane.dataset.sessionId;
      if (
        !id ||
        x < box.left ||
        x > box.right ||
        y < box.top ||
        y > box.bottom ||
        id === moving.current?.id
      )
        continue;
      const horizontal = (x - box.left) / box.width,
        vertical = (y - box.top) / box.height;
      const edge =
        Math.min(horizontal, 1 - horizontal) < Math.min(vertical, 1 - vertical)
          ? horizontal < 0.5
            ? "left"
            : "right"
          : vertical < 0.5
            ? "top"
            : "bottom";
      return { id, edge } as const;
    }
    return null;
  }

  return (
    <div
      ref={container}
      className="terminal-workspace"
      onPointerMove={(event) => {
        const source = moving.current;
        if (!source || Math.hypot(event.clientX - source.x, event.clientY - source.y) < 6) return;
        setDrop(pointerTarget(event.clientX, event.clientY));
      }}
      onPointerUp={(event) => {
        const source = moving.current;
        const target =
          source && Math.hypot(event.clientX - source.x, event.clientY - source.y) >= 6
            ? pointerTarget(event.clientX, event.clientY)
            : null;
        moving.current = null;
        setDrop(null);
        if (source && target)
          update((previous) => moveSessionPane(previous, source.id, target.id, target.edge));
        if (source && event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        moving.current = null;
        setDrop(null);
      }}
      onLostPointerCapture={() => {
        moving.current = null;
        setDrop(null);
      }}
    >
      {/* Keep sessions in one flat keyed list: moving a leaf must never remount its PTY. */}
      {sessionEntries(workspace).map(({ session, directory }) => (
        <TerminalView
          key={session.id}
          directory={directory}
          session={session}
          agentState={agentStates[session.id]}
          closeRequest={closeRequest?.id === session.id ? closeRequest.sequence : 0}
          active={session.id === workspace.selectedSession}
          focusRequest={`${focusRequest}/${root?.kind === "split" ? root.id : "single"}/${zoomed}`}
          visible={!!layout.panes[session.id]}
          frame={layout.panes[session.id]}
          onPaneDragStart={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            moving.current = { id: session.id, x: event.clientX, y: event.clientY };
            container.current?.setPointerCapture(event.pointerId);
          }}
          onDetectedAgent={(agent) => onDetectedAgent(session.id, agent)}
          dropEdge={drop?.id === session.id ? drop.edge : undefined}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("application/x-uterm-session")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const box = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - box.left) / box.width,
              y = (event.clientY - box.top) / box.height;
            const edge =
              Math.min(x, 1 - x) < Math.min(y, 1 - y)
                ? x < 0.5
                  ? "left"
                  : "right"
                : y < 0.5
                  ? "top"
                  : "bottom";
            setDrop({ id: session.id, edge });
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (drop) {
              const moved = event.dataTransfer.getData("application/x-uterm-session");
              update((previous) => moveSessionPane(previous, moved, session.id, drop.edge));
            }
            setDrop(null);
          }}
          onFocus={() => {
            if (workspace.selectedSession !== session.id)
              update((previous) => selectSession(previous, session.id));
            onSessionViewed(session.id);
          }}
          onAgentState={(state, initial) => onAgentState(session.id, state, initial)}
          onClosed={() => onClosed(session.id)}
        />
      ))}
      {layout.dividers.map((divider) => {
        const { node, frame } = divider;
        const horizontal = node.axis === "horizontal";
        const position = horizontal
          ? { ...frame, x: frame.x + frame.width * node.ratio, width: 0 }
          : { ...frame, y: frame.y + frame.height * node.ratio, height: 0 };
        const save = (ratio: number) => {
          if (selected) update((previous) => resizeSplit(previous, selected.id, node.id, ratio));
        };
        return (
          <div
            key={node.id}
            role="separator"
            tabIndex={0}
            aria-label={horizontal ? tx("调整左右窗格") : tx("调整上下窗格")}
            aria-orientation={horizontal ? "vertical" : "horizontal"}
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(node.ratio * 100)}
            className={`pane-divider ${horizontal ? "horizontal" : "vertical"}`}
            style={frameStyle(position)}
            onPointerDown={(event) => {
              if (event.button !== 0 || !selected) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({ project: selected.id, branch: node.id, ratio: node.ratio });
            }}
            onPointerMove={(event) => {
              if (drag?.branch === node.id)
                setDrag({ ...drag, ratio: pointerRatio(event, divider) });
            }}
            onPointerUp={(event) => {
              if (drag?.branch !== node.id) return;
              save(pointerRatio(event, divider));
              setDrag(null);
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => setDrag(null)}
            onLostPointerCapture={() => setDrag(null)}
            onDoubleClick={() => save(0.5)}
            onKeyDown={(event) => {
              const backward = horizontal ? "ArrowLeft" : "ArrowUp",
                forward = horizontal ? "ArrowRight" : "ArrowDown";
              if (![backward, forward, "Home", "End", "Enter"].includes(event.key)) return;
              event.preventDefault();
              save(
                event.key === "Home"
                  ? 0.15
                  : event.key === "End"
                    ? 0.85
                    : event.key === "Enter"
                      ? 0.5
                      : node.ratio + (event.key === backward ? -0.05 : 0.05),
              );
            }}
          />
        );
      })}
    </div>
  );
}
