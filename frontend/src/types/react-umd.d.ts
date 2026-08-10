/** Virtual modules synthesised by the ``reactUmdRuntime`` Vite plugin
 *  (see ``vite.config.ts``). Each exports React's UMD bundle as a string so
 *  the React artifact preview can inline a runtime into its sandboxed
 *  iframe — which has no same-origin access and therefore can't fetch one. */
declare module "virtual:react-umd/react" {
  const source: string;
  export default source;
}
declare module "virtual:react-umd/react-dom" {
  const source: string;
  export default source;
}
