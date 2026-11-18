export interface Point {
  x: number;
  y: number;
}

export interface ProjectionOptions {
  tw: number;
  th: number;
  ox: number;
  oy: number;
}

export const TW = 58;
export const TH = 29;
export const OX = 470;
export const OY = 88;

export const DEFAULT_PROJECTION: ProjectionOptions = {
  tw: TW,
  th: TH,
  ox: OX,
  oy: OY,
};

/** Isometric projection straight from the mockup: x = ox + (i - j) * tw / 2, y = oy + (i + j) * th / 2. */
export function project(
  i: number,
  j: number,
  options: ProjectionOptions = DEFAULT_PROJECTION,
): Point {
  return {
    x: options.ox + ((i - j) * options.tw) / 2,
    y: options.oy + ((i + j) * options.th) / 2,
  };
}

/** Diamond corners ordered top, right, bottom, left. */
export function diamond(
  center: Point,
  width: number = TW,
  height: number = TH,
): Point[] {
  return [
    { x: center.x, y: center.y - height / 2 },
    { x: center.x + width / 2, y: center.y },
    { x: center.x, y: center.y + height / 2 },
    { x: center.x - width / 2, y: center.y },
  ];
}
