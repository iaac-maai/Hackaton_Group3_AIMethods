import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./pose/harness";
import "@fontsource/michroma/400.css";
import "@fontsource/jost/300.css";
import "@fontsource/jost/400.css";
import "@fontsource/jost/500.css";
import "./styles.css";
import "./styles/visuals.css";
import "./components/planner/planner.css";
import "./styles/motion.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
