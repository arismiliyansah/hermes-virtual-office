export type Vec2 = readonly [i: number, j: number];

export interface RoomRect {
  i: number;
  j: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  /** Desk centres: six hot desks stocked for the office. */
  desks: readonly Vec2[];
  /** Meeting room covers i 7..11 and j 0..3. */
  meetingRoom: RoomRect;
  /** Lounge rug covers i 0..2 and j 6..8. */
  lounge: RoomRect;
  /** Glass divider segments; the gap between x = 8.5 and 10.5 is the door. */
  glass: readonly (readonly [Vec2, Vec2])[];
  rack: Vec2;
  plants: readonly Vec2[];
  sofa: Vec2;
  meetingTable: Vec2;
  /** Route an A2A agent walks between its desk and the meeting room. */
  MEET_PATH: readonly Vec2[];
}

export const LAYOUT: Layout = {
  width: 12,
  height: 9,
  desks: [
    [2, 2],
    [4, 2],
    [6, 2],
    [2, 4],
    [4, 4],
    [6, 4],
  ],
  meetingRoom: { i: 7, j: 0, w: 5, h: 4 },
  lounge: { i: 0, j: 6, w: 3, h: 3 },
  glass: [
    [
      [6.5, 3.5],
      [8.5, 3.5],
    ],
    [
      [10.5, 3.5],
      [11.5, 3.5],
    ],
    [
      [6.5, -0.5],
      [6.5, 0.5],
    ],
    [
      [6.5, 2.5],
      [6.5, 3.5],
    ],
  ],
  rack: [1, 0.4],
  plants: [
    [0.4, 1.2],
    [10.8, 4.6],
  ],
  sofa: [1, 7],
  meetingTable: [9, 1.6],
  MEET_PATH: [
    [6, 4],
    [7, 3.6],
    [7.6, 3],
    [7.6, 2.2],
    [7, 1.8],
    [6.6, 1.7],
  ],
};
