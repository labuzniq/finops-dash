/**
 * Hover readout for the line charts.
 *
 * The geometry builders precompute one entry per data point — position as
 * viewbox percentages, values preformatted — so the render layer only has to
 * pick the nearest index under the pointer. No formatting or scale maths
 * happens at hover time.
 */

export interface HoverSeries {
  label: string;
  /** Preformatted display value — the tooltip never formats. */
  value: string;
  /** CSS color for the tooltip line key and the marker dot. */
  color: string;
  /** Marker offset from the plot top, as a percentage of the viewbox height. */
  yPercent: number;
}

export interface ChartHoverPoint {
  /** Offset from the plot left edge, as a percentage of the viewbox width. */
  xPercent: number;
  dateLabel: string;
  series: HoverSeries[];
}
