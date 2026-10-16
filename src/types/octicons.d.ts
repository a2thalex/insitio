declare module "@primer/octicons" {
  type Octicon = { toSVG(opts?: { width?: number; height?: number; class?: string; "aria-label"?: string }): string };
  const octicons: Record<string, Octicon>;
  export default octicons;
}
