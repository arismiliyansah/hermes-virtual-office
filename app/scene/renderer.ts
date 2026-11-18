import type { AgentStatus } from "../../src/duty";
import {
  TH,
  TW,
  diamond,
  project,
  type Point,
  type ProjectionOptions,
} from "./iso";
import { LAYOUT, type Layout, type Vec2 } from "./layout";
import type { Palette } from "./palette";
import { rotatePoint, type Viewport } from "./viewport";

export interface SceneAgent {
  id: string;
  duty: AgentStatus;
  /** Display name from GET /api/agents; renderer falls back to the id. */
  name?: string | null;
  /** Hex color from GET /api/agents; renderer hashes the id as a fallback. */
  color?: string | null;
  /** Desk slot 0..5 from GET /api/agents; null means hotdesk/lounge. */
  desk?: number | null;
}

export interface SceneSnapshot {
  agents: SceneAgent[];
}

export interface Scene {
  draw(snapshot: SceneSnapshot, viewport: Viewport): void;
  /** Canvas-relative CSS point to the agent drawn there, if any. */
  hitTest?(x: number, y: number): string | null;
}

type DrawItem = { depth: number; paint: () => void };

const SCENE_PROJECTION: ProjectionOptions = { tw: TW, th: TH, ox: 0, oy: 0 };
const WALL_HEIGHT = 26;
const GLASS_HEIGHT = 42;
const SKIRT_HEIGHT = 16;

const AGENT_COLORS: Record<string, string> = {
  atlas: "#b06a3b",
  bimo: "#5d7fa3",
  citra: "#b0524d",
  damar: "#6d8f57",
  eka: "#a9873f",
  fajar: "#5f8f84",
  gilang: "#9078a0",
};

const FALLBACK_COLORS = [
  "#b06a3b",
  "#5d7fa3",
  "#b0524d",
  "#6d8f57",
  "#a9873f",
  "#5f8f84",
  "#9078a0",
];

const AGENT_NAMES: Record<string, string> = {
  atlas: "Atlas",
  bimo: "Bimo",
  citra: "Citra",
  damar: "Damar",
  eka: "Eka",
  fajar: "Fajar",
  gilang: "Gilang",
};

const MEETING_SEATS: Vec2[] = [
  [8, 0.9],
  [10, 0.9],
  [9, 2.4],
];

const LOUNGE_SEATS: Vec2[] = [
  [1, 6.6],
  [1.9, 7.3],
  [0.3, 7.5],
  [2.2, 6.8],
];

interface PlacedAgent extends SceneAgent {
  i: number;
  j: number;
  color: string;
  label: string;
}

interface Placement {
  agents: PlacedAgent[];
  occupiedDesks: Set<number>;
}

function displayName(id: string, name?: string | null): string {
  const provided = name?.trim();
  if (provided !== undefined && provided.length > 0) return provided;
  const known = AGENT_NAMES[id.toLowerCase()];
  if (known) return known;
  const cleaned = id.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Agent";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function colorFor(id: string, color?: string | null): string {
  const provided = color?.trim();
  if (provided !== undefined && provided.length > 0) return provided;
  const known = AGENT_COLORS[id.toLowerCase()];
  if (known) return known;
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

/**
 * Seats agents from their real desk assignment, not their array position.
 * `desk` is the Hermes-backed slot: 0..5 sits at that layout desk, null/out of
 * range goes to the hotdesk/lounge zone. Meeting and A2A duties override the
 * desk because the office activity overlay says where they actually are.
 */
export function placeAgents(
  agents: SceneAgent[],
  layout: Layout,
): Placement {
  const deskSeats: Vec2[] = layout.desks.map(([i, j]) => [i, j - 0.65]);
  const meetingSeats = MEETING_SEATS.length > 0 ? MEETING_SEATS : deskSeats;
  const path = layout.MEET_PATH.length > 0 ? layout.MEET_PATH : deskSeats;
  const occupiedDesks = new Set<number>();
  let nextFreeDesk = 0;
  let meetingIndex = 0;
  let loungeIndex = 0;
  let pathIndex = 0;

  const loungeSeat = (): Vec2 => {
    const seat = LOUNGE_SEATS[loungeIndex % LOUNGE_SEATS.length];
    loungeIndex += 1;
    return seat;
  };

  const placed = agents.map((agent): PlacedAgent => {
    let seat: Vec2 | null = null;

    if (agent.duty === "meeting") {
      seat = meetingSeats[meetingIndex % meetingSeats.length];
      meetingIndex += 1;
    } else if (agent.duty === "a2a") {
      seat = path[Math.min(path.length - 1, 2 + (pathIndex % 3))];
      pathIndex += 1;
    } else if (agent.duty === "idle") {
      // Idle agents relax in the lounge even when D1 still stores a desk for
      // them; the desk must not look occupied (spec §8.6).
      seat = null;
    } else if (typeof agent.desk === "number") {
      const desk = agent.desk;
      if (
        Number.isInteger(desk) &&
        desk >= 0 &&
        desk < deskSeats.length &&
        !occupiedDesks.has(desk)
      ) {
        occupiedDesks.add(desk);
        seat = deskSeats[desk];
      }
    } else if (agent.desk === undefined) {
      // Legacy snapshots carry no desk data: fill free desks in order.
      while (
        nextFreeDesk < deskSeats.length &&
        occupiedDesks.has(nextFreeDesk)
      ) {
        nextFreeDesk += 1;
      }
      if (nextFreeDesk < deskSeats.length) {
        occupiedDesks.add(nextFreeDesk);
        seat = deskSeats[nextFreeDesk];
        nextFreeDesk += 1;
      }
    }

    if (seat === null) seat = loungeSeat();

    return {
      ...agent,
      i: seat[0],
      j: seat[1],
      color: colorFor(agent.id, agent.color),
      label: displayName(agent.id, agent.name),
    };
  });

  return { agents: placed, occupiedDesks };
}

function canvasSize(canvas: HTMLCanvasElement): {
  width: number;
  height: number;
  dpr: number;
} {
  const dpr =
    typeof devicePixelRatio === "number" && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const width = Math.max(
    1,
    canvas.clientWidth || (canvas.width ? canvas.width / dpr : 960),
  );
  const height = Math.max(
    1,
    canvas.clientHeight || (canvas.height ? canvas.height / dpr : 540),
  );
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  return { width, height, dpr };
}

interface FrameAgent {
  id: string;
  x: number;
  y: number;
}

interface Frame {
  width: number;
  height: number;
  scale: number;
  sceneX: number;
  sceneY: number;
  panX: number;
  panY: number;
  agents: FrameAgent[];
}

export function createScene(
  canvas: HTMLCanvasElement,
  options: { palette: Palette; layout: typeof LAYOUT },
): Scene {
  const { palette, layout } = options;
  let frame: Frame | null = null;

  return {
    draw(snapshot: SceneSnapshot, viewport: Viewport): void {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { width, height, dpr } = canvasSize(canvas);
      const centerI = (layout.width - 1) / 2;
      const centerJ = (layout.height - 1) / 2;

      const rotated = (i: number, j: number) =>
        rotatePoint(i, j, viewport.rotation, centerI, centerJ);
      const pt = (i: number, j: number): Point => {
        const point = rotated(i, j);
        return project(point.i, point.j, SCENE_PROJECTION);
      };
      const depthOf = (i: number, j: number): number => {
        const point = rotated(i, j);
        return point.i + point.j;
      };

      const polygon = (
        points: Point[],
        fill: string,
        stroke?: string,
        lineWidth = 1,
      ): void => {
        if (points.length === 0) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let index = 1; index < points.length; index += 1) {
          ctx.lineTo(points[index].x, points[index].y);
        }
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        }
      };

      const ellipse = (
        x: number,
        y: number,
        rx: number,
        ry: number,
        fill: string,
        rotation = 0,
      ): void => {
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
      };

      const roundedRect = (
        x: number,
        y: number,
        w: number,
        h: number,
        radius: number,
        fill: string,
        stroke?: string,
        lineWidth = 1,
      ): void => {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, y, w, h, radius);
        } else {
          ctx.rect(x, y, w, h);
        }
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        }
      };

      const bounds = (() => {
        const corners = [
          pt(-0.5, -0.5),
          pt(layout.width - 0.5, -0.5),
          pt(layout.width - 0.5, layout.height - 0.5),
          pt(-0.5, layout.height - 0.5),
        ];
        const xs = corners.map((corner) => corner.x);
        const ys = corners.map((corner) => corner.y);
        return {
          minX: Math.min(...xs) - 42,
          maxX: Math.max(...xs) + 42,
          minY: Math.min(...ys) - 74,
          maxY: Math.max(...ys) + 48,
        };
      })();

      const fit = Math.min(
        width / Math.max(1, bounds.maxX - bounds.minX),
        height / Math.max(1, bounds.maxY - bounds.minY),
      );
      const scale = (Number.isFinite(fit) && fit > 0 ? fit : 1) * viewport.zoom;
      const sceneX = (bounds.minX + bounds.maxX) / 2;
      const sceneY = (bounds.minY + bounds.maxY) / 2;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(width / 2 + viewport.panX, height / 2 + viewport.panY);
      ctx.scale(scale, scale);
      ctx.translate(-sceneX, -sceneY);

      // Floor: classify the original cell first so the meeting room and rug
      // rotate together with the rest of the plan.
      for (let j = 0; j < layout.height; j += 1) {
        for (let i = 0; i < layout.width; i += 1) {
          const inMeeting =
            i >= layout.meetingRoom.i &&
            i < layout.meetingRoom.i + layout.meetingRoom.w &&
            j >= layout.meetingRoom.j &&
            j < layout.meetingRoom.j + layout.meetingRoom.h;
          const inLounge =
            i >= layout.lounge.i &&
            i < layout.lounge.i + layout.lounge.w &&
            j >= layout.lounge.j &&
            j < layout.lounge.j + layout.lounge.h;
          const even = (i + j) % 2 === 0;
          let fill = even ? palette.tileA : palette.tileB;
          if (inMeeting) fill = even ? palette.meetA : palette.meetB;
          if (inLounge) fill = even ? palette.rugA : palette.rugB;
          polygon(diamond(pt(i, j)), fill, palette.tileStroke, 0.6);
        }
      }

      // Back walls always hug the far edges of the rotated plan, so rotating
      // never hides the office behind a front wall.
      const corners = [
        pt(-0.5, -0.5),
        pt(layout.width - 0.5, -0.5),
        pt(layout.width - 0.5, layout.height - 0.5),
        pt(-0.5, layout.height - 0.5),
      ];
      const top = corners.reduce((best, corner) =>
        corner.y < best.y ? corner : best,
      );
      const bottom = corners.reduce((best, corner) =>
        corner.y > best.y ? corner : best,
      );
      const left = corners.reduce((best, corner) =>
        corner.x < best.x ? corner : best,
      );
      const right = corners.reduce((best, corner) =>
        corner.x > best.x ? corner : best,
      );

      const wall = (from: Point, to: Point): void => {
        polygon(
          [
            from,
            to,
            { x: to.x, y: to.y - WALL_HEIGHT },
            { x: from.x, y: from.y - WALL_HEIGHT },
          ],
          palette.wall,
        );
        ctx.beginPath();
        ctx.moveTo(from.x, from.y - WALL_HEIGHT);
        ctx.lineTo(to.x, to.y - WALL_HEIGHT);
        ctx.strokeStyle = palette.wallTop;
        ctx.lineWidth = 2;
        ctx.stroke();
      };
      wall(left, top);
      wall(top, right);

      const items: DrawItem[] = [];
      const add = (depth: number, paint: () => void): void => {
        items.push({ depth, paint });
      };

      const glass = (from: Vec2, to: Vec2): void => {
        const a = pt(from[0], from[1]);
        const b = pt(to[0], to[1]);
        polygon(
          [
            a,
            b,
            { x: b.x, y: b.y - GLASS_HEIGHT },
            { x: a.x, y: a.y - GLASS_HEIGHT },
          ],
          palette.glassFill,
          palette.glassStroke,
          1,
        );
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - GLASS_HEIGHT);
        ctx.lineTo(b.x, b.y - GLASS_HEIGHT);
        ctx.strokeStyle = palette.glassTop;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      };
      for (const [from, to] of layout.glass) {
        add(depthOf(from[0], from[1]) + depthOf(to[0], to[1]) + 1, () =>
          glass(from, to),
        );
      }

      const desk = (center: Point, active: boolean): void => {
        polygon(
          [
            { x: center.x - 20, y: center.y + 4 },
            { x: center.x + 20, y: center.y + 4 },
            { x: center.x + 20, y: center.y + 12 },
            { x: center.x - 20, y: center.y + 12 },
          ],
          palette.deskBase,
        );
        polygon(
          diamond(center, TW * 0.82, TH * 0.82),
          palette.deskTop,
          palette.deskStroke,
          1,
        );
        polygon(
          diamond({ x: center.x, y: center.y - 2 }, TW * 0.7, TH * 0.6),
          palette.deskTop2,
        );

        roundedRect(
          center.x - 11,
          center.y - 26,
          22,
          15,
          2,
          palette.monitor,
        );
        roundedRect(
          center.x - 9,
          center.y - 24,
          18,
          11,
          1,
          active ? palette.screen : palette.screenOff,
        );
        if (active) {
          const lines: [number, number, number][] = [
            [-7, -22, 7],
            [-7, -19, 10],
            [-7, -16, 5],
          ];
          for (const [dx, dy, lineWidth] of lines) {
            ctx.fillStyle = palette.scrLine;
            ctx.fillRect(center.x + dx, center.y + dy, lineWidth, 1.6);
          }
        }
        ctx.fillStyle = palette.monitor;
        ctx.fillRect(center.x - 2, center.y - 11, 4, 3);
        ellipse(
          center.x + 14,
          center.y - 22,
          2.6,
          2.6,
          active ? palette.lampWork : palette.lampFree,
        );
        roundedRect(
          center.x - 7,
          center.y - 7,
          14,
          4,
          1.5,
          palette.kb,
          palette.kbStroke,
          0.5,
        );
      };

      const chair = (center: Point): void => {
        ellipse(center.x, center.y + 3, 9, 5, palette.chairBase);
        roundedRect(center.x - 7, center.y - 8, 14, 9, 3, palette.chair);
      };

      const sofa = (center: Point): void => {
        ellipse(center.x, center.y + 8, 34, 12, palette.sofa3);
        roundedRect(center.x - 30, center.y - 16, 60, 18, 8, palette.sofa1);
        roundedRect(center.x - 30, center.y - 6, 60, 12, 6, palette.sofa2);
        ctx.beginPath();
        ctx.moveTo(center.x, center.y - 14);
        ctx.lineTo(center.x, center.y + 4);
        ctx.strokeStyle = palette.sofaLine;
        ctx.lineWidth = 2;
        ctx.stroke();
      };

      const plant = (center: Point): void => {
        polygon(
          [
            { x: center.x - 7, y: center.y + 2 },
            { x: center.x + 7, y: center.y + 2 },
            { x: center.x + 5, y: center.y + 12 },
            { x: center.x - 5, y: center.y + 12 },
          ],
          palette.pot,
        );
        const leaves: [string, number, number, number][] = [
          [palette.plantA, -8, -16, 0.9],
          [palette.plantB, 0, -22, 1.1],
          [palette.plantC, 8, -14, 0.8],
        ];
        for (const [color, dx, dy, size] of leaves) {
          ellipse(
            center.x + dx,
            center.y + dy,
            6 * size,
            11 * size,
            color,
            (dx * 2 * Math.PI) / 180,
          );
        }
      };

      const rack = (center: Point): void => {
        polygon(
          [
            { x: center.x - 14, y: center.y + 6 },
            { x: center.x + 14, y: center.y + 6 },
            { x: center.x + 14, y: center.y + 12 },
            { x: center.x - 14, y: center.y + 12 },
          ],
          palette.rackStroke,
        );
        roundedRect(
          center.x - 14,
          center.y - 42,
          28,
          48,
          3,
          palette.rack,
          palette.rackStroke,
          1,
        );
        for (let slot = 0; slot < 4; slot += 1) {
          roundedRect(
            center.x - 10,
            center.y - 36 + slot * 10,
            20,
            5,
            1,
            palette.rackSlot,
          );
        }
        ellipse(center.x + 8, center.y - 38, 2, 2, palette.rackLed);
        ctx.fillStyle = palette.rackLabel;
        ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("vps-01", center.x, center.y + 22);
      };

      const meetingTable = (center: Point): void => {
        ctx.fillStyle = palette.deskBase;
        ctx.fillRect(center.x - 4, center.y - 2, 8, 14);
        ellipse(
          center.x,
          center.y - 4,
          46,
          22,
          palette.table,
        );
        ctx.beginPath();
        ctx.ellipse(center.x, center.y - 4, 46, 22, 0, 0, Math.PI * 2);
        ctx.strokeStyle = palette.tableStroke;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ellipse(center.x, center.y - 6, 38, 17, palette.table2);
        const laptops: [number, number][] = [
          [-18, -8],
          [16, -12],
          [2, 4],
        ];
        for (const [dx, dy] of laptops) {
          roundedRect(
            center.x + dx - 6,
            center.y + dy - 4,
            12,
            8,
            1,
            palette.laptop,
          );
          roundedRect(
            center.x + dx - 5,
            center.y + dy - 3,
            10,
            6,
            0.5,
            palette.laptopScreen,
          );
        }
      };

      const agent = (
        center: Point,
        placed: PlacedAgent,
        speaking: boolean,
      ): void => {
        ellipse(center.x, center.y + 4, 11, 4.5, palette.shadow);

        if (speaking) {
          ctx.beginPath();
          ctx.ellipse(center.x, center.y + 4, 16, 7, 0, 0, Math.PI * 2);
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = palette.spk;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.setLineDash([]);
        }

        roundedRect(
          center.x - 8,
          center.y - 18,
          16,
          20,
          6,
          placed.color,
        );
        if (placed.duty === "desk" || placed.duty === "review") {
          roundedRect(
            center.x - 9,
            center.y - 12,
            5,
            8,
            2,
            placed.color,
          );
          roundedRect(
            center.x + 4,
            center.y - 12,
            5,
            8,
            2,
            placed.color,
          );
        }

        ctx.beginPath();
        ctx.arc(center.x, center.y - 24, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = "#e8c9a8";
        ctx.fill();
        ctx.strokeStyle = "#d3ad84";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(center.x, center.y - 24, 7.5, Math.PI, Math.PI * 2);
        ctx.fillStyle = "#4a3b2c";
        ctx.fill();

        roundedRect(
          center.x - 22,
          center.y + 8,
          44,
          13,
          6.5,
          palette.tagFill,
          palette.tagStroke,
          0.8,
        );
        ctx.fillStyle = palette.tagInk;
        ctx.font =
          '700 9px "Avenir Next", "Trebuchet MS", system-ui, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(placed.label, center.x, center.y + 15);
      };

      const placement = placeAgents(snapshot.agents ?? [], layout);

      layout.desks.forEach(([i, j], index) => {
        const active = placement.occupiedDesks.has(index);
        add(depthOf(i, j) + 0.2, () => desk(pt(i, j), active));
        add(depthOf(i, j + 0.75) + 0.1, () =>
          chair(pt(i, j + 0.75)),
        );
      });

      add(depthOf(layout.sofa[0], layout.sofa[1]) + 0.3, () =>
        sofa(pt(layout.sofa[0], layout.sofa[1])),
      );
      for (const [i, j] of layout.plants) {
        add(depthOf(i, j) + 0.3, () => plant(pt(i, j)));
      }
      add(depthOf(layout.rack[0], layout.rack[1]) + 0.25, () =>
        rack(pt(layout.rack[0], layout.rack[1])),
      );
      add(
        depthOf(layout.meetingTable[0], layout.meetingTable[1]) + 0.3,
        () => meetingTable(pt(layout.meetingTable[0], layout.meetingTable[1])),
      );

      items.sort((a, b) => a.depth - b.depth);
      for (const item of items) item.paint();

      const sortedAgents = [...placement.agents].sort(
        (a, b) => depthOf(a.i, a.j) - depthOf(b.i, b.j),
      );
      frame = {
        width,
        height,
        scale,
        sceneX,
        sceneY,
        panX: viewport.panX,
        panY: viewport.panY,
        agents: sortedAgents.map((entry) => {
          const point = pt(entry.i, entry.j);
          return { id: entry.id, x: point.x, y: point.y };
        }),
      };
      const speaker = sortedAgents.find((entry) => entry.duty === "meeting");
      for (const entry of sortedAgents) {
        agent(pt(entry.i, entry.j), entry, entry === speaker);
      }

      // Front skirt faces are drawn last so they sit over the floor edge.
      polygon(
        [
          left,
          bottom,
          { x: bottom.x, y: bottom.y + SKIRT_HEIGHT },
          { x: left.x, y: left.y + SKIRT_HEIGHT },
        ],
        palette.skirtA,
      );
      polygon(
        [
          bottom,
          right,
          { x: right.x, y: right.y + SKIRT_HEIGHT },
          { x: bottom.x, y: bottom.y + SKIRT_HEIGHT },
        ],
        palette.skirtB,
      );

      ctx.restore();
    },

    hitTest(x: number, y: number): string | null {
      if (frame === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      // Undo the CSS-space pan/scale so the point lives in projected scene
      // coordinates, matching where each agent sprite was painted.
      const scenePointX =
        (x - frame.width / 2 - frame.panX) / frame.scale + frame.sceneX;
      const scenePointY =
        (y - frame.height / 2 - frame.panY) / frame.scale + frame.sceneY;

      for (let index = frame.agents.length - 1; index >= 0; index -= 1) {
        const candidate = frame.agents[index];
        if (
          scenePointX >= candidate.x - 26 &&
          scenePointX <= candidate.x + 26 &&
          scenePointY >= candidate.y - 34 &&
          scenePointY <= candidate.y + 22
        ) {
          return candidate.id;
        }
      }

      return null;
    },
  };
}
