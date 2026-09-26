// P3 task 3: the lazy-loaded excalidraw editor imports its stylesheet from
// src/assets (portal injects /themes/excalidraw/excalidraw.css; desktop
// bundles it — R21). Vite handles *.css imports at build time; this
// declaration just teaches TypeScript about them (the repo has no
// vite/client types reference).
declare module '*.css';