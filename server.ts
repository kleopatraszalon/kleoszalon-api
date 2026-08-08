// Compatibility entrypoint for hosting configurations that still start `server.ts` from the repository root.
// The canonical application lives in src/server.ts and is also the entrypoint compiled to dist/server.js.
// Keeping only one server implementation prevents Render/manual start commands from serving an outdated API surface.
import "./src/server";
