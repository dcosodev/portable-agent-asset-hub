declare module 'cytoscape-fcose' {
  import type Cytoscape from 'cytoscape';
  const register: (cy: typeof Cytoscape) => void;
  export default register;
}
