export interface HighlightTheme {
  point: {
    color: [number, number, number, number];
    size: number;
    outlineColor: [number, number, number, number];
    outlineWidth: number;
  };
  polyline: {
    color: [number, number, number, number];
    width: number;
  };
  polygon: {
    fillColor: [number, number, number, number];
    outlineColor: [number, number, number, number];
    outlineWidth: number;
  };
}

export const highlightTheme: HighlightTheme = {
  point: {
    color: [255, 120, 0, 0.92],
    size: 10,
    outlineColor: [255, 255, 255, 1],
    outlineWidth: 1.6
  },
  polyline: {
    color: [255, 108, 0, 0.95],
    width: 3.2
  },
  polygon: {
    fillColor: [255, 140, 0, 0.18],
    outlineColor: [255, 108, 0, 1],
    outlineWidth: 2
  }
};
